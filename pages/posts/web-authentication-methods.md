---
title: Web后端服务身份认证方案汇总与个人思考
categories: 认证授权
tags:
    - Web
    - 认证
    - 系统设计
date: 2025-07-13 01:14:40 +0800
updated: 2025-07-13 01:14:40 +0800
---

最近在编写一个Spring Boot后端项目，需要处理用户身份认证，遂撰写此文总结一下常见的Web后端服务身份认证方案。

## HTTP基本验证

直接设置HTTP请求头`Authorization`，在其中插入加密的密码，例如：

```text
Authorization: Basic dXNlcm5hbWU6cGFzc3dvcmQ=
```

显然，`Basic`后面一串是Base64加密过的密码

优点：无状态，实现简单，后端对请求头解密，查询数据库验证即可判断用户请求是否合法

缺点也很明显，对密码没有任何保护，如果没有使用加密或者使用了弱加密，又或者加密密钥泄露，问题就大了

详细参考：[IETF RFC 7617, The 'Basic' HTTP Authentication Scheme](https://datatracker.ietf.org/doc/html/rfc7617)

## Cookie-Session身份认证

这应该是目前最常见的身份认证方案了吧，用户登录后，服务器验证身份并保存登录状态在服务器端的Session中，同时将Session ID放入Cookie发送给客户端。客户端在后续请求中自动带上该Cookie，服务器根据Cookie中的Session ID查询对应的Session，验证用户身份

Spring Boot后端示例：

```java
@RestController
public class UserAuthController {

    @PostMapping("/login")
    public ResponseEntity<String> login(@RequestParam String username, @RequestParam String password, HttpSession session) {
        // 验证用户名密码示例
        if ("user".equals(username) && "password".equals(password)) {
            session.setAttribute("user", username);  // 保存登录状态
            return ResponseEntity.ok("登录成功");
        }
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body("登录失败");
    }

    @GetMapping("/profile")
    public ResponseEntity<String> profile(HttpSession session) {
        String user = (String) session.getAttribute("user");
        if (user != null) {
            return ResponseEntity.ok("当前用户：" + user);
        }
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body("未登录");
    }

    @PostMapping("/logout")
    public ResponseEntity<String> logout(HttpSession session) {
        session.invalidate(); // 注销Session
        return ResponseEntity.ok("已退出登录");
    }
}
```

POST /login接口并带上正确的参数时，响应头为：`Set-Cookie: JSESSIONID=8A98AA17F3EDAF7E06D1363466EF69E4; Path=/; HttpOnly; Secure; SameSite=Strict`，后续请求浏览器将会自动带上这个cookie

优点：实现简单，技术成熟，与前述基本认证相比更安全

缺点：有状态，容易受到CSRF攻击，在多台机器之间session无法同步

改进多台服务器之间的session同步问题：使用独立出来的、所有机器都可以访问的Redis缓存！在Spring Boot上，可以直接使用Spring Session改进

那么，又一个问题来了，在客户端禁用Cookie的情况下如何处理session？

现代的很多网站不仅仅使用cookie存储会话数据，还进行跨站信息共享等，对于用户隐私是极大的威胁，因此一些浏览器或者浏览器插件可以禁用cookie，这种情况下，可以考虑在后续请求中，将会话ID放置于URL参数中解决

有关前端防止CSRF攻击，请参考：[前端安全系列（二）：如何防止CSRF攻击？](https://tech.meituan.com/2018/10/11/fe-security-csrf.html)

## token身份认证

token身份认证与上述Cookie-Session身份认证思想类似，区别在于服务器将会话ID以其它方式传输或者存储，例如将会话ID放置于请求体中返回给前端，随后前端将会话ID存储于localStorage，在后续请求中手动带上

一种token身份认证的实现方案如下，为了解决分布式问题，服务端将会话ID存储于redis中：

引入依赖：

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-data-redis</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-security</artifactId>
</dependency>

```

```java
@Service
public class TokenService {

    private final String TOKEN_PREFIX = "AUTH_TOKEN:";
    @Autowired
    private StringRedisTemplate redisTemplate;

    // 生成Token并存储用户信息，设置过期时间（如30分钟）
    public String createToken(String username) {
        String token = UUID.randomUUID().toString();
        redisTemplate.opsForValue().set(TOKEN_PREFIX + token, username, 30, TimeUnit.MINUTES);
        return token;
    }

    // 根据Token取出用户名
    public String getUsername(String token) {
        return redisTemplate.opsForValue().get(TOKEN_PREFIX + token);
    }

    // 删除Token
    public void deleteToken(String token) {
        redisTemplate.delete(TOKEN_PREFIX + token);
    }

    // 验证Token（存在且未过期）
    public boolean isValid(String token) {
        return redisTemplate.hasKey(TOKEN_PREFIX + token);
    }
}

```

身份认证过滤器，直接使用Spring Security演示

```java
@Component
public class TokenAuthenticationFilter extends OncePerRequestFilter {
    @Autowired
    private TokenService tokenService;

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String token = request.getHeader("Authorization");
        if (token != null && token.startsWith("Bearer ")) {
            token = token.substring(7);
            if (tokenService.isValid(token)) {
                String username = tokenService.getUsername(token);
                // 这里简单演示，设置认证上下文为通过身份校验
                UsernamePasswordAuthenticationToken auth =
                    new UsernamePasswordAuthenticationToken(username, null, new ArrayList<>());
                SecurityContextHolder.getContext().setAuthentication(auth);
            }
        }
        filterChain.doFilter(request, response);
    }
}

```

Spring Security配置：

```java
@Configuration
@EnableWebSecurity
public class SecurityConfig extends WebSecurityConfigurerAdapter {
    @Autowired
    private TokenAuthenticationFilter tokenAuthenticationFilter;

    @Override
    protected void configure(HttpSecurity http) throws Exception {
        http.csrf().disable()
            .authorizeRequests()
            .antMatchers("/login").permitAll()
            .anyRequest().authenticated();
        http.addFilterBefore(tokenAuthenticationFilter, UsernamePasswordAuthenticationFilter.class);
    }
}

```

控制器层：

```java
@RestController
public class AuthController {
    @Autowired
    private TokenService tokenService;

    @PostMapping("/login")
    public ResponseEntity<?> login(@RequestParam String username, @RequestParam String password) {
        // 这里简单模拟验证用户名密码，实际应查数据库或其他用户存储
        if ("user".equals(username) && "pass".equals(password)) {
            String token = tokenService.createToken(username);
            Map<String, String> result = new HashMap<>();
            result.put("token", token);
            return ResponseEntity.ok(result);
        } else {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body("Invalid credentials");
        }
    }

    // 可选登出，删除Token
    @PostMapping("/logout")
    public ResponseEntity<?> logout(@RequestHeader("Authorization") String auth) {
        if (auth != null && auth.startsWith("Bearer ")) {
            String token = auth.substring(7);
            tokenService.deleteToken(token);
        }
        return ResponseEntity.ok("Logged out");
    }
}

```

前端AXIOS示例：

```typescript
import axios from "axios";

const api = axios.create({
  baseURL: "http://localhost:8080",
});

// 登录函数
export async function login(username: string, password: string): Promise<string> {
  const response = await api.post("/login", null, {
    params: { username, password },
  });
  return response.data.token;
}

// 设置请求拦截器，自动带上Token
export function setAuthToken(token: string | null) {
  if (token) {
    api.defaults.headers.common["Authorization"] = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common["Authorization"];
  }
}

// 示例调用，登录并请求用户信息
async function example() {
  try {
    const token = await login("user", "pass");
    console.log("Token:", token);

    setAuthToken(token);

    // 带Token请求受保护接口
    const userInfo = await api.get("/user");
    console.log("User info:", userInfo.data);
  } catch (err) {
    console.error("登录或请求失败", err);
  }
}

// 调用示例
example();

```

存储于localStorage而不是Cookie的最大优势在于避免CSRF攻击

## JWT身份认证

JWT即JSON Web Token，本质上是升级版+阉割版的token身份认证，具体流程为：

1. 客户端请求登录接口，带上正确的用户凭据
2. 服务端验证凭据，将一个“证明文件”颁发给用户
3. 这个“证明文件”的颁发方案：一般对用户ID等重要信息使用服务端的私钥签名，指定过期时间并转为JWT格式
4. 后续请求中，客户端带上JWT，服务端验证签名和过期时间，并从“证明文件”中取出之前指定的用户ID

注意，上述操作不涉及加密部分，JWT也都是明文的，例如：

```text
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWUsImlhdCI6MTUxNjIzOTAyMn0.KMUFsIDTnFmyG3nMiGM6H9FNFUROf3wh7SmqJp-QV30
```

将payload部分转为JSON格式：

```json
{
  "sub": "1234567890",
  "name": "John Doe",
  "admin": true,
  "iat": 1516239022
}
```

有一些读者可能会奇怪，JWT是明文的，又如何保证JWT不被客户端篡改？

答案是服务器中对比JWT签名即可，非对称加密中，私钥签名后使用公钥只能验证签名，不能重新签名

JWT实现示例，首先引入依赖：

```xml
<dependency>
    <groupId>io.jsonwebtoken</groupId>
    <artifactId>jjwt</artifactId>
    <version>0.12.6</version>
</dependency>
```

编写JWT工具类：

```java
import io.jsonwebtoken.*;
import io.jsonwebtoken.security.Keys;

import javax.crypto.SecretKey;
import java.util.Date;

public class JwtUtil {

    // 生成一个安全的SecretKey（同一应用应存储复用）
    private static final SecretKey SECRET_KEY = Keys.secretKeyFor(SignatureAlgorithm.HS256);

    // 过期时间 (例如1小时)
    private static final long EXPIRATION_MILLIS = 3600000;

    // 生成JWT Token
    public static String generateToken(String username) {
        long nowMillis = System.currentTimeMillis();

        return Jwts.builder()
                .setSubject(username)               // JWT主题，一般放用户名或用户ID
                .setIssuedAt(new Date(nowMillis))  // 签发时间
                .setExpiration(new Date(nowMillis + EXPIRATION_MILLIS)) // 过期时间
                .signWith(SECRET_KEY)               // 签名算法和密钥
                .compact();
    }

    // 解析并验证JWT Token，返回主题（用户名）
    public static String validateTokenAndGetUsername(String token) {
        try {
            Jws<Claims> jwsClaims = Jwts.parserBuilder()
                    .setSigningKey(SECRET_KEY)
                    .build()
                    .parseClaimsJws(token);

            return jwsClaims.getBody().getSubject();

        } catch (JwtException e) {
            // 如果token无效、过期或签名错误则抛异常，可捕获做相应处理
            throw new RuntimeException("Invalid or expired JWT token");
        }
    }
}

```

控制器层：

```java
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

@RestController
public class AuthController {

    @PostMapping("/login")
    public Map<String, String> login(@RequestParam String username, @RequestParam String password) {
        // 模拟验证用户名密码
        if ("user".equals(username) && "pass".equals(password)) {
            String token = JwtUtil.generateToken(username);
            Map<String, String> result = new HashMap<>();
            result.put("token", token);
            return result;
        } else {
            throw new RuntimeException("Invalid credentials");
        }
    }

    @GetMapping("/protected")
    public String protectedResource(@RequestHeader("Authorization") String authHeader) {
        // 通过Authorization头获取token（格式: Bearer eyJ...）
        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            throw new RuntimeException("Missing or invalid Authorization header");
        }
        String token = authHeader.substring(7);
        String username = JwtUtil.validateTokenAndGetUsername(token);

        return "Hello, " + username + ". This is a protected resource.";
    }
}

```

JWT方案的优点很显然，身份认证服务无状态，服务器不需要保存用户会话信息

但是缺点也很多，不支持注销会话，只要JWT还在有效期内就可以通过认证

解决方案一般有：

1. 对于修改密码时的注销问题，可以使用用户密码的hash（因为一般服务器不存储明文密码）作为JWT的签名
2. 对于单独注销会话的问题，可以在数据库中保存一个会话版本号，用户需要注销时，自增该版本号，在后续认证时，也会验证版本号是否正确

然而，即使做出上述修改，仍然无法解决一些时候，用户有很多会话，但是只想注销其中一个会话的情景，这个无解，毕竟JWT无状态，服务端并不存储会话信息，如果为了安全性想要支持该过程，可以考虑转为使用前面的基本TOKEN身份认证

## 其它身份认证方案

此外也有OAuth、TOTP等，无非是前文的扩展，先鸽了，等后面单独出几篇文章详细说明
