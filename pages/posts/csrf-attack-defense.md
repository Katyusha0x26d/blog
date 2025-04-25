---
title: CSRF攻击原理与防御策略深度剖析
categories: 认证授权
tags:
    - Web
    - 安全
    - CSRF
    - 系统设计
date: 2025-06-03 14:30:00 +0800
updated: 2025-06-03 14:30:00 +0800
---

CSRF（Cross-Site Request Forgery，跨站请求伪造）是Web应用中一种常见的安全漏洞，攻击者通过伪造用户请求来执行未经授权的操作。本文将详细剖析CSRF攻击的原理、案例，并提供多种防御策略的实现方案。

<!-- more -->

## CSRF攻击原理

CSRF攻击的核心在于利用浏览器自动携带Cookie的特性。当用户在A网站登录后，浏览器会保存A网站的会话Cookie，此时如果用户访问恶意网站B，B网站可以构造向A网站发送的请求，浏览器会自动带上A网站的Cookie，从而实现以用户身份执行操作。

### 攻击流程示例

假设某银行网站的转账接口如下：

```http
POST /transfer HTTP/1.1
Host: bank.example.com
Cookie: session=abc123

amount=1000&to=attacker
```

攻击流程：

1. 用户登录银行网站，获得会话Cookie
2. 用户访问恶意网站evil.com
3. evil.com页面包含如下代码：

```html
<form id="csrf-form" action="https://bank.example.com/transfer" method="POST">
    <input type="hidden" name="amount" value="10000">
    <input type="hidden" name="to" value="attacker-account">
</form>
<script>
    document.getElementById('csrf-form').submit();
</script>
```

4. 表单自动提交，浏览器自动带上银行网站的Cookie
5. 银行服务器验证Cookie有效，执行转账操作

## 典型CSRF攻击场景

### GET请求型CSRF

最简单的CSRF攻击形式，通过图片标签、链接等发起GET请求：

```html
<!-- 恶意网站中的代码 -->
<img src="https://bank.example.com/transfer?amount=1000&to=attacker" />
```

用户浏览恶意页面时，浏览器会自动请求该URL，如果银行使用GET请求处理转账（严重的设计缺陷），攻击就会成功。

::: warn

由于在大多数浏览器中，Cookie的SameSite属性设置为Lax，也就是对于POST请求，不会自动携带跨站Cookie，但是在GET请求，浏览器会自动携带跨站Cookie。所以执行类似于表单提交等操作，请不要使用GET请求。

:::

### POST请求型CSRF

通过自动提交的表单发起POST请求，如上面银行转账的例子。更隐蔽的方式是使用iframe：

```html
<iframe style="display:none" name="csrf-frame"></iframe>
<form method="POST" action="https://victim.com/api/action" target="csrf-frame" id="csrf-form">
    <input type="hidden" name="action" value="delete_account">
</form>
<script>document.getElementById("csrf-form").submit();</script>
```

### JSON请求型CSRF

现代Web应用经常使用JSON格式的API，攻击者可以通过特殊构造的表单发送JSON数据：

```html
<form id="csrf-form" enctype="text/plain" action="https://api.example.com/user/delete" method="POST">
    <input name='{"id":123,"ignore":"' value='"}'>
</form>
```

提交后会发送：`{"id":123,"ignore":"="}`，某些宽松的JSON解析器可能会接受这种格式。

## CSRF防御策略

### CSRF Token防御

这是最常用也是最有效的防御方式，服务器生成随机token，客户端请求时必须携带正确的token。

Spring Boot实现示例：

```java
@Component
public class CsrfTokenFilter extends OncePerRequestFilter {

    private static final String CSRF_TOKEN_ATTR = "CSRF_TOKEN";
    private static final String CSRF_TOKEN_HEADER = "X-CSRF-Token";

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {

        HttpSession session = request.getSession();

        // GET请求时生成token
        if ("GET".equals(request.getMethod())) {
            String token = (String) session.getAttribute(CSRF_TOKEN_ATTR);
            if (token == null) {
                token = UUID.randomUUID().toString();
                session.setAttribute(CSRF_TOKEN_ATTR, token);
            }
            request.setAttribute(CSRF_TOKEN_ATTR, token);
        }
        // POST/PUT/DELETE请求时验证token
        else if (!"OPTIONS".equals(request.getMethod())) {
            String sessionToken = (String) session.getAttribute(CSRF_TOKEN_ATTR);
            String requestToken = request.getHeader(CSRF_TOKEN_HEADER);

            if (requestToken == null) {
                requestToken = request.getParameter("_csrf");
            }

            if (sessionToken == null || !sessionToken.equals(requestToken)) {
                response.sendError(HttpServletResponse.SC_FORBIDDEN, "Invalid CSRF Token");
                return;
            }
        }

        filterChain.doFilter(request, response);
    }
}
```

前端Vue示例：

```javascript
// 获取CSRF Token
async function getCsrfToken() {
    const response = await fetch('/api/csrf-token');
    const data = await response.json();
    return data.token;
}

// 发送请求时携带Token
async function makeRequest(url, data) {
    const csrfToken = await getCsrfToken();

    return fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken
        },
        body: JSON.stringify(data)
    });
}
```

### Double Submit Cookie防御

将CSRF Token同时存储在Cookie和请求参数中，服务器验证两者是否一致：

```java
@Component
public class DoubleSubmitCookieFilter extends OncePerRequestFilter {

    private static final String CSRF_COOKIE_NAME = "XSRF-TOKEN";
    private static final String CSRF_HEADER_NAME = "X-XSRF-TOKEN";

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {

        // 为GET请求设置Cookie
        if ("GET".equals(request.getMethod())) {
            Cookie[] cookies = request.getCookies();
            boolean hasToken = false;

            if (cookies != null) {
                for (Cookie cookie : cookies) {
                    if (CSRF_COOKIE_NAME.equals(cookie.getName())) {
                        hasToken = true;
                        break;
                    }
                }
            }

            if (!hasToken) {
                String token = UUID.randomUUID().toString();
                Cookie csrfCookie = new Cookie(CSRF_COOKIE_NAME, token);
                csrfCookie.setHttpOnly(false); // JavaScript需要读取
                csrfCookie.setPath("/");
                response.addCookie(csrfCookie);
            }
        }
        // 验证POST请求
        else if (!"OPTIONS".equals(request.getMethod())) {
            String cookieToken = null;
            Cookie[] cookies = request.getCookies();

            if (cookies != null) {
                for (Cookie cookie : cookies) {
                    if (CSRF_COOKIE_NAME.equals(cookie.getName())) {
                        cookieToken = cookie.getValue();
                        break;
                    }
                }
            }

            String headerToken = request.getHeader(CSRF_HEADER_NAME);

            if (cookieToken == null || !cookieToken.equals(headerToken)) {
                response.sendError(HttpServletResponse.SC_FORBIDDEN, "CSRF token validation failed");
                return;
            }
        }

        filterChain.doFilter(request, response);
    }
}
```

### SameSite Cookie属性

::: info

在早期互联网，CSRF攻击影响深远，但是[从2020年5月，Chrome 80中，Cookie的SameSite属性默认被定义为Lax](https://developers.google.com/search/blog/2020/01/get-ready-for-new-samesitenone-secure?hl=zh-cn)，这一操作解决了绝大多数未经修复的CSRF漏洞

:::

通过设置Cookie的SameSite属性，限制第三方网站携带Cookie：

```java
@Configuration
public class SessionConfig {

    @Bean
    public ServletContextInitializer servletContextInitializer() {
        return servletContext -> {
            SessionCookieConfig sessionCookieConfig = servletContext.getSessionCookieConfig();
            sessionCookieConfig.setHttpOnly(true);
            sessionCookieConfig.setSecure(true); // 仅HTTPS
            // 设置SameSite属性
            sessionCookieConfig.setComment("SameSite=Strict");
        };
    }
}

// Spring Boot 2.6+ 可以直接配置
// application.yml
// server:
//   servlet:
//     session:
//       cookie:
//         same-site: strict
```

SameSite有三个值：
- **Strict**：完全禁止第三方Cookie，跨站点时不会发送Cookie
- **Lax**：大多数情况不发送，但导航到目标网址的GET请求除外
- **None**：不限制（需要同时设置Secure属性）

### Referer/Origin验证

验证请求的来源是否合法：

```java
@Component
public class RefererCheckFilter extends OncePerRequestFilter {

    @Value("${app.allowed-origins}")
    private List<String> allowedOrigins;

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {

        // 仅检查状态改变的请求
        if (!"GET".equals(request.getMethod()) && !"OPTIONS".equals(request.getMethod())) {
            String referer = request.getHeader("Referer");
            String origin = request.getHeader("Origin");

            boolean isValid = false;

            // 优先检查Origin
            if (origin != null) {
                isValid = allowedOrigins.stream().anyMatch(origin::startsWith);
            }
            // Origin不存在时检查Referer
            else if (referer != null) {
                isValid = allowedOrigins.stream().anyMatch(referer::startsWith);
            }

            if (!isValid) {
                response.sendError(HttpServletResponse.SC_FORBIDDEN, "Invalid request origin");
                return;
            }
        }

        filterChain.doFilter(request, response);
    }
}
```

### 验证码防御

对于敏感操作，要求用户输入验证码：

```java
@RestController
@RequestMapping("/api")
public class TransferController {

    @Autowired
    private CaptchaService captchaService;

    @PostMapping("/transfer")
    public ResponseEntity<?> transfer(@RequestBody TransferRequest request,
                                     @RequestParam String captcha,
                                     HttpSession session) {

        // 验证验证码
        String sessionCaptcha = (String) session.getAttribute("CAPTCHA");
        if (sessionCaptcha == null || !sessionCaptcha.equalsIgnoreCase(captcha)) {
            return ResponseEntity.badRequest().body("验证码错误");
        }

        // 验证码使用后立即删除
        session.removeAttribute("CAPTCHA");

        // 执行转账逻辑
        // ...

        return ResponseEntity.ok("转账成功");
    }

    @GetMapping("/captcha")
    public void getCaptcha(HttpServletResponse response, HttpSession session) throws IOException {
        // 生成验证码
        String captchaText = captchaService.generateText();
        BufferedImage captchaImage = captchaService.generateImage(captchaText);

        // 保存到Session
        session.setAttribute("CAPTCHA", captchaText);

        // 输出图片
        response.setContentType("image/png");
        ImageIO.write(captchaImage, "PNG", response.getOutputStream());
    }
}
```

### 使用localStorage存储token

常规场景下，会话信息被存储于Cookie，浏览器会自动携带Cookie，但是我们可以将会话信息存储于localStorage中，这样会话不会自动被携带上去。

将会话信息存储于localStorage还有一个好处是，有一些移动端应用，没有完整的Cookie功能，如果使用localStorage就可以弥补这方面的缺陷

## Spring Security集成方案

Spring Security提供了完善的CSRF防护机制：

```java
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            // 启用CSRF保护
            .csrf(csrf -> csrf
                .csrfTokenRepository(CookieCsrfTokenRepository.withHttpOnlyFalse())
                // 忽略特定路径
                .ignoringAntMatchers("/api/public/**")
                // 自定义失败处理
                .accessDeniedHandler((request, response, ex) -> {
                    response.setStatus(HttpStatus.FORBIDDEN.value());
                    response.getWriter().write("CSRF Token验证失败");
                })
            )
            .authorizeHttpRequests(authz -> authz
                .antMatchers("/api/public/**").permitAll()
                .anyRequest().authenticated()
            );

        return http.build();
    }

    // 自定义Token存储
    @Bean
    public CsrfTokenRepository csrfTokenRepository() {
        HttpSessionCsrfTokenRepository repository = new HttpSessionCsrfTokenRepository();
        repository.setParameterName("_csrf");
        repository.setHeaderName("X-CSRF-TOKEN");
        return repository;
    }
}
```

前端集成：

```javascript
// 使用axios拦截器自动添加CSRF Token
axios.interceptors.request.use(config => {
    // 从Cookie中读取token（Spring Security默认名称）
    const token = document.cookie
        .split('; ')
        .find(row => row.startsWith('XSRF-TOKEN='))
        ?.split('=')[1];

    if (token) {
        config.headers['X-XSRF-TOKEN'] = decodeURIComponent(token);
    }

    return config;
});
```

## 测试CSRF防护

编写测试用例验证CSRF防护是否有效：

```java
@SpringBootTest
@AutoConfigureMockMvc
public class CsrfProtectionTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    public void testWithoutCsrfToken() throws Exception {
        // 没有CSRF Token的请求应该被拒绝
        mockMvc.perform(post("/api/transfer")
                .param("amount", "1000")
                .param("to", "attacker"))
                .andExpect(status().isForbidden());
    }

    @Test
    public void testWithValidCsrfToken() throws Exception {
        // 先获取CSRF Token
        MvcResult result = mockMvc.perform(get("/api/csrf"))
                .andExpect(status().isOk())
                .andReturn();

        String token = result.getResponse().getContentAsString();

        // 使用有效Token的请求应该成功
        mockMvc.perform(post("/api/transfer")
                .header("X-CSRF-Token", token)
                .param("amount", "1000")
                .param("to", "recipient"))
                .andExpect(status().isOk());
    }

    @Test
    public void testCsrfTokenReuse() throws Exception {
        // 获取Token
        MvcResult result = mockMvc.perform(get("/api/csrf"))
                .andReturn();
        String token = result.getResponse().getContentAsString();

        // 第一次使用
        mockMvc.perform(post("/api/sensitive-action")
                .header("X-CSRF-Token", token))
                .andExpect(status().isOk());

        // Token不应该被重复使用（对于一次性Token的情况）
        mockMvc.perform(post("/api/sensitive-action")
                .header("X-CSRF-Token", token))
                .andExpect(status().isForbidden());
    }
}
```
