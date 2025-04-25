---
title: OAuth2.0协议原理与Spring Security完整实现
categories: 认证授权
tags:
    - OAuth2.0
    - Spring Security
    - 认证
    - 系统设计
date: 2025-07-31 17:00:00 +0800
updated: 2025-07-31 17:00:00 +0800
---

最近在开发一个需要第三方登录的Spring Boot项目，需要实现类似“使用GitHub登录”、“使用微信登录”的功能。OAuth2.0作为目前最流行的授权框架，完美解决了第三方授权的问题。本文将从协议规范到代码实现，详细剖析OAuth2.0的工作原理。

<!-- more -->

## OAuth2.0协议规定

OAuth2.0是一个关于授权的开放标准，允许用户授权第三方应用访问其在服务提供商上存储的特定资源，而无需将用户名和密码提供给第三方应用。

### 核心角色

OAuth2.0定义了四个核心角色：

- **Resource Owner（资源所有者）**：通常是用户，拥有受保护资源的实体
- **Client（客户端）**：需要访问用户资源的第三方应用
- **Resource Server（资源服务器）**：存储受保护资源的服务器
- **Authorization Server（授权服务器）**：验证用户身份并颁发访问令牌的服务器

### 授权模式

OAuth2.0定义了四种授权模式（Grant Type）：

#### 授权码模式（Authorization Code）

最完整、最安全的授权模式，适用于有后端的Web应用：

```text
     +----------+
     | Resource |
     |   Owner  |
     +----------+
          ^
          |
         (B)
     +----|-----+          Client Identifier      +---------------+
     |         -+----(A)-- & Redirection URI ---->|               |
     |  User-   |                                 | Authorization |
     |  Agent  -+----(B)-- User authenticates --->|     Server    |
     |          |                                 |               |
     |         -+----(C)-- Authorization Code ---<|               |
     +-|----|---+                                 +---------------+
       |    |                                         ^      v
      (A)  (C)                                        |      |
       |    |                                         |      |
       ^    v                                         |      |
     +---------+                                      |      |
     |         |>---(D)-- Authorization Code ---------'      |
     |  Client |          & Redirection URI                  |
     |         |                                             |
     |         |<---(E)----- Access Token -------------------'
     +---------+       (w/ Optional Refresh Token)
```

#### 隐式模式（Implicit）

简化模式，适用于纯前端应用，但安全性较低（已不推荐使用）：

```text
     +----------+
     | Resource |
     |  Owner   |
     +----------+
          ^
          |
         (B)
     +----|-----+          Client Identifier     +---------------+
     |         -+----(A)-- & Redirection URI --->|               |
     |  User-   |                                | Authorization |
     |  Agent  -|----(B)-- User authenticates -->|     Server    |
     |          |                                |               |
     |          |<---(C)--- Redirection URI ----<|               |
     |          |          with Access Token     +---------------+
     |          |            in Fragment
     |          |                                +---------------+
     |          |----(D)--- Redirection URI ---->|   Web-Hosted  |
     |          |          without Fragment      |     Client    |
     |          |                                |    Resource   |
     |     (F)  |<---(E)------- Script ---------<|               |
     |          |                                +---------------+
     +-|--------+
       |    |
      (A)  (G) Access Token
       |    |
       ^    v
     +---------+
     |         |
     |  Client |
     |         |
     +---------+
```

#### 密码模式（Resource Owner Password Credentials）

用户直接把用户名密码给客户端，适用于高度信任的应用：

```text
     +----------+
     | Resource |
     |  Owner   |
     +----------+
          v
          |    Resource Owner
         (A) Password Credentials
          |
          v
     +---------+                                  +---------------+
     |         |>--(B)---- Resource Owner ------->|               |
     |         |         Password Credentials     | Authorization |
     | Client  |                                  |     Server    |
     |         |<--(C)---- Access Token ---------<|               |
     |         |    (w/ Optional Refresh Token)   |               |
     +---------+                                  +---------------+
```

#### 客户端模式（Client Credentials）

客户端以自己的名义请求访问令牌，适用于没有用户参与的场景：

```text
     +---------+                                  +---------------+
     |         |                                  |               |
     |         |>--(A)- Client Authentication --->| Authorization |
     | Client  |                                  |     Server    |
     |         |<--(B)---- Access Token ---------<|               |
     |         |                                  |               |
     +---------+                                  +---------------+
```

### Token类型

OAuth2.0定义了两种Token：

- **Access Token（访问令牌）**：用于访问受保护资源的凭证，有效期较短
- **Refresh Token（刷新令牌）**：用于获取新的Access Token，有效期较长

## Spring Security OAuth2.0服务端实现

### 引入依赖

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-security</artifactId>
</dependency>
<dependency>
    <groupId>org.springframework.security</groupId>
    <artifactId>spring-security-oauth2-authorization-server</artifactId>
    <version>1.1.1</version>
</dependency>
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-oauth2-resource-server</artifactId>
</dependency>
```

### 授权服务器配置

```java
@Configuration
@EnableWebSecurity
public class AuthorizationServerConfig {

    @Bean
    @Order(1)
    public SecurityFilterChain authorizationServerSecurityFilterChain(HttpSecurity http) throws Exception {
        OAuth2AuthorizationServerConfiguration.applyDefaultSecurity(http);

        http.getConfigurer(OAuth2AuthorizationServerConfigurer.class)
            .oidc(Customizer.withDefaults()); // 启用OpenID Connect 1.0

        http
            .exceptionHandling((exceptions) -> exceptions
                .defaultAuthenticationEntryPointFor(
                    new LoginUrlAuthenticationEntryPoint("/login"),
                    new MediaTypeRequestMatcher(MediaType.TEXT_HTML)
                )
            )
            .oauth2ResourceServer((resourceServer) -> resourceServer
                .jwt(Customizer.withDefaults()));

        return http.build();
    }

    @Bean
    @Order(2)
    public SecurityFilterChain defaultSecurityFilterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests((authorize) -> authorize
                .requestMatchers("/assets/**", "/webjars/**", "/login").permitAll()
                .anyRequest().authenticated()
            )
            .formLogin(formLogin -> formLogin
                .loginPage("/login")
            );

        return http.build();
    }

    @Bean
    public RegisteredClientRepository registeredClientRepository() {
        RegisteredClient webClient = RegisteredClient.withId(UUID.randomUUID().toString())
            .clientId("web-client")
            .clientSecret("{noop}secret")
            .clientAuthenticationMethod(ClientAuthenticationMethod.CLIENT_SECRET_BASIC)
            .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
            .authorizationGrantType(AuthorizationGrantType.REFRESH_TOKEN)
            .authorizationGrantType(AuthorizationGrantType.CLIENT_CREDENTIALS)
            .redirectUri("http://127.0.0.1:8080/login/oauth2/code/web-client")
            .redirectUri("http://127.0.0.1:8080/authorized")
            .postLogoutRedirectUri("http://127.0.0.1:8080/logged-out")
            .scope(OidcScopes.OPENID)
            .scope(OidcScopes.PROFILE)
            .scope("message.read")
            .scope("message.write")
            .clientSettings(ClientSettings.builder()
                .requireAuthorizationConsent(true)
                .requireProofKey(false)
                .build())
            .tokenSettings(TokenSettings.builder()
                .accessTokenTimeToLive(Duration.ofMinutes(5))
                .refreshTokenTimeToLive(Duration.ofMinutes(60))
                .reuseRefreshTokens(false)
                .build())
            .build();

        RegisteredClient mobileClient = RegisteredClient.withId(UUID.randomUUID().toString())
            .clientId("mobile-client")
            .clientAuthenticationMethod(ClientAuthenticationMethod.NONE)
            .authorizationGrantType(AuthorizationGrantType.AUTHORIZATION_CODE)
            .authorizationGrantType(AuthorizationGrantType.REFRESH_TOKEN)
            .redirectUri("com.example.app://authorized")
            .scope("message.read")
            .clientSettings(ClientSettings.builder()
                .requireAuthorizationConsent(false)
                .requireProofKey(true) // 移动端使用PKCE
                .build())
            .build();

        return new InMemoryRegisteredClientRepository(webClient, mobileClient);
    }

    @Bean
    public JWKSource<SecurityContext> jwkSource() {
        KeyPair keyPair = generateRsaKey();
        RSAPublicKey publicKey = (RSAPublicKey) keyPair.getPublic();
        RSAPrivateKey privateKey = (RSAPrivateKey) keyPair.getPrivate();

        RSAKey rsaKey = new RSAKey.Builder(publicKey)
            .privateKey(privateKey)
            .keyID(UUID.randomUUID().toString())
            .build();

        JWKSet jwkSet = new JWKSet(rsaKey);
        return new ImmutableJWKSet<>(jwkSet);
    }

    private static KeyPair generateRsaKey() {
        try {
            KeyPairGenerator keyPairGenerator = KeyPairGenerator.getInstance("RSA");
            keyPairGenerator.initialize(2048);
            return keyPairGenerator.generateKeyPair();
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
    }

    @Bean
    public JwtDecoder jwtDecoder(JWKSource<SecurityContext> jwkSource) {
        return OAuth2AuthorizationServerConfiguration.jwtDecoder(jwkSource);
    }

    @Bean
    public AuthorizationServerSettings authorizationServerSettings() {
        return AuthorizationServerSettings.builder()
            .issuer("http://localhost:9000")
            .build();
    }
}
```

### 自定义用户认证

```java
@Service
public class CustomUserDetailsService implements UserDetailsService {

    @Autowired
    private UserRepository userRepository;

    @Override
    public UserDetails loadUserByUsername(String username) throws UsernameNotFoundException {
        User user = userRepository.findByUsername(username)
            .orElseThrow(() -> new UsernameNotFoundException("用户不存在: " + username));

        return org.springframework.security.core.userdetails.User.builder()
            .username(user.getUsername())
            .password(user.getPassword())
            .authorities(user.getRoles().stream()
                .map(role -> new SimpleGrantedAuthority("ROLE_" + role.getName()))
                .collect(Collectors.toList()))
            .build();
    }
}

@Component
public class CustomOAuth2TokenCustomizer implements OAuth2TokenCustomizer<JwtEncodingContext> {

    @Override
    public void customize(JwtEncodingContext context) {
        if (context.getTokenType().getValue().equals(OidcParameterNames.ID_TOKEN)) {
            // 自定义ID Token
            Authentication principal = context.getPrincipal();
            Set<String> authorities = principal.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .collect(Collectors.toSet());

            context.getClaims().claim("authorities", authorities);
            context.getClaims().claim("user_id", getUserId(principal));
        }

        if (context.getTokenType().equals(OAuth2TokenType.ACCESS_TOKEN)) {
            // 自定义Access Token
            Authentication principal = context.getPrincipal();
            Set<String> scopes = context.getRegisteredClient().getScopes();

            Set<String> authorizedScopes = principal.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .filter(authority -> authority.startsWith("SCOPE_"))
                .map(authority -> authority.substring(6))
                .filter(scopes::contains)
                .collect(Collectors.toSet());

            context.getClaims().claim("scopes", authorizedScopes);
        }
    }

    private Long getUserId(Authentication authentication) {
        // 从认证信息中提取用户ID
        if (authentication.getPrincipal() instanceof CustomUserDetails) {
            return ((CustomUserDetails) authentication.getPrincipal()).getUserId();
        }
        return null;
    }
}
```

### 资源服务器配置

```java
@Configuration
@EnableWebSecurity
public class ResourceServerConfig {

    @Bean
    public SecurityFilterChain resourceServerSecurityFilterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests((authorize) -> authorize
                .requestMatchers("/api/public/**").permitAll()
                .requestMatchers("/api/admin/**").hasRole("ADMIN")
                .requestMatchers("/api/**").authenticated()
            )
            .oauth2ResourceServer((oauth2) -> oauth2
                .jwt((jwt) -> jwt
                    .jwtAuthenticationConverter(jwtAuthenticationConverter())
                )
            );

        return http.build();
    }

    @Bean
    public JwtAuthenticationConverter jwtAuthenticationConverter() {
        JwtGrantedAuthoritiesConverter grantedAuthoritiesConverter = new JwtGrantedAuthoritiesConverter();
        grantedAuthoritiesConverter.setAuthorityPrefix("SCOPE_");
        grantedAuthoritiesConverter.setAuthoritiesClaimName("scopes");

        JwtAuthenticationConverter jwtAuthenticationConverter = new JwtAuthenticationConverter();
        jwtAuthenticationConverter.setJwtGrantedAuthoritiesConverter(grantedAuthoritiesConverter);
        return jwtAuthenticationConverter;
    }

    @Bean
    public JwtDecoder jwtDecoder() {
        return NimbusJwtDecoder.withJwkSetUri("http://localhost:9000/oauth2/jwks").build();
    }
}
```

### 自定义授权端点

```java
@Controller
public class AuthorizationConsentController {

    @Autowired
    private RegisteredClientRepository registeredClientRepository;

    @GetMapping("/oauth2/consent")
    public String consent(Principal principal, Model model,
                         @RequestParam(OAuth2ParameterNames.CLIENT_ID) String clientId,
                         @RequestParam(OAuth2ParameterNames.SCOPE) String scope,
                         @RequestParam(OAuth2ParameterNames.STATE) String state) {

        RegisteredClient registeredClient = registeredClientRepository.findByClientId(clientId);

        Set<String> scopesToApprove = new HashSet<>();
        Set<String> previouslyApprovedScopes = new HashSet<>();

        Set<String> requestedScopes = new HashSet<>(Arrays.asList(scope.split(" ")));
        Set<String> authorizedScopes = getAuthorizedScopes(principal, registeredClient);

        for (String requestedScope : requestedScopes) {
            if (authorizedScopes.contains(requestedScope)) {
                previouslyApprovedScopes.add(requestedScope);
            } else {
                scopesToApprove.add(requestedScope);
            }
        }

        model.addAttribute("clientId", clientId);
        model.addAttribute("clientName", registeredClient.getClientName());
        model.addAttribute("state", state);
        model.addAttribute("scopes", scopesToApprove);
        model.addAttribute("previouslyApprovedScopes", previouslyApprovedScopes);
        model.addAttribute("principalName", principal.getName());

        return "consent";
    }

    private Set<String> getAuthorizedScopes(Principal principal, RegisteredClient registeredClient) {
        // 查询用户已授权的范围
        // 实际应该从数据库查询
        return new HashSet<>();
    }
}
```

## OAuth2.0客户端实现

### 客户端配置

```java
@Configuration
@EnableWebSecurity
public class OAuth2ClientConfig {

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
            .authorizeHttpRequests(authorize -> authorize
                .requestMatchers("/", "/error", "/webjars/**").permitAll()
                .anyRequest().authenticated()
            )
            .oauth2Login(oauth2Login -> oauth2Login
                .loginPage("/oauth2/authorization/web-client")
                .successHandler(oAuth2AuthenticationSuccessHandler())
                .failureHandler(oAuth2AuthenticationFailureHandler())
            )
            .oauth2Client(Customizer.withDefaults());

        return http.build();
    }

    @Bean
    public OAuth2AuthenticationSuccessHandler oAuth2AuthenticationSuccessHandler() {
        return new OAuth2AuthenticationSuccessHandler();
    }

    @Bean
    public OAuth2AuthenticationFailureHandler oAuth2AuthenticationFailureHandler() {
        return new OAuth2AuthenticationFailureHandler();
    }
}

// 自定义成功处理器
public class OAuth2AuthenticationSuccessHandler extends SavedRequestAwareAuthenticationSuccessHandler {

    @Autowired
    private UserService userService;

    @Override
    public void onAuthenticationSuccess(HttpServletRequest request,
                                      HttpServletResponse response,
                                      Authentication authentication) throws IOException, ServletException {

        OAuth2AuthenticationToken oAuth2Token = (OAuth2AuthenticationToken) authentication;
        OAuth2User oAuth2User = oAuth2Token.getPrincipal();

        // 获取用户信息
        String email = oAuth2User.getAttribute("email");
        String name = oAuth2User.getAttribute("name");
        String picture = oAuth2User.getAttribute("picture");

        // 创建或更新本地用户
        User localUser = userService.findOrCreateUser(email, name, picture);

        // 更新认证信息
        CustomOAuth2User customOAuth2User = new CustomOAuth2User(
            oAuth2User.getAuthorities(),
            oAuth2User.getAttributes(),
            "name",
            localUser.getId()
        );

        OAuth2AuthenticationToken newAuth = new OAuth2AuthenticationToken(
            customOAuth2User,
            customOAuth2User.getAuthorities(),
            oAuth2Token.getAuthorizedClientRegistrationId()
        );

        SecurityContextHolder.getContext().setAuthentication(newAuth);

        super.onAuthenticationSuccess(request, response, authentication);
    }
}
```

### 客户端配置文件

```yaml
spring:
  security:
    oauth2:
      client:
        registration:
          web-client:
            client-id: web-client
            client-secret: secret
            scope: openid, profile, message.read, message.write
            authorization-grant-type: authorization_code
            redirect-uri: "{baseUrl}/login/oauth2/code/{registrationId}"
            client-name: Web Client

          github:
            client-id: ${GITHUB_CLIENT_ID}
            client-secret: ${GITHUB_CLIENT_SECRET}
            scope: read:user, user:email

          google:
            client-id: ${GOOGLE_CLIENT_ID}
            client-secret: ${GOOGLE_CLIENT_SECRET}
            scope: openid, profile, email

        provider:
          web-client:
            authorization-uri: http://localhost:9000/oauth2/authorize
            token-uri: http://localhost:9000/oauth2/token
            jwk-set-uri: http://localhost:9000/oauth2/jwks
            user-info-uri: http://localhost:9000/userinfo
            user-name-attribute: sub
```

### 使用RestTemplate访问受保护资源

```java
@Service
public class OAuth2ResourceService {

    @Autowired
    private OAuth2AuthorizedClientService authorizedClientService;

    @Autowired
    private RestTemplateBuilder restTemplateBuilder;

    public String getProtectedResource(OAuth2AuthenticationToken authentication) {
        // 获取访问令牌
        OAuth2AuthorizedClient authorizedClient = authorizedClientService.loadAuthorizedClient(
            authentication.getAuthorizedClientRegistrationId(),
            authentication.getName()
        );

        OAuth2AccessToken accessToken = authorizedClient.getAccessToken();

        // 使用访问令牌调用API
        RestTemplate restTemplate = restTemplateBuilder.build();

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(accessToken.getTokenValue());

        HttpEntity<String> entity = new HttpEntity<>(headers);

        ResponseEntity<String> response = restTemplate.exchange(
            "http://localhost:8080/api/messages",
            HttpMethod.GET,
            entity,
            String.class
        );

        return response.getBody();
    }

    // 自动刷新令牌
    public OAuth2AccessToken refreshTokenIfExpired(OAuth2AuthorizedClient authorizedClient) {
        if (isTokenExpired(authorizedClient.getAccessToken())) {
            OAuth2RefreshToken refreshToken = authorizedClient.getRefreshToken();
            if (refreshToken != null) {
                return refreshAccessToken(authorizedClient, refreshToken);
            }
        }
        return authorizedClient.getAccessToken();
    }

    private boolean isTokenExpired(OAuth2AccessToken accessToken) {
        return accessToken.getExpiresAt() != null &&
               Instant.now().isAfter(accessToken.getExpiresAt());
    }

    private OAuth2AccessToken refreshAccessToken(OAuth2AuthorizedClient authorizedClient,
                                                OAuth2RefreshToken refreshToken) {
        ClientRegistration clientRegistration = authorizedClient.getClientRegistration();

        OAuth2RefreshTokenGrantRequest refreshTokenGrantRequest =
            new OAuth2RefreshTokenGrantRequest(
                clientRegistration,
                authorizedClient.getAccessToken(),
                refreshToken
            );

        DefaultRefreshTokenTokenResponseClient tokenResponseClient =
            new DefaultRefreshTokenTokenResponseClient();

        OAuth2AccessTokenResponse tokenResponse =
            tokenResponseClient.getTokenResponse(refreshTokenGrantRequest);

        return tokenResponse.getAccessToken();
    }
}
```

### WebClient集成OAuth2

```java
@Configuration
public class WebClientConfig {

    @Bean
    public WebClient webClient(OAuth2AuthorizedClientManager authorizedClientManager) {
        ServletOAuth2AuthorizedClientExchangeFilterFunction oauth2Client =
            new ServletOAuth2AuthorizedClientExchangeFilterFunction(authorizedClientManager);

        oauth2Client.setDefaultClientRegistrationId("web-client");

        return WebClient.builder()
            .baseUrl("http://localhost:8080")
            .filter(oauth2Client)
            .build();
    }

    @Bean
    public OAuth2AuthorizedClientManager authorizedClientManager(
            ClientRegistrationRepository clientRegistrationRepository,
            OAuth2AuthorizedClientRepository authorizedClientRepository) {

        OAuth2AuthorizedClientProvider authorizedClientProvider =
            OAuth2AuthorizedClientProviderBuilder.builder()
                .authorizationCode()
                .refreshToken()
                .clientCredentials()
                .password()
                .build();

        DefaultOAuth2AuthorizedClientManager authorizedClientManager =
            new DefaultOAuth2AuthorizedClientManager(
                clientRegistrationRepository,
                authorizedClientRepository
            );

        authorizedClientManager.setAuthorizedClientProvider(authorizedClientProvider);

        return authorizedClientManager;
    }
}

@Service
public class WebClientService {

    @Autowired
    private WebClient webClient;

    public Mono<String> getResource() {
        return webClient
            .get()
            .uri("/api/messages")
            .attributes(ServerOAuth2AuthorizedClientExchangeFilterFunction
                .clientRegistrationId("web-client"))
            .retrieve()
            .bodyToMono(String.class);
    }

    // 使用不同的客户端
    public Mono<String> getResourceWithDifferentClient(String clientRegistrationId) {
        return webClient
            .get()
            .uri("/api/data")
            .attributes(ServerOAuth2AuthorizedClientExchangeFilterFunction
                .clientRegistrationId(clientRegistrationId))
            .retrieve()
            .bodyToMono(String.class);
    }
}
```

## 安全性考虑

### PKCE（Proof Key for Code Exchange）

PKCE用于增强公共客户端（如移动应用、SPA）的安全性：

```java
@Component
public class PKCEValidator {

    public String generateCodeVerifier() {
        SecureRandom secureRandom = new SecureRandom();
        byte[] codeVerifier = new byte[32];
        secureRandom.nextBytes(codeVerifier);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(codeVerifier);
    }

    public String generateCodeChallenge(String codeVerifier) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(codeVerifier.getBytes(StandardCharsets.US_ASCII));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException(e);
        }
    }

    public boolean verifyCodeChallenge(String codeVerifier, String codeChallenge,
                                      String codeChallengeMethod) {
        if ("S256".equals(codeChallengeMethod)) {
            String computedChallenge = generateCodeChallenge(codeVerifier);
            return computedChallenge.equals(codeChallenge);
        } else if ("plain".equals(codeChallengeMethod)) {
            return codeVerifier.equals(codeChallenge);
        }
        return false;
    }
}

// 在授权服务器中验证PKCE
@Component
public class PKCEAuthorizationCodeTokenGranter {

    @Autowired
    private PKCEValidator pkceValidator;

    public OAuth2AccessToken grant(String authorizationCode, String codeVerifier) {
        // 从存储中获取之前保存的code_challenge
        AuthorizationCodeDetails codeDetails = getAuthorizationCodeDetails(authorizationCode);

        if (codeDetails.getCodeChallenge() != null) {
            // 验证PKCE
            if (!pkceValidator.verifyCodeChallenge(codeVerifier,
                                                   codeDetails.getCodeChallenge(),
                                                   codeDetails.getCodeChallengeMethod())) {
                throw new OAuth2AuthenticationException("Invalid code_verifier");
            }
        }

        // 继续正常的令牌颁发流程
        return issueAccessToken(codeDetails);
    }
}
```

### 防止授权码拦截攻击

```java
@Component
public class AuthorizationCodeSecurityEnhancer {

    private final Map<String, AuthorizationCodeMetadata> codeMetadataStore = new ConcurrentHashMap<>();

    public String generateSecureAuthorizationCode(String clientId, String redirectUri) {
        String code = generateRandomCode();

        AuthorizationCodeMetadata metadata = new AuthorizationCodeMetadata();
        metadata.setClientId(clientId);
        metadata.setRedirectUri(redirectUri);
        metadata.setIssuedAt(Instant.now());
        metadata.setExpiresAt(Instant.now().plusSeconds(60)); // 1分钟有效期
        metadata.setUsed(false);

        codeMetadataStore.put(code, metadata);

        // 定时清理过期的授权码
        scheduleCodeCleanup(code, 60);

        return code;
    }

    public void validateAuthorizationCode(String code, String clientId, String redirectUri) {
        AuthorizationCodeMetadata metadata = codeMetadataStore.get(code);

        if (metadata == null) {
            throw new InvalidAuthorizationCodeException("授权码不存在");
        }

        if (metadata.isUsed()) {
            // 授权码已被使用，可能存在攻击，撤销所有相关令牌
            revokeAllTokensForAuthorizationCode(code);
            throw new InvalidAuthorizationCodeException("授权码已被使用");
        }

        if (Instant.now().isAfter(metadata.getExpiresAt())) {
            throw new InvalidAuthorizationCodeException("授权码已过期");
        }

        if (!metadata.getClientId().equals(clientId)) {
            throw new InvalidAuthorizationCodeException("客户端ID不匹配");
        }

        if (!metadata.getRedirectUri().equals(redirectUri)) {
            throw new InvalidAuthorizationCodeException("重定向URI不匹配");
        }

        // 标记为已使用
        metadata.setUsed(true);
    }

    private String generateRandomCode() {
        return UUID.randomUUID().toString();
    }

    private void scheduleCodeCleanup(String code, long delaySeconds) {
        ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();
        executor.schedule(() -> codeMetadataStore.remove(code), delaySeconds, TimeUnit.SECONDS);
    }

    @Data
    private static class AuthorizationCodeMetadata {
        private String clientId;
        private String redirectUri;
        private Instant issuedAt;
        private Instant expiresAt;
        private boolean used;
    }
}
```

### Token安全存储

```java
@Service
public class SecureTokenStore {

    @Autowired
    private StringRedisTemplate redisTemplate;

    private static final String ACCESS_TOKEN_PREFIX = "access_token:";
    private static final String REFRESH_TOKEN_PREFIX = "refresh_token:";

    // 使用加密存储敏感令牌
    public void storeAccessToken(OAuth2AccessToken accessToken, OAuth2Authentication authentication) {
        String tokenKey = extractTokenKey(accessToken.getValue());
        String encryptedToken = encrypt(accessToken.getValue());

        OAuth2AccessTokenEntity entity = new OAuth2AccessTokenEntity();
        entity.setTokenValue(encryptedToken);
        entity.setTokenType(accessToken.getTokenType());
        entity.setScopes(accessToken.getScopes());
        entity.setExpiresAt(accessToken.getExpiresAt());
        entity.setAuthentication(serializeAuthentication(authentication));

        redisTemplate.opsForValue().set(
            ACCESS_TOKEN_PREFIX + tokenKey,
            JsonUtils.toJson(entity),
            accessToken.getExpiresAt().toEpochMilli() - System.currentTimeMillis(),
            TimeUnit.MILLISECONDS
        );
    }

    public OAuth2AccessToken readAccessToken(String tokenValue) {
        String tokenKey = extractTokenKey(tokenValue);
        String json = redisTemplate.opsForValue().get(ACCESS_TOKEN_PREFIX + tokenKey);

        if (json == null) {
            return null;
        }

        OAuth2AccessTokenEntity entity = JsonUtils.fromJson(json, OAuth2AccessTokenEntity.class);

        // 验证令牌
        String decryptedToken = decrypt(entity.getTokenValue());
        if (!decryptedToken.equals(tokenValue)) {
            throw new InvalidTokenException("令牌验证失败");
        }

        return new OAuth2AccessToken(
            entity.getTokenType(),
            tokenValue,
            entity.getIssuedAt(),
            entity.getExpiresAt(),
            entity.getScopes()
        );
    }

    // Token撤销
    public void revokeToken(String tokenValue) {
        String tokenKey = extractTokenKey(tokenValue);
        redisTemplate.delete(ACCESS_TOKEN_PREFIX + tokenKey);

        // 记录撤销的令牌，防止重放攻击
        recordRevokedToken(tokenValue);
    }

    private void recordRevokedToken(String tokenValue) {
        String tokenKey = extractTokenKey(tokenValue);
        redisTemplate.opsForSet().add("revoked_tokens", tokenKey);
        // 设置过期时间为令牌的原始过期时间
        redisTemplate.expire("revoked_tokens", 24, TimeUnit.HOURS);
    }

    public boolean isTokenRevoked(String tokenValue) {
        String tokenKey = extractTokenKey(tokenValue);
        return redisTemplate.opsForSet().isMember("revoked_tokens", tokenKey);
    }

    private String extractTokenKey(String value) {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("MD5");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("MD5算法不可用");
        }

        byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
        return String.format("%032x", new BigInteger(1, bytes));
    }

    private String encrypt(String value) {
        // 实现加密逻辑
        // 这里应该使用AES等对称加密算法
        return Base64.getEncoder().encodeToString(value.getBytes());
    }

    private String decrypt(String encryptedValue) {
        // 实现解密逻辑
        return new String(Base64.getDecoder().decode(encryptedValue));
    }
}
```

### 防止重放攻击

```java
@Component
public class NonceValidator {

    private final Cache<String, Boolean> nonceCache = CacheBuilder.newBuilder()
        .maximumSize(10000)
        .expireAfterWrite(5, TimeUnit.MINUTES)
        .build();

    public String generateNonce() {
        return UUID.randomUUID().toString();
    }

    public void validateNonce(String nonce) {
        if (StringUtils.isEmpty(nonce)) {
            throw new InvalidNonceException("Nonce不能为空");
        }

        Boolean exists = nonceCache.getIfPresent(nonce);
        if (exists != null) {
            throw new InvalidNonceException("Nonce已被使用");
        }

        nonceCache.put(nonce, true);
    }
}

@RestController
@RequestMapping("/oauth2")
public class OAuth2EndpointController {

    @Autowired
    private NonceValidator nonceValidator;

    @PostMapping("/token")
    public OAuth2AccessToken issueToken(@RequestParam Map<String, String> parameters) {
        // 验证nonce防止重放攻击
        String nonce = parameters.get("nonce");
        nonceValidator.validateNonce(nonce);

        // 验证时间戳
        String timestamp = parameters.get("timestamp");
        validateTimestamp(timestamp);

        // 继续正常的令牌颁发流程
        return processTokenRequest(parameters);
    }

    private void validateTimestamp(String timestamp) {
        if (timestamp == null) {
            throw new InvalidRequestException("缺少时间戳");
        }

        long requestTime = Long.parseLong(timestamp);
        long currentTime = System.currentTimeMillis();

        // 允许5分钟的时间差
        if (Math.abs(currentTime - requestTime) > 5 * 60 * 1000) {
            throw new InvalidRequestException("请求已过期");
        }
    }
}
```

### 审计日志

```java
@Component
@Slf4j
public class OAuth2AuditLogger {

    @Autowired
    private AuditLogRepository auditLogRepository;

    @EventListener
    public void handleAuthorizationSuccess(AuthorizationSuccessEvent event) {
        AuditLog auditLog = new AuditLog();
        auditLog.setEventType("AUTHORIZATION_SUCCESS");
        auditLog.setClientId(event.getClientId());
        auditLog.setUsername(event.getUsername());
        auditLog.setScopes(String.join(",", event.getScopes()));
        auditLog.setIpAddress(event.getIpAddress());
        auditLog.setTimestamp(Instant.now());

        auditLogRepository.save(auditLog);
        log.info("授权成功: clientId={}, username={}, scopes={}",
                event.getClientId(), event.getUsername(), event.getScopes());
    }

    @EventListener
    public void handleAuthorizationFailure(AuthorizationFailureEvent event) {
        AuditLog auditLog = new AuditLog();
        auditLog.setEventType("AUTHORIZATION_FAILURE");
        auditLog.setClientId(event.getClientId());
        auditLog.setUsername(event.getUsername());
        auditLog.setErrorCode(event.getErrorCode());
        auditLog.setErrorDescription(event.getErrorDescription());
        auditLog.setIpAddress(event.getIpAddress());
        auditLog.setTimestamp(Instant.now());

        auditLogRepository.save(auditLog);
        log.warn("授权失败: clientId={}, username={}, error={}",
                event.getClientId(), event.getUsername(), event.getErrorCode());

        // 检测异常行为
        detectAnomalies(event);
    }

    private void detectAnomalies(AuthorizationFailureEvent event) {
        // 检查短时间内的失败次数
        long recentFailures = auditLogRepository.countRecentFailures(
            event.getClientId(),
            event.getIpAddress(),
            Instant.now().minusSeconds(300) // 5分钟内
        );

        if (recentFailures > 5) {
            // 触发安全警报
            sendSecurityAlert(event);
            // 可以考虑临时封禁IP或客户端
            blockTemporarily(event.getIpAddress());
        }
    }

    private void sendSecurityAlert(AuthorizationFailureEvent event) {
        // 发送安全警报邮件或消息
        log.error("安全警报: 检测到异常授权尝试 - IP: {}, ClientId: {}",
                 event.getIpAddress(), event.getClientId());
    }

    private void blockTemporarily(String ipAddress) {
        // 实现IP临时封禁逻辑
        redisTemplate.opsForValue().set(
            "blocked_ip:" + ipAddress,
            "true",
            15,
            TimeUnit.MINUTES
        );
    }
}
```
