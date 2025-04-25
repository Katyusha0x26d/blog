---
title: Web后端服务授权控制方案汇总与个人思考
categories: 认证授权
tags:
    - Web
    - 授权
    - 系统设计
date: 2025-05-14 22:46:30 +0800
updated: 2025-05-15 16:00:00 +0800
---

在完成用户身份认证后，如何控制用户能访问哪些资源、执行哪些操作？这就是授权（Authorization）要解决的问题。本文将详细介绍RBAC、ABAC和Spring Security的SpEL权限验证等主流授权方案的原理与实现。

<!-- more -->

## RBAC权限模型

RBAC（Role-Based Access Control，基于角色的访问控制）是目前应用最广泛的权限模型。用户通过角色与权限进行关联，简化了权限管理的复杂度。

### RBAC0：基础模型

最基础的RBAC模型包含三个核心概念：
- **用户（User）**：系统的使用者
- **角色（Role）**：权限的集合
- **权限（Permission）**：对资源的操作许可

数据库设计：

```sql
-- 用户表
CREATE TABLE users (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(50) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    email VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 角色表
CREATE TABLE roles (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(50) NOT NULL UNIQUE,
    description VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 权限表
CREATE TABLE permissions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL UNIQUE,
    resource VARCHAR(100) NOT NULL,  -- 资源类型
    action VARCHAR(50) NOT NULL,     -- 操作类型
    description VARCHAR(255)
);

-- 用户-角色关联表
CREATE TABLE user_roles (
    user_id BIGINT NOT NULL,
    role_id BIGINT NOT NULL,
    PRIMARY KEY (user_id, role_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (role_id) REFERENCES roles(id)
);

-- 角色-权限关联表
CREATE TABLE role_permissions (
    role_id BIGINT NOT NULL,
    permission_id BIGINT NOT NULL,
    PRIMARY KEY (role_id, permission_id),
    FOREIGN KEY (role_id) REFERENCES roles(id),
    FOREIGN KEY (permission_id) REFERENCES permissions(id)
);
```

Spring Boot实现：

```java
@Service
public class RbacService {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private RoleRepository roleRepository;

    @Autowired
    private PermissionRepository permissionRepository;

    // 获取用户所有权限
    public Set<String> getUserPermissions(Long userId) {
        User user = userRepository.findById(userId)
            .orElseThrow(() -> new NotFoundException("用户不存在"));

        Set<String> permissions = new HashSet<>();
        for (Role role : user.getRoles()) {
            for (Permission permission : role.getPermissions()) {
                permissions.add(permission.getName());
            }
        }
        return permissions;
    }

    // 检查用户是否有特定权限
    public boolean hasPermission(Long userId, String resource, String action) {
        Set<String> permissions = getUserPermissions(userId);
        String permissionName = resource + ":" + action;
        return permissions.contains(permissionName);
    }

    // 给用户分配角色
    @Transactional
    public void assignRole(Long userId, Long roleId) {
        User user = userRepository.findById(userId)
            .orElseThrow(() -> new NotFoundException("用户不存在"));
        Role role = roleRepository.findById(roleId)
            .orElseThrow(() -> new NotFoundException("角色不存在"));

        user.getRoles().add(role);
        userRepository.save(user);
    }
}
```

自定义权限注解：

```java
@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface RequirePermission {
    String resource();
    String action();
}

@Aspect
@Component
public class PermissionAspect {

    @Autowired
    private RbacService rbacService;

    @Autowired
    private HttpServletRequest request;

    @Around("@annotation(requirePermission)")
    public Object checkPermission(ProceedingJoinPoint pjp,
                                 RequirePermission requirePermission) throws Throwable {
        // 从请求中获取用户ID（通常从JWT或Session中获取）
        Long userId = getCurrentUserId();

        if (!rbacService.hasPermission(userId,
                                      requirePermission.resource(),
                                      requirePermission.action())) {
            throw new AccessDeniedException("权限不足");
        }

        return pjp.proceed();
    }

    private Long getCurrentUserId() {
        // 从认证信息中获取用户ID
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.getPrincipal() instanceof UserDetails) {
            return ((CustomUserDetails) auth.getPrincipal()).getUserId();
        }
        throw new UnauthorizedException("用户未登录");
    }
}
```

使用示例：

```java
@RestController
@RequestMapping("/api/articles")
public class ArticleController {

    @PostMapping
    @RequirePermission(resource = "article", action = "create")
    public Article createArticle(@RequestBody ArticleDto dto) {
        // 创建文章逻辑
        return articleService.create(dto);
    }

    @DeleteMapping("/{id}")
    @RequirePermission(resource = "article", action = "delete")
    public void deleteArticle(@PathVariable Long id) {
        articleService.delete(id);
    }
}
```

### RBAC1：角色继承

RBAC1在RBAC0基础上增加了角色继承机制，子角色可以继承父角色的所有权限：

```sql
-- 角色继承表
CREATE TABLE role_hierarchy (
    parent_role_id BIGINT NOT NULL,
    child_role_id BIGINT NOT NULL,
    PRIMARY KEY (parent_role_id, child_role_id),
    FOREIGN KEY (parent_role_id) REFERENCES roles(id),
    FOREIGN KEY (child_role_id) REFERENCES roles(id)
);
```

递归查询角色权限：

```java
@Service
public class HierarchicalRbacService extends RbacService {

    // 获取角色及其所有父角色的权限
    public Set<Permission> getRolePermissionsWithHierarchy(Long roleId) {
        Set<Permission> permissions = new HashSet<>();
        Set<Long> visitedRoles = new HashSet<>();

        collectPermissions(roleId, permissions, visitedRoles);
        return permissions;
    }

    private void collectPermissions(Long roleId,
                                   Set<Permission> permissions,
                                   Set<Long> visitedRoles) {
        if (visitedRoles.contains(roleId)) {
            return; // 避免循环引用
        }
        visitedRoles.add(roleId);

        Role role = roleRepository.findById(roleId).orElse(null);
        if (role == null) {
            return;
        }

        // 添加当前角色的权限
        permissions.addAll(role.getPermissions());

        // 递归获取父角色的权限
        List<Role> parentRoles = roleRepository.findParentRoles(roleId);
        for (Role parentRole : parentRoles) {
            collectPermissions(parentRole.getId(), permissions, visitedRoles);
        }
    }
}
```

### RBAC2：角色约束

RBAC2引入了角色约束，包括互斥角色、角色数量限制、先决条件角色等：

```java
@Component
public class RoleConstraintValidator {

    @Autowired
    private RoleConstraintRepository constraintRepository;

    // 检查互斥角色
    public boolean checkMutualExclusion(Long userId, Long newRoleId) {
        User user = userRepository.findById(userId).orElse(null);
        if (user == null) return false;

        Set<Long> userRoleIds = user.getRoles().stream()
            .map(Role::getId)
            .collect(Collectors.toSet());

        // 查询与新角色互斥的所有角色
        List<Long> mutuallyExclusiveRoles =
            constraintRepository.findMutuallyExclusiveRoles(newRoleId);

        // 检查用户是否已有互斥角色
        return Collections.disjoint(userRoleIds, mutuallyExclusiveRoles);
    }

    // 检查角色数量限制
    public boolean checkRoleLimit(Long userId, String roleType) {
        int currentCount = roleRepository.countUserRolesByType(userId, roleType);
        int maxLimit = constraintRepository.getMaxRoleLimit(roleType);
        return currentCount < maxLimit;
    }

    // 检查先决条件角色
    public boolean checkPrerequisites(Long userId, Long roleId) {
        List<Long> prerequisiteRoles =
            constraintRepository.findPrerequisiteRoles(roleId);

        if (prerequisiteRoles.isEmpty()) {
            return true;
        }

        Set<Long> userRoleIds = userRepository.findById(userId)
            .map(user -> user.getRoles().stream()
                .map(Role::getId)
                .collect(Collectors.toSet()))
            .orElse(Collections.emptySet());

        return userRoleIds.containsAll(prerequisiteRoles);
    }
}
```

### RBAC3：RBAC1 + RBAC2

RBAC3结合了角色继承和角色约束，是最完整的RBAC模型。

完整的权限检查服务：

```java
@Service
public class CompleteRbacService {

    @Autowired
    private HierarchicalRbacService hierarchicalRbacService;

    @Autowired
    private RoleConstraintValidator constraintValidator;

    @Transactional
    public void assignRoleWithValidation(Long userId, Long roleId) {
        // 1. 检查互斥约束
        if (!constraintValidator.checkMutualExclusion(userId, roleId)) {
            throw new BusinessException("角色互斥，无法分配");
        }

        // 2. 检查数量限制
        Role role = roleRepository.findById(roleId).orElse(null);
        if (role != null && !constraintValidator.checkRoleLimit(userId, role.getType())) {
            throw new BusinessException("超过角色数量限制");
        }

        // 3. 检查先决条件
        if (!constraintValidator.checkPrerequisites(userId, roleId)) {
            throw new BusinessException("缺少必要的前置角色");
        }

        // 4. 分配角色
        assignRole(userId, roleId);
    }

    // 获取用户的有效权限（考虑继承）
    public Set<String> getEffectivePermissions(Long userId) {
        User user = userRepository.findById(userId).orElse(null);
        if (user == null) return Collections.emptySet();

        Set<Permission> allPermissions = new HashSet<>();
        for (Role role : user.getRoles()) {
            allPermissions.addAll(
                hierarchicalRbacService.getRolePermissionsWithHierarchy(role.getId())
            );
        }

        return allPermissions.stream()
            .map(p -> p.getResource() + ":" + p.getAction())
            .collect(Collectors.toSet());
    }
}
```

## ABAC权限模型

ABAC（Attribute-Based Access Control，基于属性的访问控制）通过属性来进行权限判断，比RBAC更加灵活细粒度。

### ABAC核心概念

- **主体属性（Subject Attributes）**：用户的属性，如部门、职位、等级
- **资源属性（Resource Attributes）**：资源的属性，如创建者、分类、敏感级别
- **环境属性（Environment Attributes）**：环境属性，如时间、地点、IP地址
- **操作属性（Action Attributes）**：操作类型，如读、写、删除

### 策略定义与存储

```java
@Entity
public class AbacPolicy {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String name;
    private String description;

    @Column(columnDefinition = "TEXT")
    private String rule; // 使用JSON或表达式存储规则

    private Integer priority; // 优先级
    private Boolean enabled;

    @Enumerated(EnumType.STRING)
    private PolicyEffect effect; // PERMIT or DENY
}

public enum PolicyEffect {
    PERMIT, DENY
}
```

策略规则示例（JSON格式）：

```json
{
  "name": "部门文档访问策略",
  "conditions": {
    "all": [
      {
        "fact": "subject",
        "path": "$.department",
        "operator": "equal",
        "value": {
          "fact": "resource",
          "path": "$.department"
        }
      },
      {
        "any": [
          {
            "fact": "subject",
            "path": "$.role",
            "operator": "in",
            "value": ["manager", "admin"]
          },
          {
            "fact": "resource",
            "path": "$.owner",
            "operator": "equal",
            "value": {
              "fact": "subject",
              "path": "$.id"
            }
          }
        ]
      }
    ]
  },
  "effect": "PERMIT"
}
```

### ABAC引擎实现

```java
@Service
public class AbacEngine {

    @Autowired
    private PolicyRepository policyRepository;

    @Autowired
    private ScriptEngine scriptEngine;

    public boolean evaluate(AbacContext context) {
        List<AbacPolicy> policies = policyRepository.findEnabledPolicies();

        // 按优先级排序
        policies.sort(Comparator.comparing(AbacPolicy::getPriority));

        for (AbacPolicy policy : policies) {
            PolicyResult result = evaluatePolicy(policy, context);

            if (result == PolicyResult.DENY) {
                return false; // 拒绝优先
            }
            if (result == PolicyResult.PERMIT) {
                return true;
            }
        }

        // 默认拒绝
        return false;
    }

    private PolicyResult evaluatePolicy(AbacPolicy policy, AbacContext context) {
        try {
            // 使用JavaScript引擎评估规则
            scriptEngine.put("subject", context.getSubject());
            scriptEngine.put("resource", context.getResource());
            scriptEngine.put("action", context.getAction());
            scriptEngine.put("environment", context.getEnvironment());

            Boolean result = (Boolean) scriptEngine.eval(policy.getRule());

            if (result) {
                return policy.getEffect() == PolicyEffect.PERMIT ?
                    PolicyResult.PERMIT : PolicyResult.DENY;
            }

            return PolicyResult.NOT_APPLICABLE;

        } catch (Exception e) {
            log.error("策略评估失败: {}", policy.getName(), e);
            return PolicyResult.NOT_APPLICABLE;
        }
    }
}

@Data
public class AbacContext {
    private Map<String, Object> subject;    // 主体属性
    private Map<String, Object> resource;   // 资源属性
    private Map<String, Object> action;     // 操作属性
    private Map<String, Object> environment; // 环境属性
}
```

### 动态属性获取

```java
@Component
public class AttributeResolver {

    @Autowired
    private UserService userService;

    @Autowired
    private ResourceService resourceService;

    public AbacContext buildContext(Long userId, Long resourceId, String action) {
        AbacContext context = new AbacContext();

        // 解析主体属性
        User user = userService.findById(userId);
        Map<String, Object> subjectAttrs = new HashMap<>();
        subjectAttrs.put("id", user.getId());
        subjectAttrs.put("department", user.getDepartment());
        subjectAttrs.put("level", user.getLevel());
        subjectAttrs.put("roles", user.getRoles());
        context.setSubject(subjectAttrs);

        // 解析资源属性
        Resource resource = resourceService.findById(resourceId);
        Map<String, Object> resourceAttrs = new HashMap<>();
        resourceAttrs.put("id", resource.getId());
        resourceAttrs.put("owner", resource.getOwnerId());
        resourceAttrs.put("department", resource.getDepartment());
        resourceAttrs.put("sensitivity", resource.getSensitivity());
        resourceAttrs.put("createTime", resource.getCreateTime());
        context.setResource(resourceAttrs);

        // 解析操作属性
        Map<String, Object> actionAttrs = new HashMap<>();
        actionAttrs.put("type", action);
        context.setAction(actionAttrs);

        // 解析环境属性
        Map<String, Object> envAttrs = new HashMap<>();
        envAttrs.put("time", new Date());
        envAttrs.put("ip", getClientIp());
        envAttrs.put("location", getLocation());
        context.setEnvironment(envAttrs);

        return context;
    }

    private String getClientIp() {
        HttpServletRequest request =
            ((ServletRequestAttributes) RequestContextHolder.currentRequestAttributes())
                .getRequest();

        String ip = request.getHeader("X-Forwarded-For");
        if (ip == null || ip.isEmpty()) {
            ip = request.getRemoteAddr();
        }
        return ip;
    }
}
```

### ABAC与Spring Security集成

```java
@Component
public class AbacPermissionEvaluator implements PermissionEvaluator {

    @Autowired
    private AbacEngine abacEngine;

    @Autowired
    private AttributeResolver attributeResolver;

    @Override
    public boolean hasPermission(Authentication authentication,
                                Object targetDomainObject,
                                Object permission) {
        if (authentication == null || targetDomainObject == null) {
            return false;
        }

        Long userId = ((CustomUserDetails) authentication.getPrincipal()).getUserId();
        Long resourceId = extractResourceId(targetDomainObject);
        String action = permission.toString();

        AbacContext context = attributeResolver.buildContext(userId, resourceId, action);
        return abacEngine.evaluate(context);
    }

    @Override
    public boolean hasPermission(Authentication authentication,
                                Serializable targetId,
                                String targetType,
                                Object permission) {
        // 实现基于ID的权限检查
        Long userId = ((CustomUserDetails) authentication.getPrincipal()).getUserId();
        Long resourceId = Long.valueOf(targetId.toString());
        String action = permission.toString();

        AbacContext context = attributeResolver.buildContext(userId, resourceId, action);
        return abacEngine.evaluate(context);
    }

    private Long extractResourceId(Object targetDomainObject) {
        if (targetDomainObject instanceof BaseEntity) {
            return ((BaseEntity) targetDomainObject).getId();
        }
        throw new IllegalArgumentException("无法提取资源ID");
    }
}
```

## SpEL权限验证

Spring Expression Language (SpEL) 提供了强大的表达式支持，可以实现灵活的权限控制。

### 基础SpEL权限注解

Spring Security提供的权限注解：

```java
@RestController
@RequestMapping("/api/admin")
public class AdminController {

    // 需要ADMIN角色
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/users")
    public List<User> getAllUsers() {
        return userService.findAll();
    }

    // 需要特定权限
    @PreAuthorize("hasAuthority('user:read')")
    @GetMapping("/users/{id}")
    public User getUser(@PathVariable Long id) {
        return userService.findById(id);
    }

    // 多个角色之一
    @PreAuthorize("hasAnyRole('ADMIN', 'MANAGER')")
    @PostMapping("/users")
    public User createUser(@RequestBody UserDto dto) {
        return userService.create(dto);
    }

    // 组合条件
    @PreAuthorize("hasRole('ADMIN') and hasAuthority('user:delete')")
    @DeleteMapping("/users/{id}")
    public void deleteUser(@PathVariable Long id) {
        userService.delete(id);
    }
}
```

### 方法参数权限校验

```java
@Service
public class DocumentService {

    // 检查是否为文档所有者
    @PreAuthorize("#document.owner == authentication.principal.username")
    public void updateDocument(Document document) {
        // 更新文档
    }

    // 使用方法参数
    @PreAuthorize("#userId == authentication.principal.id")
    public List<Order> getUserOrders(Long userId) {
        return orderRepository.findByUserId(userId);
    }

    // 复杂表达式
    @PreAuthorize("hasRole('ADMIN') or (#project.managerId == authentication.principal.id)")
    public void updateProject(Project project) {
        // 更新项目
    }

    // 调用其他Bean的方法
    @PreAuthorize("@securityService.isOwner(authentication, #resourceId)")
    public void deleteResource(Long resourceId) {
        resourceRepository.deleteById(resourceId);
    }
}
```

### 返回值权限过滤

```java
@Service
public class DataService {

    // 过滤返回结果
    @PostAuthorize("returnObject.owner == authentication.name")
    public Document getDocument(Long id) {
        return documentRepository.findById(id).orElse(null);
    }

    // 过滤集合
    @PostFilter("filterObject.department == authentication.principal.department")
    public List<Employee> getEmployees() {
        return employeeRepository.findAll();
    }

    // 预过滤参数
    @PreFilter("filterObject.owner == authentication.name")
    public void batchDelete(List<Document> documents) {
        documents.forEach(doc -> documentRepository.delete(doc));
    }
}
```

### 自定义SpEL函数

创建自定义权限评估器：

```java
@Component("customSecurity")
public class CustomSecurityExpressions {

    @Autowired
    private UserService userService;

    @Autowired
    private DepartmentService departmentService;

    // 检查是否为部门经理
    public boolean isDepartmentManager(Authentication auth, Long departmentId) {
        if (auth == null || !auth.isAuthenticated()) {
            return false;
        }

        CustomUserDetails userDetails = (CustomUserDetails) auth.getPrincipal();
        Department dept = departmentService.findById(departmentId);

        return dept != null && dept.getManagerId().equals(userDetails.getUserId());
    }

    // 检查是否在同一部门
    public boolean inSameDepartment(Authentication auth, Long userId) {
        CustomUserDetails currentUser = (CustomUserDetails) auth.getPrincipal();
        User targetUser = userService.findById(userId);

        return currentUser.getDepartmentId().equals(targetUser.getDepartmentId());
    }

    // 检查时间范围
    public boolean withinBusinessHours() {
        LocalTime now = LocalTime.now();
        return now.isAfter(LocalTime.of(9, 0)) &&
               now.isBefore(LocalTime.of(18, 0));
    }

    // 检查IP白名单
    public boolean isAllowedIp(HttpServletRequest request) {
        String clientIp = request.getRemoteAddr();
        List<String> whitelist = Arrays.asList("192.168.1.0/24", "10.0.0.0/8");

        return whitelist.stream().anyMatch(range -> isIpInRange(clientIp, range));
    }
}
```

使用自定义函数：

```java
@RestController
@RequestMapping("/api/departments")
public class DepartmentController {

    @PreAuthorize("@customSecurity.isDepartmentManager(authentication, #deptId)")
    @PutMapping("/{deptId}")
    public Department updateDepartment(@PathVariable Long deptId,
                                      @RequestBody DepartmentDto dto) {
        return departmentService.update(deptId, dto);
    }

    @PreAuthorize("@customSecurity.inSameDepartment(authentication, #userId)")
    @GetMapping("/colleagues/{userId}")
    public UserProfile getColleagueProfile(@PathVariable Long userId) {
        return userService.getProfile(userId);
    }

    @PreAuthorize("@customSecurity.withinBusinessHours()")
    @PostMapping("/reports")
    public Report generateReport(@RequestBody ReportRequest request) {
        return reportService.generate(request);
    }
}
```

### 动态权限表达式

```java
@Service
public class DynamicPermissionService {

    @Autowired
    private PermissionRuleRepository ruleRepository;

    private final ExpressionParser parser = new SpelExpressionParser();

    public boolean evaluate(String resource, String action, Authentication auth) {
        // 从数据库获取权限规则
        PermissionRule rule = ruleRepository.findByResourceAndAction(resource, action);
        if (rule == null || !rule.isEnabled()) {
            return false;
        }

        // 构建评估上下文
        StandardEvaluationContext context = new StandardEvaluationContext();
        context.setVariable("auth", auth);
        context.setVariable("principal", auth.getPrincipal());
        context.setRootObject(auth);

        // 注册自定义函数
        registerCustomFunctions(context);

        try {
            // 评估SpEL表达式
            Expression expression = parser.parseExpression(rule.getExpression());
            return expression.getValue(context, Boolean.class);
        } catch (Exception e) {
            log.error("权限表达式评估失败: {}", rule.getExpression(), e);
            return false;
        }
    }

    private void registerCustomFunctions(StandardEvaluationContext context) {
        try {
            context.registerFunction("hasIpRange",
                CustomSecurityExpressions.class.getMethod("isAllowedIp", HttpServletRequest.class));
            context.registerFunction("isManager",
                CustomSecurityExpressions.class.getMethod("isDepartmentManager", Authentication.class, Long.class));
        } catch (NoSuchMethodException e) {
            log.error("注册自定义函数失败", e);
        }
    }
}
```

### 方法级安全配置

```java
@Configuration
@EnableGlobalMethodSecurity(
    prePostEnabled = true,  // 启用@PreAuthorize和@PostAuthorize
    securedEnabled = true,  // 启用@Secured
    jsr250Enabled = true    // 启用@RolesAllowed
)
public class MethodSecurityConfig extends GlobalMethodSecurityConfiguration {

    @Autowired
    private AbacPermissionEvaluator abacPermissionEvaluator;

    @Override
    protected MethodSecurityExpressionHandler createExpressionHandler() {
        DefaultMethodSecurityExpressionHandler handler =
            new DefaultMethodSecurityExpressionHandler();

        // 设置自定义权限评估器
        handler.setPermissionEvaluator(abacPermissionEvaluator);

        return handler;
    }
}
```

## 综合应用示例

结合RBAC、ABAC和SpEL的完整权限系统：

```java
@Service
public class HybridAuthorizationService {

    @Autowired
    private RbacService rbacService;

    @Autowired
    private AbacEngine abacEngine;

    @Autowired
    private DynamicPermissionService dynamicPermissionService;

    // 综合权限检查
    public boolean authorize(AuthorizationRequest request) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();

        // 1. 首先检查RBAC基础权限
        if (!rbacService.hasPermission(request.getUserId(),
                                       request.getResource(),
                                       request.getAction())) {
            log.debug("RBAC权限检查失败");
            return false;
        }

        // 2. 然后进行ABAC细粒度控制
        AbacContext context = buildAbacContext(request);
        if (!abacEngine.evaluate(context)) {
            log.debug("ABAC权限检查失败");
            return false;
        }

        // 3. 最后检查动态SpEL规则
        if (!dynamicPermissionService.evaluate(request.getResource(),
                                              request.getAction(),
                                              auth)) {
            log.debug("动态权限检查失败");
            return false;
        }

        log.info("权限检查通过: user={}, resource={}, action={}",
                request.getUserId(), request.getResource(), request.getAction());
        return true;
    }

    // 带缓存的权限检查
    @Cacheable(value = "permissions",
               key = "#request.userId + ':' + #request.resource + ':' + #request.action")
    public boolean authorizeWithCache(AuthorizationRequest request) {
        return authorize(request);
    }
}

@RestController
@RequestMapping("/api/secure")
public class SecureResourceController {

    @Autowired
    private HybridAuthorizationService authService;

    @GetMapping("/resource/{id}")
    public ResponseEntity<?> getResource(@PathVariable Long id) {
        AuthorizationRequest request = AuthorizationRequest.builder()
            .userId(getCurrentUserId())
            .resource("secure_resource")
            .action("read")
            .resourceId(id)
            .build();

        if (!authService.authorize(request)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body("Access denied");
        }

        return ResponseEntity.ok(resourceService.findById(id));
    }
}
```
