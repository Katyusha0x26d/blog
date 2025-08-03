---
title: 浅谈Java对象的序列化与反序列化
categories: Java
tags:
    - 序列化
    - 反序列化
    - Java
    - Jackson
    - JSON
date: 2025-08-02 22:05:00 +0800
updated: 2025-08-02 22:05:00 +0800
---

在Java中，将对象转换为字符串，以及从字符串恢复回对象的过程，叫做序列化，与反序列化。本文介绍如何在Java中配置基本的序列化与反序列化。

![Serialization and De-serialization](https://lc-gluttony.s3.amazonaws.com/6Beck3SuJkGW/8lpubhj8IUpG9nkxIePbQLlhbvQPklOs/1628497417-103268.png "Serialization and De-serialization")

<!-- more -->

## toString

既然序列化是将对象转为字符串，所以很显然我直接`object.toString()`不就行了吗，这固然很好，但是目前大部分框架，包括lombok，他只管`toString()`后人可以分辨出来，不管`toString()`后程序能否识别

考虑到下列类：

```java
package me.katyusha;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.ZonedDateTime;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class Student {
    private Long id;
    private String name;
    private Integer age;
    private ZonedDateTime birthday;
    private String gender;
    private String school;
    private String grade;
    private String address;
}

```

lombok的`@Data`注解，相当于同时使用`@Getter`、`@Setter`、`@ToString`、`@EqualsAndHashCode`以及`@RequiredArgsConstructor`，在类上添加此注解，可以使用类的`toString()`方法，打印类的细节

假设我这样做：

```java
package me.katyusha;

import java.time.ZonedDateTime;

public class Main {
    public static void main(String[] args) {
        Student student = new Student();
        student.setId(1L);
        student.setName("Maxwell");
        student.setAge(23);
        student.setBirthday(ZonedDateTime.parse("2003-01-01T12:34:56+08:00"));
        student.setGender("Male");
        student.setSchool("Tsinghua University");
        student.setGrade("22");
        student.setAddress(null);
        System.out.println(student);
    }
}
```

以及：

```java
package me.katyusha;

import java.time.ZonedDateTime;

public class Main {
    public static void main(String[] args) {
        Student student = new Student();
        student.setId(1L);
        student.setName("Maxwell");
        student.setAge(23);
        student.setBirthday(ZonedDateTime.parse("2003-01-01T12:34:56+08:00"));
        student.setGender("Male");
        student.setSchool("Tsinghua University");
        student.setGrade("22");
        student.setAddress("null");
        System.out.println(student);
    }
}
```

两个的打印结果是：`Student(id=1, name=Maxwell, age=23, birthday=2003-01-01T12:34:56+08:00, gender=Male, school=Tsinghua University, grade=22, address=null)`，那么到底address是`null`，还是`"null"`，你总不能说`"null"`不是一个合法的地址吧？在前端处理时应该如何转为原来正确的对象？

:::tip

在Java中，`toString()`方法虽能把对象转换为字符串，但它并不等同于序列化。序列化需要保证，在序列化前后，对象的所有字段状态一致完整，上面这个`toString()`就不行

现代大多数序列化框架，例如JSON、XML、Protobuf等，都具有统一的协议，能够正确表示对象状态且防范恶意注入的攻击

:::

## Java原生序列化和反序列化

在Java中，如果对象实现`java.io.Serializable`接口，那么可以使用`java.io.ObjectOutputStream`将对象写入到`java.io.ByteArrayOutputStream`

```java
package me.katyusha;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serializable;
import java.time.ZonedDateTime;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class Student implements Serializable {
    private Long id;
    private String name;
    private Integer age;
    private ZonedDateTime birthday;
    private String gender;
    private String school;
    private String grade;
    private String address;
}

```

```java
ByteArrayOutputStream baos = new ByteArrayOutputStream();

try (ObjectOutputStream oos = new ObjectOutputStream(baos)) {
    oos.writeObject(student);
} catch (IOException e) {
    System.err.println(e.getMessage());
}

String str = Base64.getEncoder().encodeToString(baos.toByteArray());
```

此时序列化的结果是一个二进制数据

反序列化，将对象使用`java.io.ObjectInputStream`将对象写入到`java.io.ByteArrayInputStream`，

```java
try (ObjectInputStream ois = new ObjectInputStream(new ByteArrayInputStream(data))) {
    Student receivedStudent = (Student) ois.readObject();
    System.out.println(receivedStudent);
} catch (IOException | ClassNotFoundException e) {
    System.err.println(e.getMessage());
}
```

整个程序打印结果：

```text
rO0ABXNyABNtZS5rYXR5dXNoYS5TdHVkZW501BmG0nv8hr8CAAhMAAdhZGRyZXNzdAASTGphdmEvbGFuZy9TdHJpbmc7TAADYWdldAATTGphdmEvbGFuZy9JbnRlZ2VyO0wACGJpcnRoZGF5dAAZTGphdmEvdGltZS9ab25lZERhdGVUaW1lO0wABmdlbmRlcnEAfgABTAAFZ3JhZGVxAH4AAUwAAmlkdAAQTGphdmEvbGFuZy9Mb25nO0wABG5hbWVxAH4AAUwABnNjaG9vbHEAfgABeHB0ABNUc2luZ2h1YSBVbml2ZXJzaXR5c3IAEWphdmEubGFuZy5JbnRlZ2VyEuKgpPeBhzgCAAFJAAV2YWx1ZXhyABBqYXZhLmxhbmcuTnVtYmVyhqyVHQuU4IsCAAB4cAAAABdzcgANamF2YS50aW1lLlNlcpVdhLobIkiyDAAAeHB3DQYAAAfTAQEMIscgCCB4dAAETWFsZXQAAjIyc3IADmphdmEubGFuZy5Mb25nO4vkkMyPI98CAAFKAAV2YWx1ZXhxAH4ACAAAAAAAAAABdAAHTWF4d2VsbHEAfgAG
Student(id=1, name=Maxwell, age=23, birthday=2003-01-01T12:34:56+08:00, gender=Male, school=Tsinghua University, grade=22, address=Tsinghua University)
```

可以明显看到，使用Java内置的`java.io.Serializable`接口，输出不可读，体积大，跨语言差，但是不需要依赖第三方库

## JSON序列化和反序列化

目前最常见的序列化方式可能就是JSON序列化吧，甚至于我第一次听到序列化这个词，想到的就只有JSON

### Jackson

JSON序列化最常用的是Jackson库，使用时需要引入`com.fasterxml.jackson.core:jackson-databind`：

```xml
<dependency>
    <groupId>com.fasterxml.jackson.core</groupId>
    <artifactId>jackson-databind</artifactId>
    <version>2.19.2</version>
</dependency>
```

使用：

```java
package me.katyusha;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

import java.time.ZonedDateTime;

public class Main {
    public static void main(String[] args) {
        Student student = new Student();
        student.setId(1L);
        student.setName("Maxwell");
        student.setAge(23);
        student.setBirthday(ZonedDateTime.parse("2003-01-01T12:34:56+08:00"));
        student.setGender("Male");
        student.setSchool("Tsinghua University");
        student.setGrade("22");
        student.setAddress("Tsinghua University");

        ObjectMapper mapper = new ObjectMapper();
        mapper.disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        mapper.registerModule(new JavaTimeModule());
        String json = null;
        try {
            json = mapper.writeValueAsString(student);
        } catch (JsonProcessingException e) {
            throw new RuntimeException(e);
        }
        System.out.println(json);

        try {
            Student receivedStudent = mapper.readValue(json, Student.class);
            System.out.println(receivedStudent);
        } catch (JsonProcessingException e) {
            throw new RuntimeException(e);
        }
    }
}
```

程序输出：

```text
{"id":1,"name":"Maxwell","age":23,"birthday":"2003-01-01T12:34:56+08:00","gender":"Male","school":"Tsinghua University","grade":"22","address":"Tsinghua University"}
Student(id=1, name=Maxwell, age=23, birthday=2003-01-01T04:34:56Z, gender=Male, school=Tsinghua University, grade=22, address=Tsinghua University)
```

:::warn

此处需要注意一件事情，Jackson默认是不支持诸如`LocalDateTime`、`ZonedDateTime`这类的`java.time`日期时间的，你需要添加`com.fasterxml.jackson.datatype:jackson-datatype-jsr310`依赖，并对`ObjectMapper`注册`com.fasterxml.jackson.datatype.jsr310.JavaTimeModule`的序列化模块，才能启用对这类时间的序列化

:::

在一些时候，为了正确地表示对象，常常会在序列化后的JSON中添加类型信息，一般是全局配置ObjectMapper，例如在配置Redis序列化和反序列化中，可以在全局配置类中配置ObjectMapper

```java
package me.katyusha.withyou.config;

import com.fasterxml.jackson.annotation.JsonAutoDetect;
import com.fasterxml.jackson.annotation.PropertyAccessor;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.jsontype.BasicPolymorphicTypeValidator;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.serializer.Jackson2JsonRedisSerializer;
import org.springframework.data.redis.serializer.StringRedisSerializer;

@Configuration
public class RedisConfig {

    @Bean
    public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory factory) {
        RedisTemplate<String, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(factory);

        ObjectMapper objectMapper = new ObjectMapper();
        objectMapper.setVisibility(PropertyAccessor.ALL, JsonAutoDetect.Visibility.ANY);
        objectMapper.activateDefaultTyping(
                BasicPolymorphicTypeValidator.builder()
                        .allowIfBaseType(Object.class)
                        .build(),
                ObjectMapper.DefaultTyping.NON_FINAL,
                JsonTypeInfo.As.PROPERTY
        );
        Jackson2JsonRedisSerializer<Object> jacksonSerializer = new Jackson2JsonRedisSerializer<>(objectMapper, Object.class);

        StringRedisSerializer stringSerializer = new StringRedisSerializer();

        template.setKeySerializer(stringSerializer);
        template.setHashKeySerializer(stringSerializer);
        template.setValueSerializer(jacksonSerializer);
        template.setHashValueSerializer(jacksonSerializer);

        template.afterPropertiesSet();
        return template;
    }
}
```

这个配置项中，`objectMapper.setVisibility(PropertyAccessor.ALL, JsonAutoDetect.Visibility.ANY)`指定ObjectMapper将类中所有的成员不管修饰符如何，只要设置了正确的setter、getter、constructor均序列化进去，`activateDefaultTyping`将在序列化时添加类型信息避免类型擦除导致的无法反序列化，参数中，`BasicPolymorphicTypeValidator`配置对于所有Object子类，添加额外的类型信息，`ObjectMapper.DefaultTyping.NON_FINAL`配置虽然对于Object子类添加类型信息，但是忽略所有非final类（例如String、ArrayList），`JsonTypeInfo.As.PROPERTY`配置类型信息将以类属性的方式写入进去（即，在序列化的JSON中，额外地在对象map中创建新的`@class`键，值就是该类的类型，这个看具体使用习惯，我一般喜欢使用这种方式，你也可以使用默认的`JsonTypeInfo.As.WRAPPER_ARRAY`）

``

以这样方式配置的ObjectMapper，在处理我们上述的学生示例中，序列化后的json如下：

```json
{"@class":"me.katyusha.Student","id":1,"name":"Maxwell","age":23,"birthday":"2003-01-01T12:34:56+08:00","gender":"Male","school":"Tsinghua University","grade":"22","address":"Tsinghua University"}
```

### FastJSON

添加依赖：

```xml
<dependency>
    <groupId>com.alibaba</groupId>
    <artifactId>fastjson</artifactId>
    <version>1.2.83</version>
</dependency>
```

通过`com.alibaba.fastjson.JSON.toJSONString()`可以序列化一个对象，通过`com.alibaba.fastjson.JSON.parseObject()`反序列化

```java
package me.katyusha;

import com.alibaba.fastjson.JSON;

import java.time.ZonedDateTime;

public class Main {
    public static void main(String[] args) {
        Student student = new Student();
        student.setId(1L);
        student.setName("Maxwell");
        student.setAge(23);
        student.setBirthday(ZonedDateTime.parse("2003-01-01T12:34:56+08:00"));
        student.setGender("Male");
        student.setSchool("Tsinghua University");
        student.setGrade("22");
        student.setAddress("Tsinghua University");

        System.out.println(JSON.toJSONString(student));

        Student receivedStudent = JSON.parseObject(JSON.toJSONString(student), Student.class);
        System.out.println(receivedStudent);
    }
}
```

输出：

```text
{"address":"Tsinghua University","age":23,"birthday":"2003-01-01T12:34:56+08:00","gender":"Male","grade":"22","id":1,"name":"Maxwell","school":"Tsinghua University"}
Student(id=1, name=Maxwell, age=23, birthday=2003-01-01T12:34:56+08:00, gender=Male, school=Tsinghua University, grade=22, address=Tsinghua University)
```

### FastJSON2

目前，FastJSON已经停止维护，如果你要使用FastJSON，将会自动重定向到FastJSON2

使用方法和FastJSON是一样的，但是FastJSON安全漏洞实在太多了

有关FastJSON反序列化漏洞，请见[https://www.javasec.org/java-vuls/FastJson.html](https://www.javasec.org/java-vuls/FastJson.html)

:::tip

一个经典的FastJSON笑话是：

1+1=？

Jackson用五秒钟后回答了等于2

FastJSON用一秒钟，回答了你的银行卡密码

:::

## XML序列化与反序列化

与JSON相比，XML用的实在是比较少

引入XStream依赖：

```xml
<dependency>
    <groupId>com.thoughtworks.xstream</groupId>
    <artifactId>xstream</artifactId>
    <version>1.4.21</version>
</dependency>
```

示例：

```java
package me.katyusha;

import com.thoughtworks.xstream.XStream;

import java.time.ZonedDateTime;

public class Main {
    public static void main(String[] args) {
        Student student = new Student();
        student.setId(1L);
        student.setName("Maxwell");
        student.setAge(23);
        student.setBirthday(ZonedDateTime.parse("2003-01-01T12:34:56+08:00"));
        student.setGender("Male");
        student.setSchool("Tsinghua University");
        student.setGrade("22");
        student.setAddress("Tsinghua University");

        XStream xstream = new XStream();
        String xml = xstream.toXML(student);
        System.out.println(xml);
        xstream.allowTypes(new Class[]{Student.class});
        Student receivedStudent = (Student) xstream.fromXML(xml);
        System.out.println(receivedStudent);
    }
}
```

注意，反序列化时，需要配置允许反序列化的类型

有关XStream序列化/反序列化，可以详细阅读：

[「Java 开发工具」详细讲解：Xstream 对象转 XML工具](https://juejin.cn/post/7388824612328865818)
