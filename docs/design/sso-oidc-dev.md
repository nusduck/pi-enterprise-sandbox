# 公司 SSO 接入（OIDC，研发环境版）

日期：2026-10-01。分支 `codex/sso-oidc`，叠在 P1（`codex/sso-reservation-main`，
[预留设计](sso-integration-reservation.md)）之上。
验证记录：[evidence/2026-10-01-sso-oidc-dev.md](../evidence/2026-10-01-sso-oidc-dev.md)。
本文是 P2–P4 在研发环境的**收窄实施**：公司侧资料（issuer、client、claims 样本、回调登记）
尚未提供，联调前用开发替身（mock-oauth2-server）验证整条链路；资料到位后只改配置。

## 1. 产品决定（2026-10-01，用户确认）

参考 HiAgent 一类企业智能体平台的常见做法，按研发环境收窄：

| # | 决定 | 对原预留设计的影响 |
|---|------|------------------|
| 1 | 不绑定/迁移已有本地账号：研发环境，用户与数据都是测试数据 | 去掉「本人确认绑定已有账号」流程；同名本地账号直接冲突 409 |
| 2 | 本地账号密码只留给部署管理员（`SANDBOX_AUTH_ADMIN_USERNAMES`，即 `admin`），作应急入口 | SSO 打开后：非名单用户本地登录 403，公开注册关闭 |
| 3 | 平台角色不从 claims 映射，由 admin 在「成员与角色」页授予 | JIT 用户零角色；SSO 会话**不走**按用户名的部署名单引导 |
| 4 | 不做停用传播、全局退出 | 会话到期自然失效；退出只撤销本平台 sid |
| 5 | 公司员工都可登录，统一落入一个 org | 准入策略固定为 JIT + 单 org（`SSO_ORG_ID`） |
| 6 | 工号来自可配置 claim；内部 userid 由平台生成 | `(iss, sub)` 为绑定键，工号只是属性（同时作为用户名） |

未做、等公司资料或另立 PR：通讯录同步与按部门授权、
HTTPS/Secure Cookie、多 IdP、refresh token。智能体按员工可见见 [agent-visibility.md](agent-visibility.md)。

与[预留设计 §4.2](sso-integration-reservation.md) 的有意偏差：**没有** Agent 侧的「登录事务消费账本」。
浏览器路径上，事务 Cookie 一次性清除、IdP 的 code 一次性，重放已在真实链路验证失败；但持有
内部 token 的调用方可以在 ID token 有效期内把同一个 token 再交给 `/internal/auth/oidc/exchange`
换出新会话。信任边界是既有内部 token（生产必须配置 `AGENT_INTERNAL_TOKEN`，开发 Compose 的
`AGENT_ALLOW_UNAUTHENTICATED_INTERNAL=true` 只绑定回环）。接公司生产前若要收紧，按 nonce 或
`jti` 建一次性消费表，与会话签发同事务写入。

## 2. 登录模式

| 配置 | `GET /api/auth/config` 的 `mode` | 本地登录 | 注册 | SSO 入口 |
|------|------------------------------|---------|------|---------|
| `SSO_ENABLED=false`（默认） | `local` | 所有人 | 按 `SANDBOX_AUTH_ALLOW_PUBLIC_REGISTER` | 「尚未开放」文案 |
| `SSO_ENABLED=true`，两侧配置完整 | `sso` | 仅管理员名单（403 `LOCAL_LOGIN_RESTRICTED`） | 关闭（403 `REGISTRATION_DISABLED`） | 主按钮 |
| `SSO_ENABLED=true`，任一侧缺配置 | `sso` | 仅管理员名单 | 关闭 | 「暂不可用」，无可点入口 |

`sso.available` 由 Agent（能否验签）与 BFF（是否持有 client secret、回调地址、事务密钥）
**取与**：BFF 只能把 `true` 压成 `false`。

## 3. 身份模型

```
公司 IdP (iss, sub, employee_id claim)
        │  tbl_agsvc_sso_identities：(issuer, subject) 唯一 → external_user_id，employee_id 为属性
        ▼
tbl_agsvc_auth_credentials（username = 工号，password_hash = 不可校验的占位）
        │  既有链路：users.external_subject = bff:<external_user_id>、Membership、member_roles
        ▼
平台内部 user_id（ULID）—— 会话、Run、资源归属都挂在它上面
```

- SSO 用户也有一行凭据，是为了复用 P1 的整条身份链（会话行、活跃准入、资料页、通知开关），
  而不是再造一套。占位哈希的算法前缀不是 `pbkdf2_sha256`，`verifyPassword` 恒为 false。
- 工号缺失或不是合法用户名 → 用户名取 `sso_<sha256(iss,sub) 前 16 位>`，不编造工号。
- 工号等于管理员名单里的用户名 → 409 `IDENTITY_BINDING_CONFLICT`（防止与应急账号混淆）。
- 同名的本地密码账号已存在 → 409，不自动合并。
- 并发首次登录靠两个唯一约束收敛；「凭据写成、关联没写成」的残留，下次登录会认领
  （同名、未绑定、占位哈希、同一 SSO org），否则会永久 409。
- 同一 `(iss, sub)` 工号变化 → 仍是同一账号，`employee_id` 属性随登录刷新，用户名不改。

## 4. 流程与职责

### 4.1 BFF（`api-server/src/application/sso-flow.ts`、`routes/sso.ts`）

1. `GET /api/auth/sso/login?return_to=/path`：openid-client 做 discovery（issuer 精确匹配、
   有超时；失败不缓存），生成 PKCE（S256）、state、nonce；事务写进**加密** Cookie
   （jose JWE `dir`+`A256GCM`，HKDF 派生钥，`Path=/api/auth/sso`、HttpOnly、SameSite=Lax、
   默认 10 分钟），Cookie 名带 state 前缀，多标签页互不覆盖；302 到 IdP。
2. `GET /api/auth/sso/callback`：按 query 的 state 取回事务（缺失/过期/被改/state 不符 →
   `SSO_STATE_INVALID`）；IdP 回 `error` → `SSO_ACCESS_DENIED` / `SSO_CALLBACK_INVALID`；
   openid-client 换票并校验 state、nonce、ID token；把 ID token + nonce 交 Agent；
   成功写会话 Cookie 并 303 回 `return_to`。事务 Cookie 无论成败都清除。
3. 失败一律 303 到 `/?sso_error=<稳定错误码>`，日志只记错误码。`return_to` 只接受站内路径
   （拒绝 `//host`、`/\host`、绝对 URL、回到 SSO 入口自身）。
4. 公司 access token 不出 BFF；client secret 与事务密钥只注入 BFF 容器。

事务存加密 Cookie 而不是 Redis：BFF 没有存储权威（Compose 显式清空了它的 Redis 连接），
多副本回调不依赖副本内存。code 由 IdP 保证一次性，重放旧事务 Cookie 换不到新票
（真实链路已验证）。

### 4.2 Agent（`oidc-id-token-verifier.ts`、`sso-login-service.ts`）

`POST /internal/auth/oidc/exchange`（内部 token 面）：jose 独立验签——固定 issuer
（discovery issuer 逐字匹配，JWKS 必须与 issuer 同源，否则显式配置 `SSO_JWKS_URI`）、
非对称算法白名单、`aud` 含 client、多 audience 时 `azp`、`exp`/`iat`/`nonce`/`sub` 必填、
nonce 常量时间比较。JWKS 拉不到 → 503 `SSO_UPSTREAM_UNAVAILABLE`；其余 → 401
`SSO_TOKEN_INVALID`。之后按 §3 找人或建号，交给 `BrowserAuthService.establishSsoSession`：
与本地登录共用活跃准入与 sid 签发，`login_method=sso`、`identity_provider=<issuer>`。

### 4.3 前端（`shared/api/sso.ts`、`ConversationSidebar.tsx`）

SSO 按钮是指向 `/api/auth/sso/login` 的整页链接（带当前路径作 `return_to`）。
`mode=sso` 时账号密码表单默认收起为「管理员账号登录」。`?sso_error=` 读出后翻成固定文案并用
`history.replaceState` 抹掉；未知码用通用文案，不回显 URL 里的文本。

## 5. 配置

见 `.env.example` 的「公司 SSO」段与 [deployment.md](../deployment.md)。要点：

- 两侧共享：`SSO_ENABLED`、`SSO_ISSUER`、`SSO_CLIENT_ID`、`SSO_ALLOW_INSECURE_HTTP`、`SSO_REQUEST_TIMEOUT_MS`。
- 仅 BFF：`SSO_CLIENT_SECRET`、`SSO_REDIRECT_URI`、`SSO_SCOPES`、`SSO_TRANSACTION_SECRET`（≥32）、
  `SSO_TRANSACTION_TTL_SECONDS`。
- 仅 Agent：`SSO_EMPLOYEE_ID_CLAIM`（默认 `employee_id`）、`SSO_DEPARTMENT_CLAIM`（默认空 = 不读部门）、`SSO_ORG_ID`、`SSO_JWKS_URI`、`SSO_LABEL`。
- `SSO_ALLOW_INSECURE_HTTP` 只给开发替身；生产 issuer/回调必须 https。

## 6. 错误码

| 码 | 来源 | 含义 |
|----|------|------|
| `SSO_STATE_INVALID` | BFF | 事务缺失、过期、被篡改、state 不符 |
| `SSO_CALLBACK_INVALID` | BFF | 回调参数非法、换票失败、ID token 校验失败 |
| `SSO_ACCESS_DENIED` | BFF | 用户在 IdP 拒绝授权 |
| `SSO_CONFIG_UNAVAILABLE` | 两侧 | 配置缺失/非法、discovery issuer 不符、JWKS 跨源 |
| `SSO_UPSTREAM_UNAVAILABLE` | 两侧 | IdP 网络失败或超时 |
| `SSO_TOKEN_INVALID` | Agent | 签名/声明/nonce 校验失败 |
| `SSO_ACCESS_UNAVAILABLE` | Agent | 凭据已停用 |
| `IDENTITY_BINDING_CONFLICT` | Agent | 工号撞管理员名单或已有本地账号 |
| `LOCAL_LOGIN_RESTRICTED` | Agent | SSO 模式下非管理员用账号密码登录 |

## 7. 开发替身

`docker compose --profile sso-dev up -d mock-oidc`（`ghcr.io/navikt/mock-oauth2-server:3.0.1`）。
它按请求 Host 生成 issuer，所以浏览器与容器都用 `http://oidc.localhost:8090/default`：
浏览器把 `*.localhost` 解析到本机（端口 8090 发布在 127.0.0.1），容器经 `backend_internal`
上的网络别名 `oidc.localhost` 直连。交互式登录页随意填 `sub`，claims 填如
`{"employee_id":"E1001","name":"张三"}`。

站点必须用 `http://localhost:3000` 访问（与 `SSO_REDIRECT_URI` 同 host），否则回调写的
会话 Cookie 与页面不同源。启用方式见 [development.md](../development.md)。

## 8. 换成公司 IdP 时

1. 拿到 issuer、client_id/secret，登记回调 `<站点 origin>/api/auth/sso/callback`；
2. 要一份脱敏 ID token claims，确认工号字段名 → `SSO_EMPLOYEE_ID_CLAIM`；
3. 站点改 HTTPS，Cookie 加 `Secure`（`api-server/src/http/cookies.ts`），`SSO_ALLOW_INSECURE_HTTP=false`；
4. 若 JWKS 不在 issuer 同源，配 `SSO_JWKS_URI`；若 IdP 要求 `client_secret_basic`，需改
   `sso-flow.ts` 的 client 认证方式（当前固定 `client_secret_post`）。

## 9. 部门预留（2026-10-03）

本期按部门授权不做，只做预留——记录与展示，不做任何按部门授权的业务判定：
- 配置：Agent 新增环境变量 `SSO_DEPARTMENT_CLAIM`（部门 claim 名，默认空 = 不读部门）。
- 存储：`tbl_agsvc_users` 加 `department VARCHAR(255) NULL` 列。
- 写入规则：首次 JIT 建用户时，以及每次 SSO 登录时，若配置了部门 claim 且 claim 是非空字符串（trim 后，最长 255），写入 `users.department`；claim 缺失或为空时保持原值不变（不清空）。只接受字符串，其他类型忽略。claim 名为空时完全不读、不写。
- 展示：管理端成员列表接口（`/api/admin/users`）与前端「成员与角色」页（`MembersPage.tsx`）增加「部门」字段与展示列，空值显示「—」。只读字段，不提供修改接口。
- 以后按部门授权要另立设计，待定问题包括：
  - 部门作为授权主体加入智能体可见范围 `agent_user_grants` 的扩展（或独立 `agent_department_grants`）；
  - 部门来源以 SSO ID token claim 为准还是以企业通讯录定时全量同步为准；
  - 树状部门层级与继承关系。

