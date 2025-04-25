---
title: DIY一个Markdown页面访问计数器
categories: 项目
tags:
    - Web
    - DIY
    - Markdown
date: 2025-07-22 17:07:12 +0800
updated: 2025-07-22 17:07:12 +0800
---

众所周知，给Markdown页面做访问计数，要么像卜蒜子API这样，直接在显示Markdown的网页上做功夫，要么就是在Markdown中嵌入一张图片，在提供图片的后端进行计数，在图片上显示计数

![效果展示](https://lc-gluttony.s3.amazonaws.com/6Beck3SuJkGW/e5KI7oHaP9A8r41x3FK9XXQQECv5P8LU/Snipaste_2025-07-22_16-56-42.png "效果展示")

我的GitHub主页就是这样的计数方式，然而[glitch最近关停了一些托管的应用](https://blog.glitch.com/post/changes-are-coming-to-glitch/)，该计数器就是托管于glitch，并且我也没找到官方仓库，所以便自己用Springboot做了一个类似的东西

<!-- more -->

## 访问计数

上文提到的两种Markdown页面访问计数的方式，很显然，第一种较为麻烦，例如，在Typora中，就算你开发了一个插件，利用卜蒜子API或者其他的服务进行访问计数，那么你该如何比较方便地共享给其他人甚至是使用其他Markdown软件（例如Obsidian）的用户呢？

我的想法就是第二种，在Markdown中嵌入一个图片资源，用户每次预览Markdown，客户端就会访问一次该图片链接，服务器便记录一次访问，同时将访问计数渲染在图片中，返回给客户端

这种处理方式的典型流程如下：

![流程](https://lc-gluttony.s3.amazonaws.com/6Beck3SuJkGW/CffGHCgRtoRY2si8FOU82OVgWCvRo47S/Snipaste_2025-07-22_21-21-43.png "流程")

用户访问指定资源的计数器图片时，服务器从`redis`中查询计数，若查询到，自增并将数据处理到图片上，返回给客户端

若服务器在`redis`中查询不到用户计数，先从数据库中读取计数，保存到`redis`并自增

服务器定期将`redis`中的计数同步到数据库中

具体实现如下：

```java
package me.katyusha.visitcounter.service;

import me.katyusha.visitcounter.entity.VisitCount;
import me.katyusha.visitcounter.mapper.VisitCountMapper;
import org.redisson.api.RLock;
import org.redisson.api.RedissonClient;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.util.*;
import java.util.concurrent.TimeUnit;

@Service
public class VisitCountService {

    private final VisitCountMapper visitCountMapper;
    private final RedisTemplate<String, Object> redisTemplate;
    private final RedisScript<Long> atomicIncrExpireScript;
    private final RedissonClient redissonClient;

    private static final String REDIS_COUNT_PREFIX = "count:page:";
    private static final String REDIS_LOCK_PREFIX = "lock:page:";
    private static final long REDIS_COUNT_TTL = 60 * 60;
    private static final long SYNC_INTERVAL = 5 * 60;
    private static final long LOCK_WAIT_TIME = 3;
    private static final long LOCK_LEASE_TIME = 5;

    public VisitCountService(VisitCountMapper visitCountMapper, RedisTemplate<String, Object> redisTemplate, RedisScript<Long> atomicIncrExpireScript, RedissonClient redissonClient) {
        this.visitCountMapper = visitCountMapper;
        this.redisTemplate = redisTemplate;
        this.atomicIncrExpireScript = atomicIncrExpireScript;
        this.redissonClient = redissonClient;
    }

    private Long atomicIncrExpire(String pageKey, long expiration) {
        List<String> keys = Collections.singletonList(pageKey);
        Object[] args = {expiration};
        Long result = redisTemplate.execute(atomicIncrExpireScript, keys, args);
        return result == -1 ? null : result;
    }

    private Long handleFirstVisit(String pageKey) {
        String redisLockKey = REDIS_LOCK_PREFIX + pageKey;
        String redisCountKey = REDIS_COUNT_PREFIX + pageKey;
        RLock lock = redissonClient.getLock(redisLockKey);

        try {
            // 保证同一时刻同一资源，数据库只能被一个并发流访问
            if (lock.tryLock(LOCK_WAIT_TIME, LOCK_LEASE_TIME, TimeUnit.SECONDS)) {
                try {
                    // 二次验证，如果在之前已有并发流将数据从数据库缓存到redis，那么直接返回自增后的数据
                    Object cachedCount = redisTemplate.opsForValue().get(redisCountKey);
                    if (cachedCount != null) {
                        Long count = ((Number) cachedCount).longValue() + 1;
                        redisTemplate.opsForValue().set(redisCountKey, count, REDIS_COUNT_TTL, TimeUnit.SECONDS);
                        return count;
                    }

                    // 从数据库中查找
                    VisitCount visitCount = visitCountMapper.findByPageKey(pageKey);
                    Long count = Optional.ofNullable(visitCount)
                            .map(VisitCount::getCount)
                            .orElseGet(() -> {
                                // 在数据库也找不到，插入新的数据
                                visitCountMapper.insertZero(pageKey);
                                return 0L;
                            });

                    // 保存到redis并自增返回
                    Long finalCount = count + 1;
                    redisTemplate.opsForValue().set(redisCountKey, finalCount, REDIS_COUNT_TTL, TimeUnit.SECONDS);
                    return finalCount;
                } finally {
                    lock.unlock();
                }
            } else {
                Thread.sleep(50);
                // 休息50毫秒后再次尝试获取数据库访问权
                return handleFirstVisit(pageKey);

            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return 1L;
    }

    // 计数自增的访问
    public Long incrementVisit(String pageKey) {
        String redisCountKey = REDIS_COUNT_PREFIX + pageKey;
        // 从redis中自增计数，如果找不到键值，返回null
        Long count = atomicIncrExpire(redisCountKey, REDIS_COUNT_TTL);
        if (count == null) {
            // redis中找不到，前往数据库查询
            return handleFirstVisit(pageKey);
        }
        return count;
    }

    // 定期同步redis到数据库
    @Scheduled(fixedDelay = SYNC_INTERVAL, timeUnit = TimeUnit.SECONDS)
    public void syncToDatabase() {
        String redisAllKey = REDIS_COUNT_PREFIX + "*";
        Set<String> redisKeys = redisTemplate.keys(redisAllKey);
        List<VisitCount> updateList = new ArrayList<>();
        for (String redisKey : redisKeys) {
            Object redisValue = redisTemplate.opsForValue().get(redisKey);
            if (redisValue != null) {
                VisitCount visitCount = new VisitCount();
                visitCount.setPageKey(redisKey.substring(REDIS_COUNT_PREFIX.length()));
                visitCount.setCount(((Number) redisValue).longValue());
                updateList.add(visitCount);
            }
        }
        visitCountMapper.batchUpdate(updateList);
    }
}

```

数据库建表：

```sql
DROP TABLE IF EXISTS visit_count;
CREATE TABLE visit_count (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    page_key VARCHAR(255) NOT NULL,
    count BIGINT NOT NULL DEFAULT 0,
    UNIQUE KEY uk_page_key (page_key)
);
```

`Mybatis`数据访问层接口：

```java
package me.katyusha.visitcounter.mapper;

import me.katyusha.visitcounter.entity.VisitCount;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;

@Mapper
public interface VisitCountMapper {
    VisitCount findByPageKey(@Param("pageKey") String pageKey);
    int insert(@Param("visitCount") VisitCount visitCount);
    int insertZero(@Param("pageKey") String pageKey);
    int batchUpdate(List<VisitCount> updateList);
}
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE mapper
        PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"
        "http://mybatis.org/dtd/mybatis-3-mapper.dtd">
<mapper namespace="me.katyusha.visitcounter.mapper.VisitCountMapper">

    <resultMap id="VisitCountResultMap" type="me.katyusha.visitcounter.entity.VisitCount">
        <id property="id" column="id"/>
        <result property="pageKey" column="page_key"/>
        <result property="count" column="count"/>
    </resultMap>

    <select id="findByPageKey" resultMap="VisitCountResultMap">
        SELECT * FROM visit_count
        WHERE page_key = #{pageKey}
    </select>

    <insert id="insert" keyProperty="id" useGeneratedKeys="true">
        INSERT INTO visit_count (page_key, count)
        VALUES (#{visitCount.pageKey}, #{visitCount.count})
    </insert>

    <insert id="insertZero">
        INSERT INTO visit_count (page_key, count)
        VALUES (#{pageKey}, 0)
    </insert>

    <update id="batchUpdate" parameterType="list">
        <if test="list != null and list.size() > 0">
            UPDATE visit_count SET
            count = CASE page_key
            <foreach collection="list" item="item">
                WHEN #{item.pageKey} THEN #{item.count}
            </foreach>
            END
            WHERE page_key IN
            <foreach collection="list" item="item" open="(" close=")" separator=",">
                #{item.pageKey}
            </foreach>
        </if>
    </update>

</mapper>

```

`redis`的原子化判断键值并自增脚本：

```lua
local key = KEYS[1]
local expire_seconds = tonumber(ARGV[1])

if redis.call('EXISTS', key) == 0 then
    return -1
else
    local new_value = redis.call('INCR', key)
    redis.call('EXPIRE', key, expire_seconds)
    return new_value
end

```

`redis`配置：

```java
package me.katyusha.visitcounter.config;

import org.springframework.cache.annotation.EnableCaching;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.data.redis.serializer.GenericJackson2JsonRedisSerializer;
import org.springframework.data.redis.serializer.StringRedisSerializer;

@Configuration
@EnableCaching
public class RedisConfig {

    @Bean
    public RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory connectionFactory) {
        RedisTemplate<String, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(connectionFactory);
        template.setKeySerializer(new StringRedisSerializer());
        template.setValueSerializer(new GenericJackson2JsonRedisSerializer());
        return template;
    }

    @Bean
    public RedisScript<Long> incrementAndExpireScript() {
        DefaultRedisScript<Long> script = new DefaultRedisScript<>();
        script.setLocation(new ClassPathResource("scripts/redis-atomic-incr-expire.lua"));
        script.setResultType(Long.class);
        return script;
    }
}
```

控制器层：

```java
package me.katyusha.visitcounter.controller;

import me.katyusha.visitcounter.service.SVGCounterService;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.concurrent.TimeUnit;

@RestController
@RequestMapping("/count/svg/")
public class SVGCounterController {

    private final SVGCounterService svgCounterService;

    public SVGCounterController(SVGCounterService svgCounterService) {
        this.svgCounterService = svgCounterService;
    }

    // 设置返回MimeType，SVG图片为image/svg+xml
    @GetMapping(value = "/{pageKey}/{template}.svg", produces = "image/svg+xml")
    public ResponseEntity<String> getSVGCounter(@PathVariable("pageKey") String pageKey, @PathVariable("template") String template) {
        return ResponseEntity.ok()
                // 设置Cache-Control响应头
                .header("Cache-Control", "max-age=0, no-cache, no-store, must-revalidate")
                .body(svgCounterService.getSVGCounter(pageKey, template));
    }
}

```

注意，GitHub等网站会对Markdown文件中的图片进行缓存，所以如果不设置图片的`Cache-Control`响应头，那么再次访问时，GitHub将不再请求源服务器，解决方案是将响应头的`Cache-Control`设置为`max-age=0, no-cache, no-store, must-revalidate`

## 数据显示

一般而言访问计数器的图片结构过于简单，例如我最喜欢的[for-the-badge](https://forthebadge.com/)风格，仅仅定义了两个矩形，并且在矩形上显示几个字

在这种情况下，使用SVG而不是其他格式例如PNG、JPEG拥有以下多个优势：

- 构造简单，只需要规定哪个地方会出现什么文字、什么图形

- 文件极小，质量极高

SVG图像使用XML进行定义，例如一个典型的for-the-badge风格的图像的定义如下所示：

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:th="http://www.thymeleaf.org"
     width="200" height="30" viewBox="0 0 200 30">
    <rect x="0%" y="0%" width="50%" height="100%" fill="#21262d"/>
    <rect x="50%" y="0%" width="50%" height="100%" fill="#161b22"/>
    <text x="25%" y="50%" font-size="14" font-family="Ubuntu Mono" fill="#7ce38b" text-anchor="middle" dominant-baseline="middle" font-weight="bold" letter-spacing="3">
        VISITORS
    </text>
    <text x="75%" y="50%" font-size="14" font-family="Ubuntu Mono" fill="#7ce38b" text-anchor="middle" dominant-baseline="middle" font-weight="bold" letter-spacing="3">
        01234567
    </text>
</svg>
```

在这里我们定义了这张图片由两个`rect`组成，二者占据了画板的左半部分和右半部分，颜色分别为`#21262d`和`#161b22`，有两个`text`，分别为画板的左1/4和右1/4

如果要想在SVG上显示计数也很简单，直接以类似的方式定义一个SVG图片模板，随后在`text`区域使用`thymeleaf`插入一行文本即可

在Springboot中的处理如下所示：

```java
public String getSVGCounter(String pageKey, String template) {
    Long count = visitCountService.incrementVisit(pageKey);
    Context context = new Context();
    context.setVariable("count", count);
    return templateEngine.process(template, context);
}
```

同时，`thymeleaf`默认是不支持SVG模板的，所以需要配置一下：


```java
@Configuration
public class ThymeleafSVGConfig {

    @Bean
    public SpringResourceTemplateResolver templateResolver() {
        SpringResourceTemplateResolver templateResolver = new SpringResourceTemplateResolver();
        templateResolver.setPrefix("classpath:templates/");
        templateResolver.setSuffix(".svg");
        templateResolver.setTemplateMode(TemplateMode.XML);
        templateResolver.setCharacterEncoding("UTF-8");
        templateResolver.setOrder(1);
        templateResolver.setCheckExistence(true);
        return templateResolver;
    }
}
```

配置`thymeleaf`在`classpath:templates`下寻找模板文件，模板以.svg结尾，`templateEngine`在处理时不需要指定文件后缀

## 总结

至此，你便DIY了一个高性能的Markdown访问计数器，如果你用[我的仓库](https://github.com/Katyusha0x26d/VisitCounter)直接部署了一个，那么建议共享出来供大家使用哦！
