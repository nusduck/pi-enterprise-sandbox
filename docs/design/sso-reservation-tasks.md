# SSO 预留改造：DSH 实施交接

日期：2026-10-01。基线 main@5bc21550；工作分支 `codex/sso-reservation-main`。
设计：[sso-integration-reservation.md](sso-integration-reservation.md)。
状态：P1a/P1b 已由 DSH 实施，主代理完成 review 与真实链路验收；全套检查存在 main 基线失败，不能声明全绿。
详细结果：[review](../reviews/2026-10-01-sso-reservation/README.md)、[验证记录](../evidence/2026-10-01-sso-reservation-p1.md)。

本轮范围 P1a/P1b：协议无关的认证底座、可撤销 local 会话、登录能力投影与浏览器身份边界。
公司 OIDC 回调、SSO 身份关联/JIT/绑定、refresh/global logout 属于 P2–P4，保持禁用。
不承诺企业 SSO 已完成；先让未来接入不依赖密码凭据和陈旧角色快照。

## 负责人和文件所有权

- DSH Agent：只编辑 `agent/`（服务、仓储、新迁移、工厂/路由和相关测试）。
- DSH BFF：只编辑 `api-server/`（config/logout 代理、认证写请求防护、SSE 重授权与测试）。
- DSH frontend：只编辑 `frontend/`（DTO、登录方式、认证错误/重试、身份清理、账户来源与测试）。
- 主代理：设计与活跃文档、schema manifest、Compose/env 接线、共享容器/数据库、最终验收和 review。

各 DSH 不是独占工作区，不得撤销其他人的改动；不得切分支、提交、推送、操作 Docker、
重建共享数据库或提升行数预算。包内相关测试自行跑；跨包全套与容器验收由主代理统一执行。
跨包契约变化先通知主代理与另一端，禁止双方猜默认值。

## 锁定 DTO 和行为

`GET /internal/auth/config` 仅通过既有内部 token gate；BFF 代理为公开 `GET /api/auth/config`。
Agent 是登录能力权威。本轮固定 local（不新增没有真实消费者的 SSO 环境变量）：

```json
{
  "mode": "local",
  "methods": {
    "local": {"enabled": true, "registration_enabled": false},
    "sso": {"enabled": false, "available": false, "label": "公司 SSO"}
  },
  "profile_policy": {"editable_fields": ["display_name", "email", "notify_run_complete"]}
}
```

registration_enabled 来自实际 allowPublicRegister；JWT secret 或权威配置缺失返回 503，
不返回假的可用能力；网络/解析失败不能当空能力。没有 SSO 可用入口，也不伪造回调路由。
登录、me、profile 增加 `login_method:"local"`、`identity_provider:null`；保留 `roles` 集合、
兼容 `role` 和外部 id/org。role 权威仍是 `MemberRoleService`/`member_roles`。
未来 SSO 不调用 `ensureDeploymentGrant(username)`，本地名单引导继续保持原语义。

Local login/register 签发带 sid 的 JWT，会话保存内部 owner 与外部兼容映射、来源、
created/expires/revoked。新表直接用 UPspec 物理名，真实迁移与 schema manifest 必须同步。
每个 me/profile/updateProfile 检查会话与 active user/org/Membership；身份/组织不可仅用缓存。
旧无 sid JWT 统一 401，部署后重新登录；不自动交换旧 JWT，不改历史 user/org/资源 owner。
拆模块只到可复用会话/JWT/准入边界，不为了形式重写整个密码/provider/profile 栈。

`POST /internal/auth/logout`：内部 token + authorization；仅撤销当前 sid，幂等。
BFF `POST /api/auth/logout` 总是尝试清 Cookie，契约：

- 200 `{ok:true,revocation:"confirmed"}`：有效 sid 已撤销。
- 200 `{ok:true,revocation:"not_required"}`：无凭据/无效签名/已到期/已撤销/缺 sid
  （无 sid 旧 JWT 按普通无效会话处理：Agent 返回 401 `INVALID_TOKEN`，BFF 映射为
  `not_required`；旧 409 `LEGACY_SESSION_NOT_REVOCABLE` 分支已删除），无数据库写入或幂等读取。
- 503 `{error,code:"AUTH_REVOCATION_UNCONFIRMED"}`：DB/内部网络失败或超时；不得 `{ok:true}`。

禁止把所有上游错误都当无需撤销；BFF 只映射真实故障，不吞代码；响应 no-store。
浏览器即使 logout 失败也清本机用户/流/实体/附件/选中会话，保留“撤销未确认”的可见提示；
不拿可能已切号的当前 Cookie 自动重试。401 与 503 分开：boot/refresh 503 显示错误与重试，
不主动 logout、不清草稿、不把能力加载失败当未登录；只在 401 执行匿名身份清理。
真正 login/register 换人时完整清理旧数据；generation 检查覆盖过期 me/config/catalog/会话响应。
账户登录来源来自 profile 字段，editable_fields 仍由服务器决定。

BFF 认证写请求（login/register/logout/PATCH profile）拒绝明确的跨站 Origin/Fetch Metadata。
保留无 Origin 的可信非浏览器 Bearer 调用成功对照；不能靠 CORS 或“全拒绝”测试证明防护。
本轮 cookie 的 HTTP 开发兼容保持；生产 OIDC 的 HTTPS/Secure 作为 P3 开启门槛。
打开的 cookie/Bearer SSE 需有界重授权：目标每 15s，单次出站 timeout 沿用有限配置；
401/权威故障 fail-closed 关流，释放计时器和 relay；退出不取消已经运行任务。

## 分包验收和交接

Agent：带 sid 登录成功；撤销后同 JWT 401；另一个 sid 不受影响；过期/旧 JWT/状态停用拒绝；
同一会话 roles 撤销下一请求生效；角色账本不可达返回 503。Repository 接线需要真实数据库证明。
BFF：生产路由 config/logout 接线、凭据来源、token 不入浏览器 JSON；撤销成功/失败/幂等对照；
跨站拒绝与同源/Bearer 成功；已有 SSE 撤销后在有界时间关闭并无 timer/连接泄漏。
Frontend：config/me loading/error/retry、401/503、禁用注册、无 SSO 假入口；profile 来源；
退出失败后清理但提示未确认；切号丢旧流/响应；失败登录保留当前草稿；按行数预算抽模块。

各包交接列出：改动文件、完成项、剩余项、回归结果及实际 runtime；不得把 mock 等价成真机。
最终主代理按 AGENTS.md §4 跑六套、类型检查、frontend build、Compose 校验；真实迁移重放
生成 manifest；重建/更新容器；浏览器登录/资料/退出/切号和失败路径；工具 run、logs/signal、
跨租户 404；review 发现的阻塞项先修再复验。公司联调明确留待后续，不记为通过。

P1 review 补充契约：BFF 到 Agent 的连接失败、超时或成功响应 JSON 无法解析统一为
`503 AUTH_DEPENDENCY_UNAVAILABLE`（login/register/me/profile）；config 保留
`AUTH_CONFIG_UNAVAILABLE`，logout 保留 `AUTH_REVOCATION_UNCONFIRMED`。
明确的上游 400/401/403/409/422 与 `AUTH_STORE_UNAVAILABLE` 保留原语义。
