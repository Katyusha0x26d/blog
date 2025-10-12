---
title: 从SDS到ZipList理解Redis常用数据结构
categories: Redis
tags:
    - Redis
    - 数据结构
date: 2025-10-13 09:15:00 +0800
updated: 2025-10-13 09:15:00 +0800
---

很多人觉得Redis快，是因为它基于内存。这当然没错，但如果只是把数据放在内存里，任何数据库都能做到。Redis真正的精妙之处，首先在于它为不同场景精心设计的底层数据结构

前段时间在排查一个线上问题：某个大key导致Redis响应变慢。当时我深入阅读了Redis的源码，发现它的String类型在不同情况下会使用完全不同的内部表示——短字符串用embstr、长字符串用raw、纯数字用int。这种针对性优化的思想贯穿在Redis的每个数据结构中

<!-- more -->

## Redis的对象系统架构

在深入具体数据结构之前，需要理解Redis的对象系统。Redis并不直接使用底层数据结构，而是基于对象系统来构建键值对数据库

### RedisObject：统一的对象外壳

Redis中所有的值都被包装在`redisObject`结构中（源码位于`server.h`）：

```c
typedef struct redisObject {
    unsigned type:4;        // 对象类型：String/List/Set/ZSet/Hash
    unsigned encoding:4;    // 编码方式：决定底层使用哪种数据结构
    unsigned lru:24;        // LRU时间或LFU数据
    int refcount;           // 引用计数
    void *ptr;              // 指向实际数据结构的指针
} robj;
```

这个设计很巧妙：

- **type**：定义对象的逻辑类型（用户视角）
- **encoding**：定义底层实现（系统视角）
- **refcount**：引用计数机制，实现内存共享和垃圾回收

:::tip

Redis使用位域（bit field）压缩`redisObject`的大小。`unsigned type:4`表示只用4个比特存储type字段，这样前三个字段总共只占用32位（4字节）

:::

### 类型与编码的映射关系

一个type可以对应多个encoding，Redis会根据数据特征动态选择最优编码：

| 对象类型 | 编码方式 | 底层数据结构 |
|---------|---------|------------|
| String | int | long类型整数 |
| String | embstr | 嵌入式SDS（≤44字节） |
| String | raw | 独立SDS（>44字节） |
| List | quicklist | 快速列表 |
| Hash | ziplist | 压缩列表 |
| Hash | hashtable | 哈希表 |
| Set | intset | 整数集合 |
| Set | hashtable | 哈希表 |
| ZSet | ziplist | 压缩列表 |
| ZSet | skiplist | 跳表+哈希表 |

## String：看似简单实则复杂

Redis没有直接使用C语言的字符串（`char*`），而是自己实现了SDS（Simple Dynamic String）

### 为什么不用C字符串？

C字符串有几个致命问题：

1. **获取长度O(n)**：需要遍历到`\0`才知道长度
2. **缓冲区溢出**：strcat等函数不检查目标缓冲区大小
3. **二进制不安全**：`\0`会被当作结束符，无法存储二进制数据
4. **内存重分配频繁**：每次修改都需要重新分配内存

### SDS的设计哲学

SDS的结构定义（`sds.h`）：

```c
struct __attribute__ ((__packed__)) sdshdr64 {
    uint64_t len;        // 当前字符串长度
    uint64_t alloc;      // 已分配空间（不包括头和结束符）
    unsigned char flags; // 标识sdshdr类型
    char buf[];          // 柔性数组，实际存储数据
};
```

Redis针对不同长度的字符串定义了5种SDS类型：sdshdr5、sdshdr8、sdshdr16、sdshdr32、sdshdr64，区别在于len和alloc字段的类型大小

:::warning

`__attribute__ ((__packed__))`是GCC的特性，告诉编译器不要为结构体做内存对齐，这样可以节省内存。但代价是访问速度可能稍慢（未对齐的内存访问）

:::

### 空间预分配策略

SDS修改时的内存分配策略（`sds.c`的`sdsMakeRoomFor`函数）：

```c
sds sdsMakeRoomFor(sds s, size_t addlen) {
    struct sdshdr *sh = (void*)(s - sizeof(struct sdshdr));
    size_t free = sh->alloc - sh->len;

    if (free >= addlen) return s;  // 剩余空间足够

    size_t len = sh->len;
    size_t newlen = len + addlen;

    // 核心策略：
    if (newlen < SDS_MAX_PREALLOC)  // 1MB
        newlen *= 2;                 // 小于1MB时翻倍
    else
        newlen += SDS_MAX_PREALLOC;  // 大于1MB时每次多分配1MB

    // 重新分配内存并复制数据...
}
```

这种策略在频繁append操作时能显著减少内存重分配次数：

- 追加100次短字符串：C字符串需要100次realloc，SDS只需要约7次（log₂100）
- 追加大字符串：避免一次性分配过大内存造成浪费

### embstr vs raw：44字节的分界线

Redis 3.2之后，String对象有个有趣的优化：

```c
robj *createStringObject(const char *ptr, size_t len) {
    if (len <= OBJ_ENCODING_EMBSTR_SIZE_LIMIT)  // 44字节
        return createEmbeddedStringObject(ptr, len);
    else
        return createRawStringObject(ptr, len);
}
```

**embstr编码**：一次内存分配，redisObject和SDS连续存储

```
┌────────────────┬──────────────────┐
│  redisObject   │   SDS数据        │
└────────────────┴──────────────────┘
   16字节          3字节头 + 44字节数据 + 1字节'\0'
```

**raw编码**：两次内存分配，redisObject的ptr指向独立的SDS

```
┌────────────────┐          ┌──────────────────┐
│  redisObject   │  ──────> │   SDS 数据       │
└────────────────┘          └──────────────────┘
```

为什么是44？因为Redis使用jemalloc内存分配器，它的内存块大小是按64字节递增的。16字节redisObject + 3字节SDS头 + 44字节数据 + 1字节'\0' = 64字节，刚好一个内存块

## List：从双向链表到QuickList的演进

Redis的List经历了几次重大变化，这个演进过程很能体现数据结构权衡的艺术

### 早期方案：LinkedList + ZipList

Redis 3.2之前，List使用两种编码：

- 元素少且小时用**ziplist**（压缩列表）：紧凑但插入删除慢
- 元素多或大时用**linkedlist**（双向链表）：灵活但内存碎片多

问题是转换阈值不好设置：
- 阈值太小：很多场景用linkedlist，内存浪费
- 阈值太大：ziplist过大时性能急剧下降

### QuickList：鱼和熊掌都要

Redis 3.2引入quicklist，本质上是"linkedlist of ziplist"：

```c
typedef struct quicklist {
    quicklistNode *head;
    quicklistNode *tail;
    unsigned long count;        // 所有ziplist中的总元素数
    unsigned long len;          // quicklistNode节点数
    int fill : QL_FILL_BITS;    // 单个ziplist的大小限制
    unsigned int compress : QL_COMP_BITS;  // 压缩深度
} quicklist;

typedef struct quicklistNode {
    struct quicklistNode *prev;
    struct quicklistNode *next;
    unsigned char *zl;          // 指向ziplist
    unsigned int sz;            // ziplist的字节数
    unsigned int count : 16;    // ziplist中的元素个数
    unsigned int encoding : 2;  // 是否使用LZF压缩
    unsigned int container : 2; // 数据容器类型
    unsigned int recompress : 1;// 临时解压标记
    // ...
} quicklistNode;
```

**设计思想**：

1. 每个quicklistNode包含一个ziplist（默认大小8KB）
2. 多个quicklistNode用双向链表连接
3. 两端的ziplist保持未压缩（频繁访问），中间的用LZF算法压缩

这样既获得了ziplist的内存紧凑性，又避免了单个ziplist过大导致的性能问题

:::tip

`fill`参数控制每个ziplist的大小：
- 正数：限制元素个数（如8表示最多8个元素）
- 负数：限制字节数（-1=4KB, -2=8KB, -3=16KB, -4=32KB, -5=64KB）

默认值-2（8KB）是经过大量测试得出的最优值

:::

### QuickList的插入操作

核心函数`quicklistInsertAfter`（简化版）：

```c
void quicklistInsertAfter(quicklist *ql, quicklistEntry *entry, void *value, size_t sz) {
    quicklistNode *node = entry->node;

    // 1. 尝试在当前ziplist中插入
    if (_quicklistNodeAllowInsert(node, fill, sz)) {
        node->zl = ziplistInsert(node->zl, entry->zi, value, sz);
        node->count++;
    }
    // 2. 当前ziplist已满，创建新节点
    else {
        quicklistNode *new_node = quicklistCreateNode();
        new_node->zl = ziplistPush(ziplistNew(), value, sz, ZIPLIST_HEAD);
        __quicklistInsertNode(ql, node, new_node, after);
    }
}
```

这种设计让List的性能特征非常均衡：
- LPUSH/RPUSH：O(1)
- LINDEX：O(N)，但由于ziplist缓存友好，实际很快
- LINSERT：O(N)，但分摊到多个小ziplist后影响不大

## Hash：渐进式rehash的精妙设计

Hash是Redis中最复杂的数据结构之一，尤其是它的渐进式rehash机制

### 从ZipList到HashTable

小Hash用ziplist编码，满足以下条件时转为hashtable：

```c
// server.h
#define OBJ_HASH_MAX_ZIPLIST_ENTRIES 512
#define OBJ_HASH_MAX_ZIPLIST_VALUE 64
```

- 元素个数 ≤ 512
- 所有键值的长度 ≤ 64字节

ziplist中Hash的存储方式：key1, val1, key2, val2...依次紧密排列

### Dict：Redis的哈希表实现

```c
typedef struct dict {
    dictType *type;       // 类型特定函数
    void *privdata;       // 私有数据
    dictht ht[2];         // 两个哈希表！
    long rehashidx;       // rehash进度（-1表示未进行）
    int16_t pauserehash;  // 暂停rehash的标记
} dict;

typedef struct dictht {
    dictEntry **table;    // 哈希表数组
    unsigned long size;   // 桶的数量（总是2的幂）
    unsigned long sizemask;  // size - 1，用于计算索引
    unsigned long used;   // 已有节点数
} dictht;

typedef struct dictEntry {
    void *key;
    union {
        void *val;
        uint64_t u64;
        int64_t s64;
        double d;
    } v;
    struct dictEntry *next;  // 链地址法解决冲突
} dictEntry;
```

**为什么有两个dictht？**

这是渐进式rehash的关键！

### 渐进式Rehash的完整流程

传统哈希表扩容时，需要一次性重新分配所有元素，如果数据量大（比如几百万个key），这个过程可能导致服务卡顿几百毫秒

Redis的做法是：

**1. 触发rehash**（`dict.c`的`_dictExpandIfNeeded`）：

```c
static int _dictExpandIfNeeded(dict *d) {
    if (d->rehashidx != -1) return DICT_OK;  // 正在rehash

    if (d->ht[0].used >= d->ht[0].size &&
        (dict_can_resize || d->ht[0].used / d->ht[0].size > dict_force_resize_ratio)) {
        return dictExpand(d, d->ht[0].used * 2);
    }
    return DICT_OK;
}
```

扩容条件：
- 负载因子 ≥ 1 且允许resize
- 或负载因子 > 5（强制扩容）

**2. 分配新表**：

```c
int dictExpand(dict *d, unsigned long size) {
    dictht n;
    unsigned long realsize = _dictNextPower(size);  // 向上取2的幂

    n.size = realsize;
    n.sizemask = realsize - 1;
    n.table = zcalloc(realsize * sizeof(dictEntry*));
    n.used = 0;

    d->ht[1] = n;
    d->rehashidx = 0;  // 开始rehash
    return DICT_OK;
}
```

此时ht[0]是旧表，ht[1]是新表

**3. 渐进式迁移**：

每次对dict进行增删改查操作时，顺便迁移一部分数据：

```c
static void _dictRehashStep(dict *d) {
    if (d->pauserehash == 0) dictRehash(d, 1);
}

int dictRehash(dict *d, int n) {
    int empty_visits = n * 10;  // 最多访问n*10个空桶

    while (n-- && d->ht[0].used != 0) {
        dictEntry *de, *nextde;

        // 跳过空桶
        while (d->ht[0].table[d->rehashidx] == NULL) {
            d->rehashidx++;
            if (--empty_visits == 0) return 1;
        }

        // 迁移当前桶的所有元素
        de = d->ht[0].table[d->rehashidx];
        while (de) {
            uint64_t h = dictHashKey(d, de->key);
            int idx = h & d->ht[1].sizemask;

            nextde = de->next;
            de->next = d->ht[1].table[idx];
            d->ht[1].table[idx] = de;

            d->ht[0].used--;
            d->ht[1].used++;
            de = nextde;
        }
        d->ht[0].table[d->rehashidx] = NULL;
        d->rehashidx++;
    }

    // rehash完成
    if (d->ht[0].used == 0) {
        zfree(d->ht[0].table);
        d->ht[0] = d->ht[1];
        _dictReset(&d->ht[1]);
        d->rehashidx = -1;
        return 0;
    }
    return 1;
}
```

**4. rehash期间的操作**：

- **查找**：先查ht[0]，找不到再查ht[1]
- **插入**：直接插入ht[1]（新数据不进旧表）
- **删除**：在两个表中都尝试删除

这样把一次性的大开销，分摊到每次操作中，每次操作只增加微小的延迟

:::danger

渐进式rehash期间，内存占用会比平时高（两个表并存）。如果频繁触发rehash，可能导致内存突增

:::

## Set：当所有元素都是整数时

Set的实现相对简单，但intset编码是个有趣的优化

### IntSet：紧凑的整数集合

当Set只包含整数且数量不多时（默认≤512），使用intset编码：

```c
typedef struct intset {
    uint32_t encoding;  // 编码类型：int16/int32/int64
    uint32_t length;    // 元素个数
    int8_t contents[];  // 柔性数组，实际存储数据
} intset;
```

**自动升级**：

假设intset初始只有`[1, 2, 3]`（int16编码），现在要插入65535：

```c
intset *intsetAdd(intset *is, int64_t value, uint8_t *success) {
    uint8_t valenc = _intsetValueEncoding(value);

    // 需要升级编码
    if (valenc > intrev32ifbe(is->encoding)) {
        return intsetUpgradeAndAdd(is, value);
    }

    // 正常插入逻辑...
}

static intset *intsetUpgradeAndAdd(intset *is, int64_t value) {
    uint8_t curenc = intrev32ifbe(is->encoding);
    uint8_t newenc = _intsetValueEncoding(value);
    int length = intrev32ifbe(is->length);

    // 扩展内存
    is = intsetResize(is, length + 1);

    // 从后往前移动元素（避免覆盖）
    while (length--)
        _intsetSet(is, length + 1, _intsetGetEncoded(is, length, curenc));

    // 插入新元素（一定在头或尾）
    if (value < 0)
        _intsetSet(is, 0, value);
    else
        _intsetSet(is, intrev32ifbe(is->length), value);

    is->encoding = intrev32ifbe(newenc);
    is->length = intrev32ifbe(length + 1);
    return is;
}
```

**为什么不支持降级？**

降级的成本太高：需要遍历所有元素检查是否都能用更小的编码，而实际场景中降级需求不多

## ZSet：跳表+哈希表的双引擎

ZSet（有序集合）是Redis最精巧的数据结构，它需要同时支持：
- 按分数范围查询：O(log N)
- 按成员查询分数：O(1)

### SkipList：概率性的平衡树

跳表的发明者William Pugh在论文中说："Skip lists are a probabilistic alternative to balanced trees"

Redis的跳表实现（`server.h`）：

```c
typedef struct zskiplistNode {
    sds ele;                   // 成员对象
    double score;              // 分数
    struct zskiplistNode *backward;  // 后退指针
    struct zskiplistLevel {
        struct zskiplistNode *forward;  // 前进指针
        unsigned long span;             // 跨度（用于计算rank）
    } level[];                 // 柔性数组，存储各层
} zskiplistNode;

typedef struct zskiplist {
    struct zskiplistNode *header, *tail;
    unsigned long length;      // 节点数（不含头节点）
    int level;                 // 最大层数
} zskiplist;
```

**层数的随机算法**：

```c
#define ZSKIPLIST_MAXLEVEL 32
#define ZSKIPLIST_P 0.25

int zslRandomLevel(void) {
    int level = 1;
    while ((random() & 0xFFFF) < (ZSKIPLIST_P * 0xFFFF))
        level += 1;
    return (level < ZSKIPLIST_MAXLEVEL) ? level : ZSKIPLIST_MAXLEVEL;
}
```

每个节点有25%的概率增加一层，这样：
- 1层节点：100%
- 2层节点：25%
- 3层节点：6.25%
- ...

期望的搜索复杂度是O(log N)

### 跳表的查找过程

假设要查找分数为89的节点：

```
层级4: head --------------------------------------> NULL
层级3: head -------> 20 --------------------------> NULL
层级2: head -> 10 -> 20 -> 40 --------------------> NULL
层级1: head -> 10 -> 20 -> 40 -> 60 -> 80 -> 100 -> NULL
```

搜索路径：
1. 从head的最高层(4)开始，发现forward为NULL，下降到层3
2. 层3的forward指向20，20 < 89，前进到20
3. 20的层3 forward为NULL，下降到层2
4. 20的层2 forward指向40，40 < 89，前进到40
5. 40的层2 forward为NULL，下降到层1
6. 依次经过60、80，在80和100之间停止

源码实现：

```c
zskiplistNode *zslFirstInRange(zskiplist *zsl, zrangespec *range) {
    zskiplistNode *x;
    int i;

    x = zsl->header;
    for (i = zsl->level - 1; i >= 0; i--) {
        // 在当前层向右走，直到遇到大于range.min的节点
        while (x->level[i].forward &&
               !zslValueGteMin(x->level[i].forward->score, range))
            x = x->level[i].forward;
    }

    x = x->level[0].forward;
    if (x && zslValueLteMax(x->score, range))
        return x;
    return NULL;
}
```

### ZSet的双引擎设计

ZSet同时使用跳表和哈希表：

```c
typedef struct zset {
    dict *dict;         // member -> score 的映射
    zskiplist *zsl;     // 按score排序的跳表
} zset;
```

- **dict**：支持O(1)的`ZSCORE key member`操作
- **zsl**：支持O(log N)的`ZRANGE key start stop`操作

两个结构通过指针共享成员对象，不会造成内存浪费：

```c
int zsetAdd(robj *zobj, double score, sds ele, int *flags, double *newscore) {
    zset *zs = zobj->ptr;
    dictEntry *de;

    // 1. 先在dict中查找
    de = dictFind(zs->dict, ele);

    if (de != NULL) {
        // 已存在，更新分数
        double curscore = *(double*)dictGetVal(de);
        if (score != curscore) {
            zslDelete(zs->zsl, curscore, ele);
            zslInsert(zs->zsl, score, ele);
            dictSetVal(zs->dict, de, &score);
        }
    } else {
        // 新元素，同时插入dict和zsl
        ele = sdsdup(ele);
        zslInsert(zs->zsl, score, ele);
        dictAdd(zs->dict, ele, &score);
    }
}
```

## ZipList：极致的内存压缩

ZipList是Redis内存优化的极致体现，用于小Hash、小ZSet、小List（3.2之前）

### 连续内存的艺术

ziplist是一段连续的内存块，没有独立的节点结构：

```
<zlbytes> <zltail> <zllen> <entry> <entry> ... <entry> <zlend>
```

- **zlbytes**：整个ziplist占用的字节数（4字节）
- **zltail**：到最后一个entry的偏移量（4字节）
- **zllen**：entry数量（2字节）
- **zlend**：结束标记（1字节，值为255）

每个entry的编码：

```
<prevlen> <encoding> <data>
```

- **prevlen**：前一个entry的长度（1或5字节）
  - 如果前一个entry长度 < 254，用1字节存储
  - 否则第1字节为254（标记），后4字节存储实际长度
- **encoding**：当前entry的类型和长度
- **data**：实际数据

### 连锁更新问题

ziplist有个著名的问题：**cascade update**

假设有这样的ziplist，每个entry都是253字节（prevlen用1字节）：

```
[253字节] [253字节] [253字节] ...
```

现在在开头插入一个254字节的entry：

```
[254字节] [253字节] [253字节] ...
          ↑
       prevlen需要从1字节扩展到5字节
```

第二个entry扩展后变成257字节，导致第三个entry也需要扩展...形成连锁反应

源码中的处理（`ziplist.c`）：

```c
unsigned char *__ziplistInsert(unsigned char *zl, unsigned char *p, unsigned char *s, unsigned int slen) {
    // ... 省略前面的代码

    // 检查是否会引发连锁更新
    if (nextdiff != 0) {
        offset = p - zl;
        zl = ziplistResize(zl, curlen + rawlen + nextdiff);
        p = zl + offset;

        // 移动后续数据
        if (nextdiff == 4) {
            // 从1字节prevlen扩展到5字节
            memmove(p + rawlen, p - nextdiff, curlen - offset);
        }
    }

    // 实际可能需要多次迁移
    // Redis接受这个最坏情况，因为实际触发概率很低
}
```

Redis团队评估后认为：
- 触发条件苛刻（大量253-254字节的entry连续出现）
- 实际场景极少遇到
- 即使发生，也只是暂时的性能抖动

所以没有特别优化，而是通过限制ziplist的大小来规避

## 设计权衡的哲学

回顾Redis的这些数据结构，能看到很多设计权衡的智慧：

1. **SDS的预分配**：用空间换时间，减少重分配次数
2. **embstr的44字节阈值**：贴合内存分配器特性，减少碎片
3. **quicklist的混合设计**：在紧凑和灵活之间找平衡
4. **渐进式rehash**：把大开销分摊，避免阻塞
5. **intset的升级不降级**：实用主义，不追求完美
6. **ZSet的双引擎**：空间换时间，支持不同查询模式
7. **ziplist的连锁更新**：接受罕见的最坏情况，保持整体简洁

这些决策背后都有大量的benchmark和生产环境验证。Redis作者antirez曾说："Perfection is the enemy of good"。追求极致优化的同时，也要知道在哪里停下来

如果你在设计自己的系统时遇到类似的权衡问题，不妨参考Redis的思路：先测量，再优化；针对常见场景优化，接受罕见场景的次优解
