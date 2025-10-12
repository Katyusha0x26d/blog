---
title: 深入理解JVM内存管理与垃圾回收
categories: Java
tags:
    - JVM
    - 垃圾回收
    - HotSpot
date: 2025-08-18 09:20:00 +0800
updated: 2025-08-18 09:20:00 +0800
---

关于JVM的内存模型和GC机制这类底层原理和细节，如果不深入理解，永远不是一个合格的程序员

Java八股中，对GC的理解停留在"标记-清除"、"复制算法"这些概念层面。但生产环境的问题往往更复杂：为什么年轻代用复制算法老年代用标记-整理？卡表（Card Table）到底解决了什么问题？G1的Region是如何管理的？

这篇文章会从JVM规范到Hotspot源码，深入剖析内存管理的每个细节

<!-- more -->

## 运行时数据区

JVM规范定义了运行时数据区的逻辑划分，但具体实现由各个JVM厂商决定。我们以Hotspot（Oracle JDK的默认实现）为例

### 程序计数器（Program Counter Register）

**作用**：记录当前线程正在执行的字节码指令地址

```
public void test() {
    int a = 1;    // PC = 0: iconst_1
    int b = 2;    // PC = 2: iconst_2
    int c = a + b; // PC = 4: iadd
}
```

**特性**：
- 线程私有，每个线程独立的PC
- 唯一不会发生OutOfMemoryError的区域
- 执行Native方法时，PC值为undefined

在Hotspot源码中，程序计数器对应`JavaThread`对象的`_pc`字段（`thread.hpp`）：

```cpp
class JavaThread: public Thread {
  private:
    address _last_Java_pc;  // 上一个Java栈帧的PC
    // ...
};
```

### Java虚拟机栈（JVM Stacks）

**作用**：存储方法调用的局部变量、操作数栈、动态链接、返回地址

每次方法调用都会创建一个栈帧（Stack Frame）：

```
┌─────────────────────────┐ ← 栈顶（当前执行的方法）
│  局部变量表              │
│  操作数栈               │
│  动态链接               │
│  方法返回地址           │
├─────────────────────────┤
│  调用者的栈帧           │
├─────────────────────────┤
│  ...                   │
└─────────────────────────┘ ← 栈底
```

**局部变量表**的大小在编译期确定，存储：
- 基本数据类型（8种）
- 对象引用（reference类型，不是对象本身）
- returnAddress类型（指向字节码指令地址）

:::tip

`long`和`double`占用两个局部变量槽（Slot），其他类型占一个。这就是为什么局部变量表的大小单位是Slot而不是字节

:::

Hotspot中栈帧的实现（`frame.hpp`）：

```cpp
class frame {
  private:
    intptr_t* _sp;  // 栈指针
    address   _pc;  // 程序计数器
    intptr_t* _fp;  // 帧指针

    // 局部变量表访问
    oop obj_at(int offset) const {
        return *oop_addr_at(offset);
    }

    // 操作数栈访问
    intptr_t* interpreter_frame_expression_stack() const;
};
```

**异常情况**：
- `StackOverflowError`：线程请求的栈深度超过允许的最大深度（递归太深）
- `OutOfMemoryError`：动态扩展时无法申请到足够内存

### 本地方法栈（Native Method Stacks）

与虚拟机栈类似，但为Native方法服务。Hotspot直接把本地方法栈和虚拟机栈合并实现了

### 堆（Heap）

**作用**：存储所有对象实例和数组

堆是GC管理的主要区域，现代JVM普遍采用**分代收集**理论，将堆分为：

```
┌────────────────────────────────────────┐
│           Young Generation              │
│  ┌──────┬──────────┬──────────┐        │
│  │ Eden │ Survivor │ Survivor │        │
│  │      │    0     │    1     │        │
│  └──────┴──────────┴──────────┘        │
├────────────────────────────────────────┤
│           Old Generation                │
│  (Tenured Generation)                  │
└────────────────────────────────────────┘
```

**为什么要分代？**

基于两个经验性的假说（《深入理解Java虚拟机》中的"分代假说"）：

1. **弱分代假说**：绝大多数对象都是朝生夕死
2. **强分代假说**：熬过多次GC的对象越难消亡

IBM研究表明，98%的对象在创建后很快就死亡。分代设计让GC集中精力处理年轻代，提高效率

**新生代的三区结构**：

- **Eden区**：新对象分配的地方（默认占80%）
- **Survivor区**：Minor GC后存活对象的中转站（各占10%）

分配流程：

```
1. 对象在Eden分配
2. Eden满了触发Minor GC
3. 存活对象复制到Survivor0
4. 下次GC时，Eden + Survivor0的存活对象复制到Survivor1
5. 反复几次后（默认15次），晋升到老年代
```

Hotspot源码中堆的定义（`collectedHeap.hpp`）：

```cpp
class CollectedHeap : public CHeapObj<mtInternal> {
  protected:
    MemRegion _reserved;  // 保留的内存区域

  public:
    virtual HeapWord* mem_allocate(size_t size,
                                   bool* gc_overhead_limit_was_exceeded) = 0;

    // 对象分配的快速路径（内联在生成的代码中）
    virtual HeapWord* allocate_new_tlab(size_t size);

    // 执行垃圾回收
    virtual void collect(GCCause::Cause cause) = 0;
};
```

### 方法区（Method Area）

**作用**：存储类信息、常量、静态变量、即时编译后的代码缓存

JDK 7之前叫"永久代"（PermGen），JDK 8开始改为"元空间"（Metaspace），使用本地内存

**为什么要去掉永久代？**

1. 永久代大小难以确定（`-XX:MaxPermSize`），容易OOM
2. GC效率低，Full GC时才回收
3. 不同JVM实现差异大，元空间更统一

**存储内容**：

```cpp
// instanceKlass.hpp - 类的元数据表示
class InstanceKlass: public Klass {
  private:
    // 类的结构信息
    int _vtable_len;              // 虚方法表长度
    int _itable_len;              // 接口方法表长度
    Array<Method*>* _methods;     // 方法列表
    Array<u2>* _fields;           // 字段列表
    ConstantPool* _constants;     // 常量池
    // ...
};
```

**运行时常量池**：

Class文件中的常量池表在类加载后进入方法区的运行时常量池。注意`String.intern()`的行为：

- JDK 6：在永久代创建String对象的副本
- JDK 7+：在堆中创建，常量池只存引用

```java
String s1 = new String("abc");  // 堆中创建对象
String s2 = s1.intern();        // JDK 7+: 返回堆中对象的引用
System.out.println(s1 == s2);   // JDK 6: false, JDK 7+: true
```

## 对象的内存布局

理解对象在内存中的结构，对分析内存占用和GC行为至关重要

### 对象头（Object Header）

Hotspot的对象头包含两部分信息：

```
┌──────────────────────────────────────┐
│         Mark Word (8字节)             │  ← 哈希码、GC分代年龄、锁标志位
├──────────────────────────────────────┤
│      类型指针 (4/8字节)               │  ← 指向类元数据的指针
├──────────────────────────────────────┤
│  数组长度 (4字节, 仅数组对象有)       │
└──────────────────────────────────────┘
```

**Mark Word**在不同状态下存储不同信息（64位JVM）：

```
未锁定:
├───────────────────────────┬───┬───┬────┐
│ unused (25位) │ hashcode │ age │ 0 │ 01 │
└───────────────────────────┴───┴───┴────┘

轻量级锁:
├─────────────────────────────────┬────┐
│   指向栈中锁记录的指针          │ 00 │
└─────────────────────────────────┴────┘

重量级锁:
├─────────────────────────────────┬────┐
│   指向互斥量(重量级锁)的指针     │ 10 │
└─────────────────────────────────┴────┘

GC标记:
├─────────────────────────────────┬────┐
│            空                   │ 11 │
└─────────────────────────────────┴────┘
```

源码定义（`markOop.hpp`）：

```cpp
class markOopDesc: public oopDesc {
  private:
    uintptr_t _value;

  public:
    // 位操作获取不同字段
    uintptr_t hash() const {
        return mask_bits(value() >> hash_shift, hash_mask);
    }

    uint age() const {
        return mask_bits(value() >> age_shift, age_mask);
    }

    JavaThread* locker() const {
        return (JavaThread*)((value() & ~lock_mask_in_place));
    }
};
```

:::warning

开启指针压缩（`-XX:+UseCompressedOops`，默认开启）时，类型指针只占4字节。这对32GB以下堆的内存节省显著

:::

### 实例数据和对齐填充

```java
class User {
    private int id;        // 4字节
    private String name;   // 4字节（引用）
    private boolean flag;  // 1字节
}
```

内存布局（开启指针压缩）：

```
┌─────────────────┐
│ Mark Word (8B)  │
├─────────────────┤
│ 类型指针 (4B)   │
├─────────────────┤
│ id (4B)         │
├─────────────────┤
│ name引用 (4B)   │
├─────────────────┤
│ flag (1B)       │
├─────────────────┤
│ padding (3B)    │  ← 对齐到8字节倍数
└─────────────────┘
总计: 24字节
```

可以用JOL（Java Object Layout）工具验证：

```java
User user = new User();
System.out.println(ClassLayout.parseInstance(user).toPrintable());

// 输出:
//  OFFSET  SIZE               TYPE DESCRIPTION
//       0    12                    (object header)
//      12     4                int User.id
//      16     4   java.lang.String User.name
//      20     1            boolean User.flag
//      21     3                    (loss due to alignment)
```

## 垃圾回收的理论基础

### 如何判断对象已死？

**引用计数法**（简单但有缺陷）：

```java
class A {
    B b;
}
class B {
    A a;
}

A a = new A();
B b = new B();
a.b = b;
b.a = a;

a = null;
b = null;
// 两个对象互相引用，引用计数永远不为0，无法回收
```

**可达性分析算法**（主流JVM采用）：

以"GC Roots"为起点，向下搜索形成"引用链"。不可达的对象可以被回收

```
GC Roots
   ├─→ 对象A ─→ 对象B
   │
   └─→ 对象C ─→ 对象D

独立存在的对象E（无法从GC Roots到达） ← 可回收
```

**哪些对象可以作为GC Roots？**

- 虚拟机栈（局部变量表）中引用的对象
- 方法区中类静态属性引用的对象
- 方法区中常量引用的对象
- 本地方法栈中JNI引用的对象
- 活跃线程的引用

Hotspot的GC Roots枚举实现关键在于**OopMap**（`oopMap.hpp`）：

```cpp
class OopMap {
  private:
    OopMapValue* _omv_data;  // 记录栈上哪些位置是对象引用

  public:
    // 遍历所有引用
    void iterate_oop(OopClosure* blk);
};
```

JIT编译器在特定位置（称为安全点Safepoint）记录OopMap，GC时不需要扫描整个栈，直接查OopMap即可

### 四种引用类型

```java
// 1. 强引用（Strong Reference）- 永远不会被回收
Object obj = new Object();

// 2. 软引用（Soft Reference）- 内存不足时回收
SoftReference<byte[]> soft = new SoftReference<>(new byte[1024 * 1024]);

// 3. 弱引用（Weak Reference）- 下次GC时回收
WeakReference<User> weak = new WeakReference<>(new User());

// 4. 虚引用（Phantom Reference）- 无法通过引用获取对象，用于回收通知
ReferenceQueue<Object> queue = new ReferenceQueue<>();
PhantomReference<Object> phantom = new PhantomReference<>(obj, queue);
```

源码实现（`referenceProcessor.cpp`）：

```cpp
void ReferenceProcessor::process_discovered_references(
    ReferencePolicy* policy,
    BoolObjectClosure* is_alive,
    OopClosure* keep_alive,
    VoidClosure* complete_gc) {

    // 1. 处理软引用
    process_soft_references(policy, is_alive, keep_alive, complete_gc);

    // 2. 处理弱引用
    process_weak_references(is_alive, keep_alive, complete_gc);

    // 3. 处理虚引用和Finalizer
    process_final_references(is_alive, keep_alive, complete_gc);
    process_phantom_references(is_alive, keep_alive, complete_gc);
}
```

## 垃圾回收算法的演进

### 标记-清除

**流程**：
1. 标记：遍历所有可达对象，打标记
2. 清除：遍历堆，回收未标记对象

**缺点**：产生大量不连续的内存碎片

```
回收前: [A][B][C][D][E]
回收后: [A][_][C][_][E]  ← 碎片
```

### 标记-复制

**流程**：
1. 将内存分为两半（From区和To区）
2. 标记From区的存活对象
3. 复制存活对象到To区
4. 清空From区，交换From和To

**优点**：没有碎片，分配快（指针碰撞）
**缺点**：可用内存减半

新生代采用改进版：Eden : Survivor0 : Survivor1 = 8 : 1 : 1，可用内存达到90%

Hotspot实现（`defNewGeneration.cpp`）：

```cpp
void DefNewGeneration::collect(bool full, bool clear_all_soft_refs,
                                size_t size, bool is_tlab) {
    // 保存old gen的对象指针（用于处理跨代引用）
    save_marks();

    // 清空To区
    to()->clear(SpaceDecorator::Mangle);

    // 复制Eden和From区的存活对象到To区
    FastScanClosure fsc(this, true);
    evacuate_followers(&fsc);

    // 交换From和To
    swap_spaces();
}
```

### 标记-整理

**流程**：
1. 标记存活对象
2. 将所有存活对象向一端移动
3. 清理端边界以外的内存

**优点**：无碎片，不浪费空间
**缺点**：整理阶段移动对象成本高

老年代采用此算法，因为对象存活率高，复制成本太大

```cpp
// parallelCompact.cpp - Parallel Old GC的实现
void PSParallelCompact::invoke(bool maximum_heap_compaction) {
    // 阶段1: 标记存活对象
    marking_phase();

    // 阶段2: 计算对象新地址
    summary_phase();

    // 阶段3: 移动对象
    compact_perm();
    compact();
}
```

## 经典垃圾回收器详解

### Serial收集器

```
-XX:+UseSerialGC
```

**特点**：
- 单线程，GC时必须暂停所有工作线程（Stop The World）
- 新生代用复制算法，老年代用标记-整理

```
CPU1: [应用线程] ──→ STW ──→ [GC线程] ──→ [应用线程]
CPU2: [应用线程] ──→ STW ──→     闲置    ──→ [应用线程]
```

适用场景：Client模式、小内存应用（几十MB到一两百MB）

### Parallel Scavenge

```
-XX:+UseParallelGC
-XX:+UseParallelOldGC
```

**特点**：
- 多线程并行收集
- 关注吞吐量（运行代码时间 / 总时间）
- 提供自适应调节策略（`-XX:+UseAdaptiveSizePolicy`）

```cpp
// psScavenge.cpp - 新生代并行收集
void PSScavenge::invoke() {
    ParallelScavengeHeap* heap = ParallelScavengeHeap::heap();

    // 创建多个GC线程
    PSPromotionManager::pre_scavenge();

    // 并行处理GC Roots
    ParallelScavengeHeap::StrongRootsScope srs;
    scavenge_roots_tasks.enqueue(...);

    // 工作线程池执行任务
    workers->run_task(&scavenge_roots_tasks);
}
```

**吞吐量 vs 停顿时间**：

- 高吞吐量：适合后台计算任务（批处理）
- 低停顿：适合交互式应用（Web服务）

### CMS

```
-XX:+UseConcMarkSweepGC
```

**设计目标**：获取最短停顿时间

**四个阶段**：

1. **初始标记**（STW）：标记GC Roots直接关联的对象
2. **并发标记**：从GC Roots遍历整个对象图（与应用并发）
3. **重新标记**（STW）：修正并发期间变化的对象
4. **并发清除**：清理死亡对象（与应用并发）

```
用户线程: ───┐ STW ├───── 运行 ─────┐ STW ├───── 运行 ─────
GC线程:        初标      并发标记        重标      并发清除
```

**关键技术：三色标记法**

- **白色**：未被标记的对象
- **灰色**：已标记但子对象未扫描完
- **黑色**：已标记且子对象已扫描完

并发标记时可能出现"对象消失"问题：

```java
// 初始状态：A(黑) → B(灰) → C(白)
A.ref = C;      // A引用C
B.ref = null;   // B不再引用C
// 结果：C本该存活，但标记阶段被漏标成白色
```

解决方案：**增量更新**（Incremental Update）

```cpp
// concurrentMarkSweepGeneration.cpp
void CMSCollector::checkpointRootsInitial() {
    // 记录并发标记期间的引用变化
    _mark_word_saved = java_lang_Class::klass_oop(k)->mark();

    // 使用写屏障（Write Barrier）追踪引用变化
    BarrierSet* bs = Universe::heap()->barrier_set();
    bs->write_ref_field(...);
}
```

**CMS的缺陷**：

1. **CPU资源敏感**：并发阶段占用CPU导致应用变慢
2. **浮动垃圾**：并发清除期间产生的垃圾要等下次GC
3. **内存碎片**：标记-清除算法的通病

JDK 9标记为deprecated，JDK 14完全移除

### G1GC

```
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
```

**划时代的设计**：

1. 不再区分新生代老年代的固定布局
2. 将堆分为多个大小相等的Region（1-32MB）
3. 每个Region可以是Eden、Survivor或Old
4. 优先回收价值最大的Region（Garbage First）

```
┌─────┬─────┬─────┬─────┬─────┬─────┐
│ E   │ S   │ O   │ O   │ E   │ H   │  E=Eden, S=Survivor
├─────┼─────┼─────┼─────┼─────┼─────┤  O=Old, H=Humongous
│ O   │ E   │ E   │ O   │ S   │ E   │
└─────┴─────┴─────┴─────┴─────┴─────┘
```

**关键技术：Remembered Set（记忆集）**

问题：跨Region引用如何处理？如果每次GC都扫描整个堆，就失去了分Region的意义

解决：每个Region维护一个RSet，记录其他Region到本Region的引用

```cpp
// g1RemSet.hpp
class G1RemSet: public CHeapObj<mtGC> {
  private:
    G1CollectedHeap* _g1;
    CardTableModRefBS* _ct_bs;

  public:
    // 更新RSet（通过写屏障触发）
    void refine_card(jbyte* card_ptr, uint worker_i);

    // GC时扫描RSet
    void oops_into_collection_set_do(...);
};
```

**写屏障（Write Barrier）实现**：

JIT编译器在对象引用更新时插入额外代码：

```
// 用户代码: obj.field = value;

// 实际执行:
obj.field = value;
if (value != null && is_in_different_region(obj, value)) {
    post_write_barrier(obj);  // 更新RSet
}
```

**G1的GC模式**：

1. **Young GC**：只回收Eden和Survivor Region
2. **Mixed GC**：回收所有Young Region + 部分Old Region
3. **Full GC**：退化为Serial Old（最慢，应避免）

```cpp
// g1CollectedHeap.cpp
void G1CollectedHeap::do_collection_pause_at_safepoint(double target_pause_time_ms) {
    // 1. 选择回收集合（Collection Set）
    _collection_set->finalize_young_part(target_pause_time_ms);
    _collection_set->finalize_old_part();

    // 2. 并行回收
    evacuate_collection_set();

    // 3. 更新引用
    reference_processor()->process_discovered_references();
}
```

**自适应的停顿预测模型**：

G1通过历史数据预测每个Region的回收时间和价值：

```cpp
double G1Analytics::predict_region_elapsed_time_ms(HeapRegion* hr, bool for_young_gc) {
    double prediction = get_new_prediction(_rs_length_diff_seq);
    prediction += get_new_prediction(_cost_per_byte_ms_seq) * hr->used();
    return prediction;
}
```

## ZGC

```
-XX:+UseZGC
```

JDK 11引入的实验性GC，JDK 15转正

**目标**：
- 停顿时间不超过10ms
- 支持TB级堆
- 停顿时间不随堆大小增加

**核心技术：染色指针（Colored Pointers）**

在64位指针中挤出几个bit存储标记信息：

```
┌─────────────────────────────────────────────────┐
│ unused │ Finalizable │ Remapped │ Marked1 │ Marked0 │ 对象地址 (44位) │
└─────────────────────────────────────────────────┘
  18位         1位         1位        1位       1位           44位
```

这样标记操作不需要访问对象本身，只修改指针即可！

**读屏障（Load Barrier）**：

访问对象时，JIT生成的代码会检查指针的标记位：

```
// 用户代码: obj.field
// 实际执行:
oop result = obj.field;
if (is_bad_color(result)) {
    result = slow_path(result);  // 可能触发重定位
}
return result;
```

ZGC的并发过程：

1. **并发标记**：使用读屏障，完全并发
2. **并发预备重分配**：选择要回收的Region
3. **并发重分配**：移动对象，旧对象转发到新地址
4. **并发重映射**：修正所有引用

停顿只发生在初始标记和初始重映射两个很短的阶段

## GC调优案例

### 频繁Young GC

**现象**：

```
[GC (Allocation Failure) 279M->15M(512M), 0.0234 secs]
[GC (Allocation Failure) 279M->16M(512M), 0.0198 secs]
[GC (Allocation Failure) 279M->17M(512M), 0.0256 secs]
// 每次GC回收率超过90%，但很频繁
```

**分析**：

- 回收率高说明大部分是短命对象（符合预期）
- 频繁GC说明新生代太小，Eden很快填满

**优化**：

```bash
# 增大新生代比例
-XX:NewRatio=2                    # 老年代:新生代 = 2:1
-Xmn2g                            # 或直接指定新生代大小

# 增大Eden比例
-XX:SurvivorRatio=8               # Eden:Survivor = 8:1
```

### 对象过早晋升

**现象**：

```
[GC ... 400M->350M, 0.05 secs]   # 回收率低
[Full GC ... 2048M->1800M, 2.3 secs]  # 频繁Full GC
```

**分析**：

通过`-XX:+PrintTenuringDistribution`查看年龄分布：

```
Desired survivor size 107374182 bytes, new threshold 1 (max 15)
- age   1:   89123456 bytes,   89123456 total
- age   2:    1234567 bytes,   90358023 total
```

threshold=1说明对象经过1次GC就晋升了！

**原因**：

Survivor区太小，容纳不下存活对象，触发"动态年龄判定"：

> 如果Survivor中相同年龄所有对象大小总和 > Survivor空间一半，年龄≥该年龄的对象直接晋升

**优化**：

```bash
-XX:SurvivorRatio=6               # 增大Survivor
-XX:MaxTenuringThreshold=15       # 提高晋升年龄
```

### String.intern()导致的Metaspace OOM

**代码**：

```java
while (true) {
    String s = UUID.randomUUID().toString().intern();
}
```

**现象**：

```
java.lang.OutOfMemoryError: Metaspace
```

**分析**：

JDK 7+的`intern()`在首次遇到字符串时，会在字符串常量池（位于堆中）添加引用。但大量不同的字符串会导致常量池膨胀

**优化**：

1. 去掉无意义的`intern()`调用
2. 如果确实需要，增大Metaspace：

```bash
-XX:MetaspaceSize=256m
-XX:MaxMetaspaceSize=512m
```

## GC选择指南

| 收集器 | 适用场景 | 停顿时间 | 吞吐量 |
|-------|---------|---------|--------|
| Serial | 单核CPU、小堆(< 100MB) | 长 | 中 |
| Parallel | 后台计算、对吞吐量敏感 | 中 | 高 |
| CMS | 互联网服务、对延迟敏感 | 短 | 中 |
| G1 | 大堆(> 4GB)、可预测停顿 | 短 | 中 |
| ZGC | 超大堆(> 100GB)、极低延迟 | 极短 | 中 |

**JDK版本建议**：

- JDK 8：G1或CMS
- JDK 11+：G1（默认）或ZGC
- JDK 17+：ZGC（已生产可用）

理解GC不是为了炫技，而是为了在线上出问题时能快速定位。记住：**过早优化是万恶之源，先测量，再优化**。大部分应用用默认GC参数就足够了，只有遇到瓶颈时才需要深入调优
