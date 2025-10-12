---
title: JVM类加载机制剖析
categories: Java
tags:
    - JVM
    - 类加载
    - Hotspot
date: 2025-08-16 16:30:00 +0800
updated: 2025-08-16 16:30:00 +0800
---

理解类加载机制不仅是面试八股文，更是解决实际问题的关键。Spring的AOP、Tomcat的热部署、OSGI的模块化，底层都是在玩类加载器的花样

这篇文章会从Class文件格式开始，深入到Hotspot的C++源码，完整剖析类加载的每一个细节

<!-- more -->

## Class文件

Java的"一次编译，到处运行"依赖于Class文件这个中间格式。它不是给人看的二进制文件，而是JVM的"机器码"

### Class文件结构

Class文件是一串严格定义的字节流，没有任何分隔符：

```
ClassFile {
    u4             magic;                    // 魔数 0xCAFEBABE
    u2             minor_version;            // 次版本号
    u2             major_version;            // 主版本号
    u2             constant_pool_count;      // 常量池大小
    cp_info        constant_pool[...];       // 常量池
    u2             access_flags;             // 访问标志
    u2             this_class;               // 类索引
    u2             super_class;              // 父类索引
    u2             interfaces_count;         // 接口数量
    u2             interfaces[...];          // 接口索引表
    u2             fields_count;             // 字段数量
    field_info     fields[...];              // 字段表
    u2             methods_count;            // 方法数量
    method_info    methods[...];             // 方法表
    u2             attributes_count;         // 属性数量
    attribute_info attributes[...];          // 属性表
}
```

:::tip

`u1`、`u2`、`u4`分别表示1字节、2字节、4字节的无符号整数。Class文件采用大端序（Big-Endian）存储

:::

**用hexdump看一个真实的Class文件**：

```bash
$ hexdump -C Hello.class | head -n 10
00000000  ca fe ba be 00 00 00 34  00 1d 0a 00 06 00 0f 09  |.......4........|
00000010  00 10 00 11 08 00 12 0a  00 13 00 14 07 00 15 07  |................|
00000020  00 16 01 00 06 3c 69 6e  69 74 3e 01 00 03 28 29  |.....<init>...()|
```

- `ca fe ba be`：魔数，标识这是Class文件
- `00 00 00 34`：版本号0.52（JDK 8）

### 常量池

常量池是Class文件中最复杂的部分，存储所有字面量和符号引用：

```java
public class Test {
    private int count = 100;
    public void say() {
        System.out.println("Hello");
    }
}
```

常量池会包含：

1. 字面量：`100`、`"Hello"`
2. 类和接口的全限定名：`"com/example/Test"`、`"java/lang/System"`
3. 字段的名称和描述符：`"count"`、`"I"（int类型）`
4. 方法的名称和描述符：`"say"`、`"()V"（无参数返回void）`

**常量池项的类型**：

```cpp
// hotspot/src/share/vm/utilities/constantTag.hpp
enum {
    JVM_CONSTANT_Utf8 = 1,
    JVM_CONSTANT_Integer = 3,
    JVM_CONSTANT_Float = 4,
    JVM_CONSTANT_Long = 5,
    JVM_CONSTANT_Double = 6,
    JVM_CONSTANT_Class = 7,
    JVM_CONSTANT_String = 8,
    JVM_CONSTANT_Fieldref = 9,
    JVM_CONSTANT_Methodref = 10,
    JVM_CONSTANT_InterfaceMethodref = 11,
    JVM_CONSTANT_NameAndType = 12,
    JVM_CONSTANT_MethodHandle = 15,
    JVM_CONSTANT_MethodType = 16,
    JVM_CONSTANT_InvokeDynamic = 18
};
```

可以用`javap`查看常量池：

```bash
$ javap -v Test.class

Constant pool:
   #1 = Methodref          #6.#15         // java/lang/Object."<init>":()V
   #2 = Fieldref           #16.#17        // Test.count:I
   #3 = String             #18            // Hello
   #4 = Methodref          #19.#20        // java/io/PrintStream.println:(Ljava/lang/String;)V
   ...
```

### 方法表

每个方法包含：

- 访问标志（public/private/static等）
- 名称索引（指向常量池）
- 描述符索引（方法签名）
- 属性表（包含Code属性，存储字节码）

```java
public int add(int a, int b) {
    return a + b;
}
```

对应的字节码：

```
Code:
  stack=2, locals=3, args_size=3
     0: iload_1      // 加载局部变量表slot 1（参数a）
     1: iload_2      // 加载局部变量表slot 2（参数b）
     2: iadd         // 整数加法
     3: ireturn      // 返回int值

  LocalVariableTable:
    Start  Length  Slot  Name   Signature
        0       4     0  this   LTest;
        0       4     1     a   I
        0       4     2     b   I
```

## 类加载的生命周期

类从被加载到虚拟机内存，到卸载出内存，完整生命周期包括7个阶段：

```
加载 → 验证 → 准备 → 解析 → 初始化 → 使用 → 卸载
└─────── 连接 ───────┘
```

其中验证、准备、解析统称为"连接"

### 阶段1：加载（Loading）

**三件事**：

1. 通过类的全限定名获取定义此类的二进制字节流
2. 将字节流代表的静态存储结构转化为方法区的运行时数据结构
3. 在内存中生成代表这个类的`java.lang.Class`对象

**字节流的来源**：

- 从ZIP包读取（JAR、WAR）
- 从网络获取（Applet）
- 运行时计算生成（动态代理）
- 由其他文件生成（JSP）
- 从数据库读取（中间件的类库）

Hotspot中加载的入口（`systemDictionary.cpp`）：

```cpp
Klass* SystemDictionary::resolve_or_fail(Symbol* class_name,
                                          Handle class_loader,
                                          Handle protection_domain,
                                          bool throw_error, TRAPS) {
    // 1. 先查缓存（SystemDictionary是类的注册表）
    Klass* k = find_class(d_hash, name, dictionary);
    if (k != NULL) {
        return k;
    }

    // 2. 调用类加载器加载
    k = load_instance_class(class_name, class_loader, THREAD);

    // 3. 如果加载失败且需要抛异常
    if (k == NULL) {
        if (throw_error) {
            THROW_MSG_NULL(vmSymbols::java_lang_NoClassDefFoundError(), class_name->as_C_string());
        }
    }

    return k;
}
```

**Klass模型**：

JVM内部用C++的`Klass`对象表示Java类，用`oop`（ordinary object pointer）表示Java对象实例：

```cpp
// instanceKlass.hpp - Java类的运行时表示
class InstanceKlass: public Klass {
  private:
    // 类的结构信息
    Array<Method*>* _methods;         // 方法数组
    Array<u2>* _fields;               // 字段数组
    ConstantPool* _constants;         // 常量池
    Klass* _super;                    // 父类
    Array<Klass*>* _local_interfaces; // 实现的接口

    // 类的状态
    u1 _init_state;                   // 初始化状态

    // 虚方法表（用于动态分派）
    int _vtable_len;
    int _itable_len;

  public:
    // 访问方法
    Method* method_at(int index) { return _methods->at(index); }
};
```

### 阶段2：验证（Verification）

确保Class文件的字节流符合JVM规范，不会危害虚拟机安全

**四个验证阶段**：

**1. 文件格式验证**：

- 是否以`0xCAFEBABE`开头
- 主次版本号是否在当前JVM处理范围内
- 常量池是否有不支持的常量类型
- 指向常量的索引是否越界

```cpp
// classFileParser.cpp
void ClassFileParser::parse_stream(...) {
    u4 magic = cfs->get_u4_fast();
    guarantee(magic == 0xCAFEBABE, "Incompatible magic value");

    u2 minor_version = cfs->get_u2_fast();
    u2 major_version = cfs->get_u2_fast();
    verify_version(major_version, minor_version);
}
```

**2. 元数据验证**：

- 这个类是否有父类（除Object外都应该有）
- 父类是否继承了不允许继承的类（被final修饰）
- 如果不是抽象类，是否实现了父类或接口要求实现的所有方法

**3. 字节码验证**：

最复杂的阶段，通过数据流和控制流分析，确保：

- 操作数栈的数据类型与指令匹配
- 跳转指令不会跳到方法体外
- 方法体中的类型转换是有效的

```java
// 非法示例
int a = 1;
Object obj = a;  // 编译期就会报错，但如果通过篡改字节码绕过编译检查，验证阶段会拦截
```

Hotspot使用**类型推导**验证字节码：

```cpp
// verifier.cpp
void ClassVerifier::verify_method(methodHandle m, TRAPS) {
    StackMapFrame current_frame(m->max_locals(), m->max_stack());

    for (int bci = 0; bci < m->code_size(); ) {
        u1 opcode = m->code_at(bci);

        // 根据指令更新类型状态
        switch (opcode) {
            case Bytecodes::_iload:
                current_frame.push(VerificationType::integer_type());
                break;
            case Bytecodes::_aload:
                current_frame.push(VerificationType::reference_type(...));
                break;
            // ...
        }

        bci += Bytecodes::length_at(m->code_base() + bci);
    }
}
```

**4. 符号引用验证**：

发生在解析阶段，验证类是否缺少或被禁止访问它依赖的外部类、方法、字段

:::warning

验证阶段很耗时，生产环境可以用`-Xverify:none`关闭（信任的代码），但不推荐

:::

### 阶段3：准备（Preparation）

为类的**静态变量**分配内存并设置默认初始值（零值）

```java
public class Test {
    public static int value = 123;      // 准备阶段: value = 0
    public static final int CONST = 45; // 准备阶段: CONST = 45
}
```

注意：

- `value`在准备阶段是0，到初始化阶段才赋值为123
- `CONST`被`final`修饰，在准备阶段直接赋值为45（常量传播优化）

**数据类型的零值**：

| 类型 | 零值 |
|-----|------|
| int | 0 |
| long | 0L |
| float | 0.0f |
| double | 0.0d |
| boolean | false |
| reference | null |

Hotspot实现（`instanceKlass.cpp`）：

```cpp
void InstanceKlass::initialize_static_field(fieldDescriptor* fd, TRAPS) {
    Handle mirror(THREAD, java_mirror());

    switch (fd->field_type()) {
        case T_BYTE:
            mirror()->byte_field_put(fd->offset(), 0);
            break;
        case T_INT:
            mirror()->int_field_put(fd->offset(), 0);
            break;
        case T_OBJECT:
            mirror()->obj_field_put(fd->offset(), NULL);
            break;
        // ...
    }
}
```

### 阶段4：解析（Resolution）

将常量池内的**符号引用**替换为**直接引用**

**符号引用 vs 直接引用**：

- **符号引用**：用一组符号描述目标，如`"java/lang/String"`
- **直接引用**：直接指向目标的指针、偏移量或句柄

```java
public class A {
    public void test() {
        B b = new B();  // 编译后常量池存储符号引用 "com/example/B"
        b.method();     // 符号引用 "com/example/B.method:()V"
    }
}
```

解析时，JVM会：

1. 查找类B（如果没加载则先加载）
2. 确认B有method方法且A有权限访问
3. 将符号引用替换为B类的内存地址和method的方法表索引

**解析的四种类型**：

1. **类或接口的解析**（CONSTANT_Class_info）
2. **字段解析**（CONSTANT_Fieldref_info）
3. **方法解析**（CONSTANT_Methodref_info）
4. **接口方法解析**（CONSTANT_InterfaceMethodref_info）

```cpp
// constantPoolOop.cpp
Klass* ConstantPool::klass_at_impl(int which, TRAPS) {
    Symbol* name = klass_name_at(which);

    // 触发类加载
    Klass* k = SystemDictionary::resolve_or_fail(
        name,
        Handle(THREAD, pool_holder()->class_loader()),
        Handle(THREAD, pool_holder()->protection_domain()),
        true, CHECK_NULL
    );

    // 缓存解析结果
    klass_at_put(which, k);
    return k;
}
```

**方法的解析**：

```cpp
Method* ConstantPool::method_at_if_loaded(int which) {
    // 1. 解析方法所属的类
    Klass* klass = klass_at(which);

    // 2. 获取方法的名称和描述符
    Symbol* name = name_ref_at(which);
    Symbol* signature = signature_ref_at(which);

    // 3. 在类的方法表中查找匹配的方法
    Method* m = klass->lookup_method(name, signature);

    return m;
}
```

:::tip

解析可以是延迟的（Lazy Resolution）。有些JVM实现在类加载时就解析所有符号引用，Hotspot采用按需解析的策略

:::

### 阶段5：初始化（Initialization）

执行类构造器`<clinit>()`方法，真正开始执行Java代码

**`<clinit>()`方法的生成**：

编译器自动收集类中所有静态变量的赋值动作和static块，按源文件中出现的顺序合并：

```java
public class Test {
    static {
        i = 10;             // 可以赋值
        System.out.println(i);  // 编译错误：非法前向引用
    }
    public static int i = 5;

    static {
        System.out.println(i);  // 输出5
    }
}

// 生成的<clinit>方法：
static <clinit>() {
    i = 10;
    i = 5;
    System.out.println(i);
}
```

**初始化的触发时机**（有且仅有6种情况）：

1. 遇到`new`、`getstatic`、`putstatic`、`invokestatic`字节码指令
2. 使用反射调用类时
3. 初始化子类时，发现父类还没初始化
4. 虚拟机启动时，用户指定的主类（包含main方法）
5. 使用JDK 7的动态语言支持时，MethodHandle实例解析结果为REF_getStatic等
6. 接口定义了default方法，实现类初始化前要先初始化接口

**不会触发初始化的情况**：

```java
// 1. 通过子类引用父类的静态字段，不会触发子类初始化
System.out.println(Child.parentValue);

// 2. 通过数组定义来引用类，不会触发初始化
Parent[] arr = new Parent[10];

// 3. 引用常量不会触发初始化（常量在编译期已放入常量池）
System.out.println(Parent.CONST);
```

Hotspot初始化的实现（`instanceKlass.cpp`）：

```cpp
void InstanceKlass::initialize_impl(TRAPS) {
    // 1. 获取初始化锁（保证线程安全）
    ObjectLocker ol(init_lock, THREAD);

    // 2. 检查状态，避免重复初始化
    if (is_initialized()) return;
    if (is_being_initialized() && _init_thread == THREAD) return;

    // 3. 等待其他线程完成初始化
    while (is_being_initialized()) {
        ol.wait(THREAD);
    }

    // 4. 标记为初始化中
    set_init_state(being_initialized);
    set_init_thread(THREAD);

    // 5. 初始化父类
    if (super() != NULL && !super()->is_initialized()) {
        super()->initialize(THREAD);
    }

    // 6. 执行<clinit>方法
    Method* clinit = find_method(vmSymbols::class_initializer_name(),
                                  vmSymbols::void_method_signature());
    if (clinit != NULL) {
        JavaCalls::call(clinit, CHECK);
    }

    // 7. 标记为已初始化
    set_init_state(fully_initialized);
    ol.notify_all(THREAD);
}
```

**初始化的线程安全**：

JVM保证`<clinit>()`方法在多线程环境下被正确加锁：

```java
public class DeadLoopClass {
    static {
        if (true) {
            System.out.println(Thread.currentThread() + " init");
            while (true) {}  // 模拟耗时操作
        }
    }
}

// 线程1: 执行<clinit>，陷入死循环
// 线程2: 等待线程1完成，永远阻塞
```

## 双亲委派模型

### 三层类加载器

Java自带的类加载器分为三层：

```
Bootstrap ClassLoader (C++实现)
        ↑
  Extension ClassLoader (Java实现)
        ↑
  Application ClassLoader (Java实现)
```

**1. 启动类加载器（Bootstrap ClassLoader）**

- 用C++实现，是JVM的一部分
- 负责加载`<JAVA_HOME>/lib`目录的类库（如rt.jar）
- 无法被Java程序直接引用（`String.class.getClassLoader()`返回null）

**2. 扩展类加载器（Extension ClassLoader）**

- `sun.misc.Launcher$ExtClassLoader`实现
- 加载`<JAVA_HOME>/lib/ext`目录的类库

**3. 应用程序类加载器（Application ClassLoader）**

- `sun.misc.Launcher$AppClassLoader`实现
- 加载用户类路径（ClassPath）上的类库
- 这是程序中默认的类加载器

查看类加载器：

```java
public class ClassLoaderTest {
    public static void main(String[] args) {
        ClassLoader loader = ClassLoaderTest.class.getClassLoader();
        System.out.println(loader);  // sun.misc.Launcher$AppClassLoader

        System.out.println(loader.getParent());  // sun.misc.Launcher$ExtClassLoader

        System.out.println(loader.getParent().getParent());  // null (Bootstrap)
    }
}
```

### 双亲委派模型

**工作流程**：

1. 类加载器收到类加载请求
2. 不自己加载，委派给父类加载器
3. 父类加载器还有父类，继续向上委派，直到启动类加载器
4. 父类加载器无法加载（范围内找不到类），子加载器才尝试自己加载

```
ClassLoader.loadClass("com.example.Test")
    ↓
AppClassLoader: 我不加载，问我爹
    ↓
ExtClassLoader: 我也不加载，问我爹
    ↓
BootstrapClassLoader: 我的范围内没有这个类，还给儿子
    ↓
ExtClassLoader: 我的范围内也没有，还给儿子
    ↓
AppClassLoader: 那我自己加载
```

**源码实现**（`ClassLoader.java`）：

```java
protected Class<?> loadClass(String name, boolean resolve)
    throws ClassNotFoundException {
    synchronized (getClassLoadingLock(name)) {
        // 1. 检查类是否已加载
        Class<?> c = findLoadedClass(name);

        if (c == null) {
            try {
                // 2. 委派给父类加载器
                if (parent != null) {
                    c = parent.loadClass(name, false);
                } else {
                    // 3. 父类为null，说明是ExtClassLoader，委派给Bootstrap
                    c = findBootstrapClassOrNull(name);
                }
            } catch (ClassNotFoundException e) {
                // 父类加载器无法加载
            }

            if (c == null) {
                // 4. 父类加载失败，自己加载
                c = findClass(name);
            }
        }

        if (resolve) {
            resolveClass(c);
        }
        return c;
    }
}
```

**为什么要双亲委派？**

**安全性**：防止核心类库被篡改

```java
// 假设没有双亲委派，你写了一个恶意的java.lang.String
package java.lang;

public class String {
    // 恶意代码
}

// 这个类会被你的类加载器加载，可能导致安全问题
// 有了双亲委派，启动类加载器会先加载JDK自带的String，你的类永远不会被加载
```

**避免重复加载**：父加载器加载过的类，子加载器不会再加载

### 破坏双亲委派

**场景1：JDBC的SPI机制**

JDBC的Driver接口在`rt.jar`中，由Bootstrap ClassLoader加载。但具体实现（如MySQL Driver）在ClassPath中，Bootstrap加载不到

解决：引入**线程上下文类加载器**（Thread Context ClassLoader）

```java
// DriverManager.java (JDK代码)
static {
    loadInitialDrivers();
}

private static void loadInitialDrivers() {
    // 使用ServiceLoader加载驱动
    ServiceLoader<Driver> loadedDrivers = ServiceLoader.load(Driver.class);

    // ServiceLoader内部使用线程上下文类加载器
    Iterator<Driver> driversIterator = loadedDrivers.iterator();
    while (driversIterator.hasNext()) {
        driversIterator.next();
    }
}
```

```java
// ServiceLoader.java
public static <S> ServiceLoader<S> load(Class<S> service) {
    // 获取线程上下文类加载器（默认是AppClassLoader）
    ClassLoader cl = Thread.currentThread().getContextClassLoader();
    return ServiceLoader.load(service, cl);
}
```

**场景2：Tomcat的类加载架构**

Tomcat需要实现：

- 不同Web应用的类库互相隔离
- 相同类库可以共享
- 容器本身的类不被应用访问

Tomcat的类加载器层次：

```
      Bootstrap ClassLoader
              ↑
      Extension ClassLoader
              ↑
      System ClassLoader
              ↑
      Common ClassLoader          ← Tomcat和所有应用共享
       ↓           ↓
Catalina CL   Shared CL           ← Tomcat专用 vs 应用共享
                  ↓
            WebApp1 CL            ← 每个应用独立
            WebApp2 CL
```

**WebAppClassLoader的加载顺序**（违反双亲委派）：

1. 先在本地缓存查找
2. 如果没有，委派给父类加载器（Common）
3. 父类加载器找不到，自己加载（`/WEB-INF/classes`和`/WEB-INF/lib`）
4. 还是找不到，委派给System类加载器

```java
// WebappClassLoaderBase.java (Tomcat源码)
public Class<?> loadClass(String name, boolean resolve)
    throws ClassNotFoundException {

    Class<?> clazz = null;

    // 1. 查缓存
    clazz = findLoadedClass0(name);
    if (clazz != null) return clazz;

    clazz = findLoadedClass(name);
    if (clazz != null) return clazz;

    // 2. 对于系统类，委派给父加载器
    if (name.startsWith("java.")) {
        return Class.forName(name, false, parent);
    }

    // 3. 先尝试自己加载（打破双亲委派！）
    try {
        clazz = findClass(name);
        if (clazz != null) return clazz;
    } catch (ClassNotFoundException e) {}

    // 4. 自己加载失败，再委派给父加载器
    if (!delegateLoad) {
        clazz = parent.loadClass(name);
    }

    return clazz;
}
```

**场景3：OSGI的模块化**

OSGI实现模块化热部署，每个模块（Bundle）有独立的类加载器，可以：

- 声明依赖的其他Bundle
- 指定导出/导入的包
- 同一个Bundle可以有多个版本并存

OSGI的类加载查找顺序：

1. `java.*`开头的类，委派给父类加载器
2. 委派列表中的类，委派给对应的Bundle类加载器
3. Import列表中的类，查找Export这个包的Bundle
4. 查找当前Bundle的ClassPath
5. 查找Fragment Bundle

完全放弃了双亲委派，改用**网状结构**

## 自定义类加载器

### 实现自定义类加载器

继承`ClassLoader`并重写`findClass`方法：

```java
public class CustomClassLoader extends ClassLoader {
    private String classPath;

    public CustomClassLoader(String classPath) {
        this.classPath = classPath;
    }

    @Override
    protected Class<?> findClass(String name) throws ClassNotFoundException {
        try {
            // 1. 读取.class文件的字节数组
            byte[] data = loadClassData(name);

            // 2. 调用defineClass方法将字节数组转换为Class对象
            return defineClass(name, data, 0, data.length);
        } catch (Exception e) {
            throw new ClassNotFoundException(name, e);
        }
    }

    private byte[] loadClassData(String name) throws IOException {
        // 将类名转换为文件路径: com.example.Test -> com/example/Test.class
        String fileName = name.replace('.', '/') + ".class";
        Path path = Paths.get(classPath, fileName);

        return Files.readAllBytes(path);
    }
}

// 使用
CustomClassLoader loader = new CustomClassLoader("/path/to/classes");
Class<?> clazz = loader.loadClass("com.example.Test");
Object instance = clazz.newInstance();
```

### 类加载器的命名空间

**同一个类 = 同一个Class文件 + 同一个类加载器**

```java
CustomClassLoader loader1 = new CustomClassLoader("/path");
CustomClassLoader loader2 = new CustomClassLoader("/path");

Class<?> class1 = loader1.loadClass("com.example.Test");
Class<?> class2 = loader2.loadClass("com.example.Test");

System.out.println(class1 == class2);  // false !

Object obj1 = class1.newInstance();
Object obj2 = class2.newInstance();

System.out.println(obj1 instanceof obj2.getClass());  // false !
```

这就是前言提到的问题：不同类加载器加载的类，JVM视为不同的类

### 热部署的实现

```java
public class HotSwapClassLoader extends ClassLoader {
    private String classPath;

    public HotSwapClassLoader(String classPath) {
        super(HotSwapClassLoader.class.getClassLoader());  // 指定父类加载器
        this.classPath = classPath;
    }

    @Override
    protected Class<?> findClass(String name) throws ClassNotFoundException {
        byte[] data = loadClassData(name);
        return defineClass(name, data, 0, data.length);
    }

    private byte[] loadClassData(String name) throws IOException {
        String fileName = name.replace('.', '/') + ".class";
        Path path = Paths.get(classPath, fileName);
        return Files.readAllBytes(path);
    }
}

// 热部署管理器
public class HotDeployManager {
    private HotSwapClassLoader currentLoader;
    private String classPath;

    public HotDeployManager(String classPath) {
        this.classPath = classPath;
        reload();
    }

    public void reload() {
        // 创建新的类加载器实例
        currentLoader = new HotSwapClassLoader(classPath);
        System.out.println("重新加载完成");
    }

    public Object getInstance(String className) throws Exception {
        Class<?> clazz = currentLoader.loadClass(className);
        return clazz.newInstance();
    }

    public static void main(String[] args) throws Exception {
        HotDeployManager manager = new HotDeployManager("/tmp/classes");

        while (true) {
            Object obj = manager.getInstance("com.example.HotClass");
            Method method = obj.getClass().getMethod("doSomething");
            method.invoke(obj);

            Thread.sleep(3000);

            System.out.println("按Enter键重新加载类...");
            System.in.read();
            manager.reload();
        }
    }
}
```

修改HotClass的代码，重新编译到`/tmp/classes`，按Enter后立即生效

## 模块化系统（Jigsaw）

JDK 9引入模块化系统，对类加载机制产生深远影响

### module-info.java

```java
module com.example.myapp {
    requires java.sql;                     // 依赖java.sql模块
    requires transitive java.logging;      // 传递依赖
    exports com.example.myapp.api;         // 导出包
    opens com.example.myapp.internal to    // 反射访问
        com.example.framework;
}
```

### 模块化后的类加载器

JDK 9后，Extension ClassLoader被Platform ClassLoader替代：

```
Bootstrap ClassLoader
    ↓ 加载java.base等核心模块
Platform ClassLoader
    ↓ 加载java.sql, java.xml等平台模块
Application ClassLoader
    ↓ 加载用户模块和ClassPath上的类
```

**模块路径 vs 类路径**：

- `--module-path`：模块化的jar
- `--class-path`：传统的jar（无module-info.class）

类加载器在加载类时，优先从模块路径查找

## 总结

1. **Class文件是JVM的"汇编语言"**，严格的二进制格式保证了平台无关性

2. **类加载的7个阶段**，其中验证、准备、解析是连接阶段，初始化是执行Java代码的开始

3. **双亲委派保证安全和避免重复**，但在SPI、容器、模块化等场景需要打破

4. **同一个类 = Class文件 + 类加载器**，不同加载器加载的类是不同的类

5. **类加载器是实现热部署、插件化、模块化的基础**

理解类加载机制，不仅能应对面试，更重要的是在遇到`ClassNotFoundException`、`NoClassDefFoundError`、`ClassCastException`等问题时，能快速定位根因。下次遇到"明明这个类存在，为什么找不到"的问题，就从类加载器查起吧
