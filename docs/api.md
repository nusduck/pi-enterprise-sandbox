# API Reference

DSH Enterprise Sandbox API 分层：

| 层 | 组件 | 说明 |
|----|------|------|
| **Public** | Frontend Nginx | `/api/*` 反向代理到 API Server |
| **API Server (BFF)** | Node.js 22 (port 4000) | Run API/SSE relay、健康探针、文件上传/下载代理 |
| **Agent** | Node.js 22 (port 4100) | 内部 Run API + DeepSeek Harness（浏览器不直连） |
| **Sandbox（执行面）** | Node.js/TypeScript (container 8081，无宿主映射) | Agent 专用内部执行平面（HMAC `/internal/v1/*`）+ 对 BFF 的公共会话面；文件/执行/搜索/进程/数据集/产物（Docker 内网） |

无 Python Agent Runtime、无双 Runtime 开关。Agent **支持零 Skill 启动**；共享 `skills/` 挂载与 package skills 由 Agent Profile 策略 + session capability registry 控制。

> **Sandbox 端口 8081 仅 Docker 内网可访问；compose 里该服务没有 `ports:` 段，dev 与生产都不发布宿主端口**。Agent 调用正式执行能力使用 HMAC-authenticated `/internal/v1/*`；浏览器不能直连 Sandbox，也不能提供 Sandbox service credential。BFF `/api/*` 是唯一浏览器 API 边界。
> Agent 侧 MCP 由启动期 `@deepseek-ai/dsh-mcp-client` 直连企业 MCP Gateway/Server 并执行 `tools/list`，不经过 exec，也不向浏览器暴露凭据。对外的 Streamable HTTP MCP facade 是 exec 镜像的第二入口（compose: `sandbox-mcp`），只走 `/internal/mcp/v1/*` 窄桥。

---

## 一、SSE 事件协议

浏览器只消费 **平台事件**：`GET /api/runs/{run_id}/events`（以及会话级事件回放）返回的每一帧都是 BFF 转发的
Agent 事件信封，类型为点分名称，并带持久 `sequence` 与 `event_id`：

```text
id: 01K...
event: tool.execution.completed
data: {"sequence":18,"event":{"type":"tool.execution.completed","event_id":"01K...","data":{...},"context":{...}},"ts":...,"event_id":"01K..."}
```

事件族（以 Agent 实际写入 `run_events` 的为准；前端映射见 `frontend/src/shared/state/platformEventNormalize.ts`）：

| 族 | 事件 | 说明 |
|----|------|------|
| Run 生命周期 | `run.accepted` / `run.queued` / `run.started` / `run.status.changed` / `run.completed` / `run.failed` / `run.cancelled` | 状态机迁移，`status` 为大写状态机值 |
| 消息 | `message.delta` / `message.completed`、`thinking.*` | 文本与思考增量；用户回合以 `message.completed`（`role: "user"`）落库 |
| 工具 | `tool.call.proposed` / `tool.execution.started` / `tool.execution.progress` / `tool.execution.completed` / `tool.execution.failed` | 以 `toolCallId` 关联，`toolName` / `args` / `result` / `isError` |
| 审批与交互 | `approval.requested` / `approval.resolved`、`interaction.*` | 高风险工具等待人工审批；同一 key 只产生一个 durable approval |
| 产物 | `artifact.ready` | 仅 `submit_artifact` 成功后（含 `artifactId`）；`write` / `edit` / bash 不会触发 |
| 模型与会话 | `model.request.started/completed/failed`、`session.snapshot.saved`、`session.compacted` | 观测与会话账本事件 |

进程状态与日志不走事件流：由 `GET /api/processes`（按会话列出）与 `GET /api/processes/{id}/logs` 提供。

旧的无点号事件名（`token`、`tool_start`、`tool_end`、`file_ready`、`done`、`session`、`trace`、`session_closed` 等）
**已不存在**：Agent 不再发出，前端也不再适配。真实线上帧的回放见 `frontend/test/fixtures/live-run-sse.json`
（`frontend/test/live-run-replay.test.ts` 逐帧喂给浏览器同一条摄入路径）。

---

## 二、API Server API

Base URL: `http://host:4000`

### `POST /api/runs` — 创建 Agent Run（PR-10 / plan §18.3）

等价路由：`POST /api/conversations/{conversation_id}/runs`（路径上的 conversation 优先）。

**必须**携带 `Idempotency-Key`。相同 key + 相同请求体幂等重放；key 冲突返回 409。

```json
// Request（legacy messages[] 或 plan message.content[]）
{ "messages": [{ "role": "user", "content": "写一个 Python 脚本" }], "conversation_id": "optional", "agent_profile_id": "coding-agent" }
```

响应 **202 Accepted**（Run 已写入 MySQL 后才返回；从不使用 201）：

```json
{
  "runId": "01...",
  "run_id": "01...",
  "conversationId": "01...",
  "agentSessionId": "01...",
  "status": "ACCEPTED",
  "eventsUrl": "/api/runs/01.../events"
}
```

### `GET /api/runs/{run_id}/events` — SSE Replay（PR-10）

```http
GET /api/runs/{run_id}/events?afterSequence=17
Accept: text/event-stream
Last-Event-ID: 01K...   # 或历史 sequence 数字
```

连接流程（Agent 权威；BFF 做 ownership + 字节代理）：

1. BFF / Agent 校验 Run ownership（跨用户/跨租户 **404** fail-closed）
2. MySQL `run_events` 按 sequence 重放 `afterSequence` / Last-Event-ID 之后的历史
3. 切换 Redis `run:stream:{runId}` 实时加速
4. watermark + MySQL catch-up 消除订阅建立竞态（禁止跳号）
5. sequence 单调去重；Redis 故障回退 MySQL poll
6. Heartbeat：`event: ping` + `{"timestamp":"..."}`

SSE 帧：

```text
id: 01K...
event: tool.execution.completed
data: {"sequence":18,"event":{...},"ts":...,"eventId":"01K..."}

```

浏览器刷新：`GET /api/runs/{id}` + 从 `lastSequence` / `lastEventId` 重建 SSE，不依赖进程内 buffer。

可用 `POST /api/runs/:id/cancel|steer` 控制（cancel 亦要求 `Idempotency-Key`）；追问使用 Conversation 维度的 `POST /api/conversations/:id/follow-ups`；审批恢复使用 `resume-approval`，用户输入使用 `/interactions/:interactionId/respond`。

`GET /api/runs/{id}` 还返回 `started_at`、`completed_at`（兼容字段
`finished_at`）、`error`、`last_event_id` 与可用时的 `model_id` / `usage`；时间字段统一为 ISO 8601。Run 列表同样可包含模型与 token usage 的轻量投影，来源是 durable 事件，不是进程内计数器。

`GET /api/extensions/diagnostics` 返回 Extension Package、Agent Profile、Tool/MCP allowlist 和供应链审计状态，不含凭据。MCP 工具以 `mcp__{serverName}__{toolName}` 出现在 `tools` / `registry.mcp_tools`。

**2026-08-31（ADR 0009 D9）起，这份就绪度是 DSH 工具注册表的投影**，不再是自建 adapter 的探测快照：一台 MCP 服务器 = overlay 里一个 `@deepseek-ai/dsh-mcp-client` 实例，它注册到 `ctx.tools` 上的东西就是模型看得见的东西，所以 `/ready` 与模型工具面不可能不一致。连接、退避重连与 `notifications/tools/list_changed` 重新同步由该插件负责；**配置变更（`MCP_SERVERS_JSON`）须重启 Agent** 才会生效（boot 时按环境叠进插件树，不必重跑 `npm run gen:patch`）。工具名超长或含非法字符时出厂包会规范化并追加 12 位十六进制哈希，风险表因此必须有 `mcp__<server>__*` 前缀条目——漏配会落到 `high`（要审批），不会落到放行。响应在兼容既有 `extensions` / `tools` / `skills` / `mcp_servers` 字段的同时，增加：

| 字段 | 说明 |
|------|------|
| `view` | `configured`（尚无会话快照）或 `live`（合并最近兼容 run 的 registry 快照） |
| `registry` | `live`、`registry_version`、`run_id`、`profile_id`、`counts`、可选 `mcp_tools` |
| `*.status` | `configured` \| `connected` \| `disabled` \| `failed`（不再一律 `enabled: true` 冒充已激活） |
| `profile.shared_skills` | 共享 skill 挂载策略（`all` \| `allowlist` \| `none`） |

`GET /api/capabilities/{skills,mcp,tools,models}` 仍从 diagnostics 投影列表；字段可附加 `status` / `dynamic`。

`skills` 是**按调用者投影**的：Agent 用服务端写入的 `X-Acting-User-Id` / `X-Acting-Organization-Id` 解析内部 owner，列出系统层、**本 org 的 org 共享层**、该 owner 的已发布层和草稿层。`source` 分别为 `shared-skill-root`、`org-skill-root`、`user-skill-root`、`draft-skill-root`；浏览器传入的同名 header 不会被透传。

**2026-08-31（ADR 0009 D7）起，用户侧 Skill 有三个根**：系统根（只读，永远进 prompt）、已启用根（逐包只读，进 prompt）、**草稿根 `/home/sandbox/skill-draft`**（每用户一个，模型可写，**不进发现也不进 prompt**）。模型用 `write` / `bash` 在草稿根里造包——`skill_install` / `skill_create` / `skill_edit` / `skill_uninstall` 这四个工具**已整体取消**。闸门只剩一处：人在 UI 上按「启用」，那一刻平台校验结构、**把字节复制成一份只读的已发布版本**、记内容摘要与启用态（`user_skill_enablements`，owner-scoped）。因为是两份字节，模型之后改草稿动不了已启用的包，所以不需要每 Run 重算摘要。请求不带身份时只投影系统层；用户层基目录**永远不整根扫描**，否则会跨租户列出他人已安装的 Skill。

**2026-09-14（design §3.3 S1）起，启用账本是用户层发现的唯一依据**：已发布字节按摘要分版本存放（`<name>/.v/<digest>/<name>/` + 侧车 `<name>/.v/<digest>.json`），摘要按复制后的字节计算。Run 开始时 Worker 按账本逐条核对版本目录与侧车，得到本 Run 的清单；模型看到的 Skill 路径是 exec 的挂载路径 `/home/sandbox/skill-user/<name>`。清单随每个内部请求进入签名覆盖的请求体（GET 为规范化 query），exec 只挂载清单点名的版本：缺版本或侧车不符返回 `SKILL_PACKAGE_UNAVAILABLE`，存储不可读返回 `SKILL_STORE_UNAVAILABLE`，不再当成「没有 Skill」。

启用/停用入口是 `POST /api/capabilities/skills/{name}/enable|disable`。BFF 只做代理与身份投影；Agent 在一个 MySQL 事务里锁住该 owner 的 membership 行，校验并发布版本、写或删账本行，再回收旧版本。**停用只删账本行，不删字节**：仍在运行、清单里点着该版本的 Run 继续可用；不再被账本引用且超过 `SKILL_VERSION_GC_GRACE_MS`（默认 24 小时）的版本在同名包下次启停时回收。

草稿在**启用之后不会消失**——启用是复制字节，草稿留在原地当可编辑的源，停用只撤销启用。所以 `skill_drafts` 里会一直有它；这类条目带 `published: true` 与 `status: 'published'`，与还等着人按「Enable」的 `published: false` / `status: 'draft'` 区分。UI 的 Drafts 区只列后者，否则同一个名字会在页面上出现两次。要重新发布一份改过的草稿，先在 My Skills 里 Disable，草稿会回到 Drafts。

草稿包上传入口是 `POST /api/capabilities/skills/drafts`。支持通过 UI 或客户端直传 `.zip` 与 `.skill` 归档包（请求头带 `X-Filename`，流式二进制 body，单包上限 50MB）。BFF 受信鉴权后透传 Agent；Agent 校验包结构与 `SKILL.md`，解压落入当前用户的草稿根目录 `/home/sandbox/skill-draft/<org>/<user>/<skill-name>/`，状态保持为未启用（`enabled: false, status: 'draft'`）。草稿不进模型发现、不进 prompt，等待用户在 UI 上点击「Enable」正式启用。

### 清单契约：`systemSkills` 与 `enabledSkills[].scope`（ADR 0015 D4/D5，design §6.3、§8）

内部面（`/internal/v1/*`）的请求体顶层两个字段都在 HMAC 覆盖范围内（POST 进 `body_sha256`，
`fs/stream-text` 的 GET 进规范化 query）：

| 字段 | 说明 |
|---|---|
| `systemSkills: string[]` | 本 Run 选中的**系统层**包名（≤256，`SKILL_NAME_PATTERN`，不重复）。**空数组是合法值**，表示一个系统包都不带。缺省见下文（滚动升级兼容期） |
| `enabledSkills[].scope` | `user`（缺省）\| `org`。exec 按它选 owner 根：`<orgId>/<userId>` 或 `<orgId>/_org` |

带了 `systemSkills` 时系统层**逐包** `ro_bind` 到 `/home/sandbox/skill/<name>`，fs 面
（`read` / `glob` / `grep`）同样只放行名单里的包，系统根本身不可寻址——没进名单的包无论经
bash 还是经文件工具都不存在。系统包是**硬绑定**（`required: true`）：字节随 release 交付、
运行期不可变，缺包是部署故障，要在 spawn 之前带路径说清楚；用户 / org 包仍是
`required: false`——一个包挂不上不该让这个用户连 `pwd` 都用不了。

**滚动升级兼容期（design §8）**：请求没带 `systemSkills` 视为旧 Agent，exec 维持整树只读
挂载，并按分钟汇总一条 `[skills] … internal request(s) without systemSkills` 告警。全部 Worker
升级、这条告警在所有 exec 上归零后，才把缺省改成 `ENVELOPE_INVALID`（尚未收紧）。
公共面、MCP 窄桥与 `isolation/preflight.ts` 的探针不带名单，维持整树只读（与 ADR 0015 之前相同）。

同一名字同时出现在 `systemSkills` 与 `enabledSkills` 里 → `ENVELOPE_INVALID`（Agent 侧已按
system > org > user 去重，出现即是调用方拼错）。

### 共享申请与审批（ADR 0015 D6，design §7.1–§7.3）

**浏览器面（BFF）**：`/api/capabilities/skills/share-requests*`（用户侧）与
`/api/admin/skills/share-requests*`（管理员侧）。BFF 只转发与投影身份——角色判定、
org 作用域、状态机合法性都在 Agent；浏览器的同名 `X-Acting-Role` 头不会被透传。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/capabilities/skills/{name}/share-requests` | body `{ note? }`。对当前用户**已启用**的版本发起申请，钉住该摘要。未启用 → 409 `SKILL_NOT_ENABLED` |
| `GET` | `/api/capabilities/skills/share-requests` | 本人的申请列表 |
| `POST` | `/api/capabilities/skills/share-requests/{id}/withdraw` | 撤回本人的 `pending` |
| `GET` | `/api/admin/skills/share-requests?status=&limit=&cursor=` | **admin**：本 org 的申请队列，返回 `{ requests, next_cursor }`（键集分页见「列表分页」，默认每页 50） |
| `GET` | `/api/admin/skills/share-requests/{id}/manifest` | **admin**：被申请版本的文件清单与截断 `SKILL.md`（只看这一个版本，不开放浏览作者的其他 Skill）。响应 `{ request, name, contentDigest, fileCount, totalBytes, files[], skillMd, truncated }`，摘要字段与 org 版本清单同形 |
| `POST` | `/api/admin/skills/share-requests/{id}/approve` | **admin**：body `{ setCurrent?, note? }`。复制作者**已发布**版本到 org 层并重算摘要，不一致即拒绝 |
| `POST` | `/api/admin/skills/share-requests/{id}/reject` | **admin**：body `{ note }`，**必填**（没有原因的驳回在审计里等于没解释） |

**Agent 内部面**是同一组操作，路径为 `/internal/skills/share-requests*`。用户侧与管理员
共用这一条路径，靠 `scope=org` 区分列表口径——**权限判定不靠这个参数**：`scope=org` 仍要过
admin 检查，而且这个参数由 BFF 写死（浏览器不能拿它换到别人的名单）。

错误码：`ADMIN_REQUIRED`(403)、`SKILL_SHARE_REQUEST_UNKNOWN`(404，含跨 org 与跨用户——不泄漏存在性)、
`SKILL_NOT_ENABLED`(409)、`SKILL_ORG_NAME_TAKEN`(409，名字已被别的作者占用)、
`SKILL_SHARE_REQUEST_DECIDED`(409，终态不能二次决定)、
`SKILL_SHARE_DIGEST_MISMATCH`(400，作者在申请后改过——申请**保持 pending**)、
`SKILL_SHARE_NOTE_REQUIRED`(400)、`VALIDATION_ERROR`(400，`limit`/`cursor` 形状非法)。

**批准是「先字节后状态」**：字节那一步失败时申请保持 `pending`，作者可以重新发布再申请。
反过来会留下「已批准但 org 层没有这个版本」的不可恢复状态。UI 侧批准失败时**不把行从队列
里拿掉**——拿掉会让人以为已经处理完了。

**名字保留**（§7.3）：与本 org 任一非 `revoked` org 名冲突的包不能启用
（`SKILL_NAME_RESERVED_BY_ORG`），但**原作者豁免**——被提升过的 Skill 的原作者要能继续
启用自己新版本，否则没法迭代草稿。

### org 层共享 Skill 的管理员操作面（ADR 0015 §7.2）

判定沿用既有机制：`AuthSubjects.role` 来自**服务端写入**的 `X-Acting-Role`，不是浏览器能
自己声明的。非 admin → 403（`ADMIN_REQUIRED`）；所有操作的作用域是调用者的**当前 org**，
跨 org 的资源一律 404（不是 403——存在性本身不能泄漏）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/admin/skills/org?filename=<name>.zip&set_current=true` | 管理员直传 `.zip` / `.skill`（流式二进制 body，上限 50MB）。解包与校验复用用户层同一套；落字节到 `<base>/<orgId>/_org/<name>/.v/<digest>/`，**先字节后账本**。名字与系统包冲突 → 400 |
| `GET` | `/api/admin/skills/org` | 本 org 的 org 层列表：每名的版本、状态与 `currentDigest` |
| `GET` | `/api/admin/skills/org/{name}/versions/{digest}/manifest` | 文件清单（相对路径 + 字节数）、截断的 `SKILL.md`、`truncated` 与完整的 `affectedAgentVersionIds` 引用列表。**不返回其它文件的内容** |
| `POST` | `/api/admin/skills/org/{name}/current` | body `{ contentDigest }`；改「当前推荐版本」。**不影响任何已钉住的 AgentVersion** |
| `POST` | `/api/admin/skills/org/{name}/versions/{digest}/deprecate` | body `{ reason }`；只挡**新绑定**，已钉住的版本照常运行 |
| `POST` | `/api/admin/skills/org/{name}/versions/{digest}/revoke` | body `{ reason }`；安全动作，**立刻**影响新 Run 的解析。响应带 `affectedAgentVersionIds` |

内部面对应 `/internal/skills/org*`，形状与上表逐条相同。

错误码：`ADMIN_REQUIRED`(403)、`SKILL_ORG_VERSION_UNKNOWN`(404)、
`SKILL_ORG_VERSION_REVOKED`(400，撤销过的摘要不允许再次发布)、
`SKILL_ORG_BYTES_MISSING`(400，账本说存在而盘上没有——**存储损坏，不是「没找到」**)。
归档后缀不是 `.zip` / `.skill` → `SKILL_ARCHIVE_INVALID_EXTENSION`(400)；
超过 50MB → `SKILL_ARCHIVE_TOO_LARGE`(413)。

**状态机**：`active → deprecated → revoked`；`deprecated` 可以改回 `active`，`revoked`
是**终态**（不能改回来，也不能用同一摘要重新发布）。已钉住的 AgentVersion 在吊销后
**不被中途撤掉挂载**，但它的**下一个 Run** 会排除该版本并写诊断。

### 成员与角色管理（RBAC 一期：admin / reviewer）

角色权威是 `tbl_agsvc_member_roles`（挂在 `(org_id, user_id)` 上，即组织成员关系）。
`admin` 与 `reviewer` 是**固定角色**，一个人可以同时持有两者；普通用户是默认身份，
不是一条授权。判定用 `hasRole()` 解析 `X-Acting-Role`——那是**逗号分隔的角色集合**
（`admin,reviewer`），不是单值。非 admin → 403 `ADMIN_REQUIRED`；作用域是调用者的
当前 org，跨 org 的 `userId` 与不存在的 `userId` 返回**同一个 404**。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/users?q=&role=&cursor=&limit=` | 本 org 成员列表（只含已 provisioning、至少登录过一次的账号）。响应 `{ members: [{ user_id, username, display_name, email, roles[], pinned_roles[], last_login_at }], next_cursor }`；`q` 匹配用户名或显示名，`role` 只接受白名单值，`limit` 默认 50、上限 200 |
| `PUT` | `/api/admin/users/{userId}/roles/{role}` | 授予，**幂等**（已有该角色返回 200，内容与当前一致，不重复写审计）。响应是上面单个成员对象 |
| `DELETE` | `/api/admin/users/{userId}/roles/{role}` | 撤销，**幂等**（本来就没有该角色返回 200）。删除的是授予行，审计由只追加的 `tbl_agsvc_member_role_events` 承担 |
| `GET` | `/api/admin/users/{userId}/role-events?limit=` | 该成员的角色变更记录（新到旧，`limit` 默认 50、上限 200）：`{ events: [{ event_id, role, action, source, actor_user_id, actor_username, actor_display_name, created_at }] }`，`source` ∈ `console` / `bootstrap` / `migration` |

错误语义：未知角色 → 422 `ROLE_UNKNOWN`；撤销本 org 的**最后一个** `admin`（含撤销自己）
→ 409 `LAST_ADMIN`；撤销**部署锁定**的 admin → 409 `ROLE_PINNED_BY_DEPLOYMENT`。
`pinned_roles` 里的角色在界面上置灰：它的授予由 `SANDBOX_AUTH_ADMIN_USERNAMES` 引导，
撤销后下一个请求又会被引导回来。

「最后一个 admin」的判定在事务里对该 org 的 admin 授予行加 `SELECT … FOR UPDATE` 后计数：
两个 admin 同时互相撤销时，后提交的一方必须得到 409，不能出现 0 个 admin。

内部面对应 `/internal/admin/members*`（`members` 与 `users` 是同一个东西：对内叫成员，对外叫用户）。

### 交付物人工审核（ADR 0016，design §5–§8）

AgentVersion 的 `deliveryPolicy.mode = "review"` 时，这一轮 Run 提交的交付物先落在 exec 的
`held` 状态：**发起人**在会话产物列表、产物库、下载、跨会话导入里都看不到它（404，与不存在同码），
review 工作区的**工作区字节读路径**（文件列表/读取/下载、进程日志）也一律 404——否则「待审」
只是聊天里的一句话。Run 进入任意终态且本轮有 `held` 产物时建审核任务（`UNIQUE(run_id)`）。

审核面需要 **`reviewer`** 角色（不是 `admin`）：非 reviewer → 403 `REVIEWER_REQUIRED`；
**不能审核自己发起的任务** → 403 `REVIEW_SELF_FORBIDDEN`（U8）；作用域是本 org，
跨 org 的任务与不存在的任务返回**同一个 404**。

| 错误码 | 状态 | 触发 |
|---|---|---|
| `REVIEWER_REQUIRED` | 403 | 调用者没有 `reviewer` 角色 |
| `REVIEW_SELF_FORBIDDEN` | 403 | 领取/决定自己发起的任务 |
| `REVIEW_NOT_ASSIGNEE` | 403 | 释放/决定一个别人领取的任务 |
| `REVIEW_ALREADY_CLAIMED` | 409 | 领取一个已被别人领取的任务 |
| `REVIEW_VERSION_CONFLICT` | 409 | `base_revision` 不是当前值（响应带 `current_revision`，前端刷新后保留已选文件） |
| `REVIEW_ALREADY_DECIDED` | 409 | 任务已经通过或驳回 |
| `REVIEW_FEEDBACK_REQUIRED` | 422 | 驳回没有给 `feedback` |
| `REVIEW_FILE_INVALID` | 413 / 422 | 修订版文件为空、名称非法，或超过审核传输上限 100 MiB（BFF/agent 按请求体大小给 413） |
| `REVIEW_FILE_TOO_LARGE` | 413 | 下载的交付物或附件快照超过审核传输上限 100 MiB（内部面以 base64 整件传输，见 contract `REVIEW_TRANSFER_MAX_BYTES`） |

关键语义（写错了会静默出错，所以写在这里）：

- **通过/驳回只记账**：一个事务里改任务状态、写审计事件、在**原 Run** 上追加
  `artifact.released` / `review.rejected` 事件、追加一条会话消息（`assistant/text` +
  `system/status`），并写 outbox。产物**真正放行**要等 agent-worker 的审核循环消费
  `review.decided`：先改可见性（当前版本 → `released`，同一交付物集合里的其它版本 →
  `withdrawn`），再把修订版导入工作区 `审核版/X`。所以「点了通过」到「发起人能下载」之间
  有一个可观测的中间态（界面显示「已通过，正在发布」）。
- **`revision` 是乐观并发令牌**，领取、上传修订、通过、驳回都会推进它；客户端拿旧值提交
  得到 409 而不是覆盖别人的决定。
- **修订上传的顺序是刻意的**：先调 exec 落一个新产物（`held` + `revision_of` 链），再写 agent
  账本。孤儿 `held` 产物可以接受，悬空指针不行。
- **材料快照是独立副本**：审核员下载的材料与发起人上传时的字节一致，发起人后来删掉工作区
  文件也不影响；快照失败是**看得见的状态**（`snapshot_status = unavailable`），不是静默缺失。
- **审核结果会进下一次 Run 的提示词**（design §5.4）：已通过说明已交付、哪一件经修订、
  以 `审核版/X` 为准；已驳回给出反馈。每个任务**只注入一次**，文本由服务端生成，不进任何消息行。
- 通知复用投递账本（`kind` = `review_released` / `review_rejected`），但聚合类型是独立的
  `review_notification`——Run 终态邮件消费者按 `aggregate_type` 过滤，共用会被它按「Run 结束了」
  的语义处理掉。

### 列表分页：会话 / 审批 / 定时任务 / Skill 共享申请

四个列表接口用同一套 **keyset（键集）分页** 契约（design ui-polish §2.4）。共享工具在
`agent/src/application/keyset-cursor.ts`（`admin-run-query-service.ts` 与 `review-service.ts`
里原有的两份同类实现不在本次改造范围内）：

- **请求**：`?limit=<1..100>&cursor=<不透明串>`，外加各接口原有的过滤参数。
  `limit` 缺省用各接口的默认值；越界（0、101、非整数）→ **400 `VALIDATION_ERROR`**，
  **不做 clamp**——静默截断会让客户端以为自己拿到了全部数据。
  `cursor` 无法解码（不是 base64url、缺分隔符、排序列不是时刻、主键不是 ULID）→ 同样是
  **400 `VALIDATION_ERROR`**；空值表示第一页。**空页不等于错误**：解不出来的游标绝不退回第一页。
- **响应**：`{ <items>: [...], next_cursor: string | null }`；`next_cursor === null` 表示到底。
  服务端多取一条来判断是否还有下一页，游标编码的是**排序列的值 + 该行主键**，因此同一毫秒的
  两行不会重复或漏掉。
- **游标只是位置，不携带身份**：作用域始终来自服务端解析出的 owner / org，查询先套作用域、
  再用游标定位。把别人的游标拿过来用，得到的仍是自己行集里位于该位置之后的数据，不会泄漏
  任何他人的行。

| 接口 | 默认 `limit` | 排序（倒序） | 额外参数 |
|---|---|---|---|
| `GET /api/conversations` | 30 | `updated_at`, `conversation_id` | `q`：会话标题模糊匹配，≤100 字符（超长 400）；`%` / `_` / `\` 按字面量匹配 |
| `GET /api/approvals` | 50 | `created_at`, `approval_id` | `status` |
| `GET /api/cron-jobs` | 50 | `created_at`, `cron_job_id` | — |
| `GET /api/admin/skills/share-requests` | 50 | `created_at`, `request_id` | `status`；列表键名仍是 `requests` |

> `GET /api/conversations` 的响应**曾经是裸数组**，现在改为 `{ conversations, next_cursor }`；
> `GET /api/approvals` 原来同时给 `approvals` 与同值的 `items`，现在只保留 `approvals`。

### 会话时间线：`GET /api/conversations/{id}/events`（一次性 JSON，**不是 SSE**）

返回该 Conversation 下**已持久化的完整 Run 时间线**：一次响应、`application/json`，没有
`text/event-stream`、没有增量推送。它**不是**「Conversation 维度 SSE」——实时事件只有
`GET /api/runs/{run_id}/events` 的 SSE。

| 字段 | 说明 |
|---|---|
| `runs` | 该会话的全部 Run（`RunDetail`，按创建时间升序） |
| `events` | 全部 Run 的持久化事件，供前端重放（每条带 `run_id` / `sequence` / `event_id` / `type` / `payload`） |
| `last_run` | 最近一个 Run，没有 Run 时为 `null` |

查询参数：`limit` = **每个 Run 最多拉取的事件条数**（默认与上限均为 500，分页补齐）。会话
不存在、已删除或**不属于本租户**一律 404；存在但没有 Run 返回 200 + 空时间线——两者必须
区分，前者不能被当成「空会话」。

前端在两个时机调用它：进入会话时的重放（`entityBridge.rehydrateConversation`），以及 review
会话里还有 `reviewStatus === 'pending'` 交付物时的**定时轮询**。后者是必要的：Run 终态后
Run SSE 就关闭了，而 `artifact.released` / `review.rejected` 是审核员之后才追加到这个已结束
Run 上的，只有重新拉完整时间线才能拿到；重放按 `event_id` / `sequence` 去重，没有待审交付物
时停止轮询。该接口**没有** `after_sequence` 增量参数，每次返回完整时间线。

### 能力页里的 org 层

`GET /api/capabilities/skills` 按层投影，本 org 的 org 层项 `source` 为 `org-skill-root`
（系统层 `shared-skill-root`、用户层 `user-skill-root`、草稿 `draft-skill-root`）。
org 层列的是**本 org 已发布的 `active` 版本**，与任何 AgentVersion 的绑定无关——
用绑定清单会让刚发布、还没被绑定的共享 Skill 从页面上消失。

`GET /api/runs/{run_id}/trace` 返回 owner-scoped durable span 树：

```json
{
  "traceId": "0123456789abcdef0123456789abcdef",
  "runId": "01...",
  "spans": [
    {
      "spanId": "0123456789abcdef",
      "parentSpanId": null,
      "name": "run.execute",
      "kind": "internal",
      "status": "ok",
      "startTime": "2026-07-19T00:00:00.000Z",
      "endTime": "2026-07-19T00:00:00.100Z",
      "attributes": {}
    }
  ]
}
```

归属按已认证用户的 organization/user 与 Run 校验；跨租户或不存在的 Run
返回相同的 not-found 语义。Trace ID 是结果中的字段，不是未授权的全局索引。

Agent 模型侧权威清单工具：`capabilities`（`action=list|search|describe`），只读、有界、不含凭据/完整 schema/技能正文。

### 完整路由表

浏览器唯一的 API 边界。以下是 `api-server/server.ts` 当前分发的全部路由；
未列出的路径返回 404。


| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/auth/register` | 注册；成功后写 HttpOnly 会话 Cookie |
| `POST` | `/api/auth/login` | 登录 |
| `POST` | `/api/auth/logout` | 撤销当前 sid 并清 Cookie；失败仍清本机 Cookie，返回撤销未确认 |
| `GET` | `/api/auth/config` | 未登录可读的登录方式投影；Agent 是能力权威，读取失败返回 503 |
| `GET` | `/api/auth/sso/login` | 公司 SSO 入口（顶层导航）：302 到 IdP，写加密事务 Cookie；`?return_to=` 仅站内路径 |
| `GET` | `/api/auth/sso/callback` | IdP 回调：换票 → Agent 验签兑换 → 写会话 Cookie，303 回站内路径；失败 303 `/?sso_error=<码>` |
| `GET` | `/api/auth/me` | 当前用户 |
| `GET` `PATCH` | `/api/auth/profile` | 本人账户资料；`PATCH` 只能改显示名称、邮箱与长任务完成邮件开关 |
| `GET` `POST` | `/api/conversations` | 列出 / 创建 Conversation；列表带 `limit` / `cursor` / `q`，返回 `{ conversations, next_cursor }`（见「列表分页」） |
| `GET` `DELETE` | `/api/conversations/{id}` | 详情 / 删除 |
| `GET` | `/api/conversations/{id}/events` | 会话完整时间线（**一次性 JSON，不是 SSE**，见下） |
| `POST` | `/api/conversations/{id}/runs` | 在指定 Conversation 下创建 Run |
| `POST` | `/api/conversations/{id}/follow-ups` | 追问；当前 Run 未结束时新 Run 保持 `QUEUED`，结束后按提交顺序自动执行 |
| `GET` `POST` | `/api/conversations/{id}/datasets` | 列出 / 上传 Dataset |
| `POST` | `/api/conversations/{id}/artifact-imports` | 跨会话导入已有 Artifact |
| `GET` `POST` | `/api/runs` | 列出 / 创建 Run |
| `GET` | `/api/runs/{id}` | Run 详情 |
| `GET` | `/api/runs/{id}/events` | SSE replay |
| `GET` | `/api/runs/{id}/trace` | owner-scoped durable span 树 |
| `GET` | `/api/runs/{id}/tools` | 该 Run 的工具执行台账 |
| `POST` | `/api/runs/{id}/cancel` | 取消（需 `Idempotency-Key`） |
| `POST` | `/api/runs/{id}/steer` | 运行中改向 |
| `POST` | `/api/runs/{id}/resume-approval` | 审批后恢复 |
| `POST` | `/api/runs/{id}/interactions/{iid}/respond` | 回答 `ask_user` |
| `GET` | `/api/approvals` | 待审批列表；`status` / `limit` / `cursor`，返回 `{ approvals, next_cursor }`（见「列表分页」） |
| `GET` | `/api/approvals/{id}` | 审批详情 |
| `POST` | `/api/approvals/{id}/decide` | 批准 / 拒绝 |
| `GET` | `/api/artifacts` | 带 `session_id`：该会话的产物；不带：产物库（本人所有会话，`q` / `kind` / `cursor` / `limit`） |
| `GET` | `/api/reviews` | 审核任务列表（**reviewer**）；`status` = 逗号分隔的状态子集（`PENDING` / `IN_REVIEW` / `APPROVED` / `REJECTED`，未知值 422 `REVIEW_INPUT_INVALID`；历史页签传 `APPROVED,REJECTED`），`mine=true` 只看自己领取的，另有 `cursor` / `limit` |
| `GET` | `/api/reviews/{id}` | 任务详情：提问、附件快照、交付物版本链、审计时间线、`revision`（乐观并发用）（**reviewer**） |
| `POST` | `/api/reviews/{id}/claim` `release` | 领取 / 释放（幂等语义见下）（**reviewer**） |
| `POST` | `/api/reviews/{id}/items/{no}/revisions?base_revision=` | 上传修订版（**原始字节 body**，文件名走 `X-Filename`，不是 multipart）（**reviewer**） |
| `POST` | `/api/reviews/{id}/approve` `reject` | 通过 / 驳回；body `{ base_revision, note?, feedback? }`，驳回必须给 `feedback`（**reviewer**） |
| `GET` | `/api/reviews/{id}/materials/{mid}/download` | 下载材料快照（**reviewer**） |
| `GET` | `/api/reviews/{id}/items/{no}/download` | 下载该交付物的当前版本（任一版本都可下载，含已撤回的）（**reviewer**） |
| `GET` | `/api/datasets` | Dataset 列表 |
| `GET` | `/api/processes` | 长进程列表；必传 `session_id`，可按 `run_id` / `status` 筛选 |
| `GET` | `/api/processes/{id}` | 进程详情；必传 `session_id` |
| `GET` | `/api/processes/{id}/logs\|read` | 进程输出（游标读）；必传 `session_id` |
| `POST` | `/api/processes/{id}/stdin\|signal\|cancel\|kill` | 进程控制；JSON body 必传 `session_id` |
| `GET` | `/api/agents` | 当前用户可用的智能体（Agent 目录；受限智能体只列给被授权成员与 admin） |
| `POST` | `/api/agents` | 新建智能体，自带 v1 并指向它（**admin**） |
| `GET` `POST` | `/api/agents/{id}/versions` | 版本线 / 建新版本（**admin**） |
| `POST` | `/api/agents/{id}/active-version` | 切活跃版本，也是回滚（**admin**） |
| `GET` `PUT` | `/api/agents/{id}/access` | 可见范围：全员 / 指定员工及授权名单；PUT 整体替换（**admin**） |
| `GET` | `/api/agents/config/options` | 配置 schema、字段支持情况、平台约束与 capability revision（**admin**） |
| `POST` | `/api/agents/config/validate` | 只解析不落库的配置校验（**admin**） |
| `GET` | `/api/admin/runs` | 全组织运行列表（**admin**）；见下文「管理端运行查询」 |
| `GET` | `/api/admin/runs/stats` | 运行统计条（**admin**） |
| `GET` | `/api/admin/runs/{id}` `/events` `/tools` | 单次运行详情 / 全部持久事件 / 工具台账（**admin**） |
| `GET` | `/api/admin/skill-usage` | 近 N 天（`days` 1–90，默认 7）全组织各 Skill 的 `skill` 工具调用次数，按 `(name, scope)` 分层（**admin**） |
| `GET` | `/api/admin/skills/org` | 本 org 的 org 共享层列表（**admin**） |
| `POST` | `/api/admin/skills/org` | 管理员直传 `.zip` / `.skill` 发布到 org 共享层（**admin**，流式，≤50MB） |
| `GET` | `/api/admin/skills/org/{name}/versions/{digest}/manifest` | 该版本的文件清单、截断 `SKILL.md` 与完整 `affectedAgentVersionIds` 引用列表（**admin**） |
| `POST` | `/api/admin/skills/org/{name}/current` | 改「当前推荐版本」（**admin**） |
| `POST` | `/api/admin/skills/org/{name}/versions/{digest}/deprecate\|revoke` | 弃用 / 吊销某版本，返回完整 `affectedAgentVersionIds`（**admin**） |
| `GET` | `/api/admin/skills/share-requests` | 本 org 的共享申请队列（**admin**）；`status` / `limit` / `cursor`，返回 `{ requests, next_cursor }`（见「列表分页」） |
| `GET` `POST` | `/api/admin/skills/share-requests/{id}/manifest\|approve\|reject` | 审阅清单 / 批准 / 驳回（**admin**） |
| `GET` | `/api/admin/users` | 本 org 成员列表（含 `roles` / `pinned_roles`，**admin**） |
| `PUT` `DELETE` | `/api/admin/users/{userId}/roles/{role}` | 授予 / 撤销角色，幂等（**admin**） |
| `GET` | `/api/admin/users/{userId}/role-events` | 角色变更记录（**admin**） |
| `GET` `POST` | `/api/cron-jobs` | 列出 / 创建定时任务；列表带 `limit` / `cursor`，返回 `{ cron_jobs, next_cursor }`（见「列表分页」） |
| `GET` `PATCH` `DELETE` | `/api/cron-jobs/{id}` | 详情 / 修改 / 删除 |
| `GET` | `/api/cron-jobs/runs` | 本人所有未删除任务的执行记录（`since` ISO，`limit` 1–1000，默认 500），每条带 `job_name` / `job_timezone` |
| `GET` | `/api/cron-jobs/{id}/runs` | 该定时任务的历史 Run |
| `POST` | `/api/cron-jobs/{id}/run` | 立即触发一次 |
| `GET` | `/api/capabilities/{skills,mcp,tools,models}` | 从 diagnostics 投影的能力清单 |
| `POST` | `/api/capabilities/skills/drafts` | 上传 Skill 草稿包（.zip / .skill）；解压至用户草稿根，保持未启用 |
| `POST` | `/api/capabilities/skills/{name}/enable\|disable` | 启用草稿 / 停用用户 Skill；owner-scoped。名字与本 org 的 org 层冲突 → 409 `SKILL_NAME_RESERVED_BY_ORG`（原作者豁免） |
| `GET` | `/api/capabilities/skills/share-requests` | 本人的共享申请列表 |
| `POST` | `/api/capabilities/skills/{name}/share-requests` | 对本人**已启用**版本发起共享申请（body `{ note? }`） |
| `POST` | `/api/capabilities/skills/share-requests/{id}/withdraw` | 撤回本人 `pending` 的申请 |
| `GET` | `/api/extensions/diagnostics` | Extension / Profile / allowlist 状态 |
| `GET` | `/api/a2a/config` | A2A 配置（**admin**） |
| `POST` | `/api/a2a/credentials` | 签发 A2A 凭据（**admin**） |
| `POST` | `/api/a2a/credentials/{id}/rotate\|revoke` | 轮换 / 吊销（**admin**） |
| `GET` | `/api/files/artifact-download` | 交付物下载（`session_id` + `artifact_id`） |
| `GET` | `/api/files/download` | 按路径下载 workspace 文件 |
| `POST` | `/api/files/upload` | 上传附件（multipart 流式代理） |
| `POST` | `/api/sessions/ensure` | 确保 Conversation + Sandbox Session 绑定 |
| `GET` | `/health/live` `/health/ready` | 探针 |

`/api/a2a/*` 要求 `actingRole === 'admin'`，否则 403 `ADMIN_REQUIRED`。

#### Agent 目录（多 Agent 选择）

一个 org 下可以并列存在多个智能体，普通用户在**建会话**时选其中一个。

- **两张表的语义不同**：`agent_definitions` 的一行 = 一个可选的智能体；
  `agent_versions` 的一行 = 该智能体的一次不可变配置快照。「多一个可选的智能体」
  是新增一行 definition（自带 v1），不是往已有智能体下加 version——
  `active_version_id` 是单值的，加 version 只会产生历史。
- **写目录要求 `actingRole === 'admin'`**，否则 403 `ADMIN_REQUIRED`；
  `GET /api/agents` 对 org 内所有成员开放。角色解析不出来时一律拒绝。
- **可见范围**（[设计](design/agent-visibility.md)）：每项带 `visibility`（`org` | `restricted`）。
  `restricted` 的智能体只列给授权名单里的成员与 admin；未授权成员显式选择它建会话/发起 Run、
  或在**已绑定**它的会话里继续下一轮，一律 404（与不存在同形，撤销立即生效）；定时任务创建返回
  400 同「不存在」文案，执行时记 FAILED。`GET /api/agents/{id}/access` 返回
  `{agent_id, visibility, grants:[{user_id, username, display_name, granted_at}]}`；
  `PUT` body `{visibility, user_ids}`，名单须为本 org 活跃成员（≤500），`org` 时清空名单；
  默认智能体不能设为 `restricted`；非法输入 400，非 admin 403。内部镜像 `/internal/agents/{id}/access`。
- **改配置 = 建新版本**，永不原地改写。`POST .../versions` 默认 `activate: true`；
  传 `activate: false` 只建不切。回滚就是把 `active_version_id` 指回旧版本。
- **切活跃版本只影响新建的会话**：正在跑的 Run 与已存在的 AgentSession
  继续使用它们钉住的版本。
- **写入即校验**：`config` 在建版本时就跑一遍 AgentVersion 绑定规则，非法配置
  （`toolPolicy` 不是对象、model 内嵌 `apiKey` 等）当场 400，不会落库后在 Run 期爆炸。
- **跨租户一律 404**：用别的 org 的 `agent_id` 或不属于该 Agent 的
  `agent_version_id` 调用，与"不存在"返回同一个响应，不泄漏存在性。

**`config` 里哪些字段真的生效**（2026-09-04 逐字段核过一遍；不生效的字段写进去
不报错但**没有任何执行路径**，别指望它约束行为）：

| 字段 | 生效？ | 落在哪 |
|------|-------|--------|
| `systemPrompt` | ✅ | 作为 persona 按字面量进入系统提示词，排在 harness 身份、平台路径/Policy 和 `Doing work` 之后、工具指导之前；内部的 `{{...}}` 不再次展开，不能删除平台 section。Delegation 如有则追加在 persona 内。空串省略 persona，仍保留平台约定；执行授权以 guard 为准 |
| `modelPolicy`（含内嵌 `model`） | ✅ | `modelResolver` 解析出本次 Run 的具体模型；内嵌完整 model 时 `input.model` 不能改身份 |
| `modelPolicy.maxOutputTokens` | ✅ | 作为 `AgentOptions.maxTokens` 出现在**主对话请求**上；标题/压缩等辅助请求不受影响 |
| `modelPolicy.thinkingLevel` | ✅ | 作为 agent scope 的 `ModelSelection.reasoningEffort` 出现在主对话请求上。取值必须是当前适配器接受的 effort ID（`deepseek-official`：`off|low|high|max`），否则保存时 400、起 Run 时 fail-closed |
| `toolPolicy` | ✅ | 逐调用闸门（`tools/pre-execute`）与风险表 |
| `toolPolicy.tools` | ✅ | 显式 `allow` / `require_approval` / `deny`；deny 在真实工具管线拦在工具体之前 |
| `toolPolicy.riskLevels` / `classRiskLevels` / `riskApproval` | ✅ | 平台层与版本层**各自解析后取更严**；租户只能收紧，不能放松 |
| `mcpServers` | ✅（授权面） | 引用哪台 server、`enabledTools` 授权哪些工具。**连接配置仍只来自 `MCP_SERVERS_JSON`**：版本里不接收地址、密钥引用、超时。省略或 `[]` = 不授权任何 MCP 工具 |
| `mcpServers[i].toolArguments` | ✅ | 宿主参数的值（`{ "kb_id": "hr" }`）：键必须是该 server 在 `MCP_SERVERS_JSON[].hostArguments` 里声明的名字（否则 `MCP_ARGUMENT_UNKNOWN`），值为字符串（≤1024 字符）、数字或布尔（否则 `MCP_ARGUMENT_INVALID`）。`platformConstraints.mcpServers[].hostArguments` 只返回 `name` / `description`。见 [design/mcp-per-agent-arguments.md](design/mcp-per-agent-arguments.md) |
| `delegation.remoteAgents` | ✅ | `delegate_to_remote_agent` 的白名单：`A2A_REMOTE_AGENTS_JSON` 里的远端 `id` 数组（≤20，去重）。保存时要求已登记（否则 `DELEGATION_REMOTE_AGENT_UNKNOWN`）；**不接收**地址、凭据、超时。`platformConstraints.remoteAgents` 只返回 `id`/`name`/`description`。见 [design/a2a-remote-delegation.md](design/a2a-remote-delegation.md) |
| `delegation.agents` | ✅ | `delegate_to_agent` 的白名单：同 org 的 Agent `name` 数组（≤20，去重）。保存时要求每个名字在本 org 存在（否则 `DELEGATION_AGENT_UNKNOWN`，别的 org 的同名 Agent 视为不存在）；运行时再判目标是否 active。省略或 `[]` = 不可委派。见 [design/agent-delegation.md](design/agent-delegation.md) |
| `dataSources` | ✅ | 本 Agent 的 Run 可在沙箱里连接的业务库：`[{ "id": "<数据源 id>" }]`（≤16，不允许重复）。条目只接收 `id`，地址、账号、口令属于 `SANDBOX_DATA_SOURCES_JSON` 目录，写进来即 `CONFIG_UNKNOWN_FIELD`；保存时要求 id 在目录里（否则 `DATA_SOURCE_UNKNOWN`）。`platformConstraints.dataSources` 只返回 `id`/`label`/`description`/`engine`。见 [design/sandbox-data-sources.md](design/sandbox-data-sources.md) |
| `skillPolicy` | ✅ | 这个 Agent 的 Run 带哪些 Skill（ADR 0015 D2，[design/skill-catalog-and-agent-binding.md](design/skill-catalog-and-agent-binding.md)）。`system`（`all`\|`allowlist`\|`none`，`names` 仅 `allowlist` 时允许且必填）、`org[]`（`{ name, contentDigest }`，钉摘要不跟随最新）、`user`（`allow`\|`deny`）。**省略 = 当前行为**（全部系统 + 用户启用），既有版本不迁移、`config_hash` 不变。保存时校验名字在当前 release（`SKILL_SYSTEM_UNKNOWN`）与 org 账本（`SKILL_ORG_VERSION_UNKNOWN` / `SKILL_ORG_VERSION_DEPRECATED`）；有效清单总量超 `ENABLED_SKILLS_MAX` → `SKILL_POLICY_TOO_LARGE` |
| `deliveryPolicy` | ✅ | 交付物是否需人工审核（[ADR 0016](adr/0016-agent-output-human-review.md) D3）：`{ "mode": "direct" \| "review" }`。**省略 = `direct`**，既有版本行为与 `config_hash` 完全不变；写回时 `direct` 也被省略。未知取值 → 诊断码 `CONFIG_INVALID`。`review` 与 `delegation`（`agents`/`remoteAgents` 任一非空）互斥（`CONFIG_INVALID`），与 **A2A 暴露**双向互斥（本 Agent 有 `active` 的 A2A 凭据时保存 `review` → `CONFIG_INVALID`；给 `review` 模式的 Agent 签新 A2A 凭据也拒绝）。绑定（起 Run / 建会话）时再判一次，形状非法一律 `DSH_CONFIG_UNSUPPORTED`，**不回落成 `direct`**。策略随 AgentVersion 固定：会话绑定版本后不会漂移到新版本，所以**同一会话的策略终生不变** |
| `modelPolicy.temperature` | ❌ | 当前 DSH loop 没有 temperature call-config seam；写进去保存时 400，不静默接受 |
| `skills` | ❌ | 已移除，写入即 `CONFIG_UNKNOWN_FIELD`。运行时的 skill 绑定改用 `skillPolicy`（旧 `skills` 是展示用的描述，不能推断绑定意图，故不复用同名键） |
| `extensions` | ❌ | 已移除（同上）。旧引擎的 Extension 机制已随 ADR 0009 H7 退役 |
| `sandboxPolicy` | ❌ | 已移除（同上），没有执行路径。沙箱模式、网络模式、可写根都由 exec 的部署级配置决定，不按 Agent 分（ADR 0002 起就是如此） |
| `a2a` / `contextPolicy` | ❌ | 已移除（同上），无读取方 |

##### 配置契约（`schemaVersion: 1`）与配置面接口

新写入的配置带 `schemaVersion: 1`；没有该字段的历史记录按 legacy 读取，**不原地迁移**，
历史 JSON 与 `config_hash` 永不改写。

- `GET /api/agents/config/options` 返回 `{ schemaVersion, fieldSupport, platformConstraints,
  capabilityRevision }`。`platformConstraints` 只描述能力：模型目录及其可选 effort、工具名、
  MCP server/工具清单与 `mcpReadiness`、远端 Agent 与数据源目录的展示字段、Skill 目录
  （`skills.system` = 系统层名字与描述，`skills.org` = **本 org** 的 org 层版本与状态），
  以及大小上限。**不返回**连接地址、密钥引用、宿主物理路径或别的用户的技能。
  `capabilityRevision` 的输入包含 Skill 目录，因此系统包名集合或 org 层
  `(name, digest, status)` 集合变化会改变它。
- `POST /api/agents/config/validate` 接收 `{ config, agent_id? }`，返回
  `{ valid, errors, warnings, normalizedConfig?, effectiveSummary, capabilityRevision }`。
  它只解析：不跑工具、不调模型、不建会话、不装 MCP。`agent_id` 按同一条跨租户 404 规则校验。
  `effectiveSummary.skills` 给出**展开后**的有效清单：`system` 是展开后的名单
  （`all` 展开成当前 release 的全部名字）、`org` 是钉住的 `(name, contentDigest)`、
  `user` 是开关本身（**不含**具体用户包名——它随调用者变化）。
- **状态码语义**：body 结构错误（不是对象、`config` 缺失）是 400；**字段级校验结果是
  合法请求的正常结果，返回 200 + `valid:false`**，`errors` 每条形如
  `{ path, code, message }`，`path` 精确到 `modelPolicy.thinkingLevel`、
  `mcpServers[0].enabledTools[1]`，UI 据此把错误标到具体控件上。
- **预览与保存给同一个答案**：`deliveryPolicy` 与 A2A 暴露的互斥要读凭据账本，所以在
  这个带 `agent_id` 的预览端点里也判一次——预览说 `valid:true`、保存却 400 是
  AGENTS.md §3 禁止的「保存、预览、执行各自猜语义」。
- **保存失败的诊断码出口**：创建/发布版本时字段级错误返回 400
  `{ error, code: "VALIDATION_ERROR", reason_code }`。`code` 是稳定的通用码，
  `reason_code` 是具体诊断码（如 `CONFIG_INVALID`、`DELEGATION_AGENT_UNKNOWN`），
  **只在存在且与 `code` 不同时出现**。UI 优先展示 `reason_code`。
- `valid:true` 必然带 `normalizedConfig`，`valid:false` 必然不带。创建/发布版本时服务端
  **重新校验**，不信任浏览器回传的 `normalizedConfig` / `valid` / `capabilityRevision`。
- `mcpReadiness.status` 区分三种事实：`ready`（清单已知）、`not_configured`（部署没有声明
  任何 server）、`unknown`（还问不到）。`unknown` 时引用 MCP 一律拒绝
  （`MCP_CATALOG_UNAVAILABLE`），**不能把"读不到"渲染成"空清单"**。
- legacy 记录升级到 v1 时，`modelPolicy` 里的旧模型引用必须能映射到当前模型目录，
  否则 `LEGACY_MODEL_UNMAPPABLE` 阻止升级；`skills` / `extensions` / `sandboxPolicy`
  / `a2a` 与其他未识别键在 legacy 记录里返回 `LEGACY_FIELD_REQUIRES_MIGRATION`，要求管理员显式处理，
  **不会在表单/JSON 往返中被静默丢掉**。`effectiveSummary.migration.blockedPaths` 列出待处理项。
- **绑定期 fail-closed（滚动升级护栏）**：带 `schemaVersion: 1` 的记录在运行进程
  （Agent / agent-worker）绑定时出现该进程不认识的**顶层键**，起 Run 直接失败
  （`DSH_CONFIG_UNSUPPORTED`），不按「字段省略」继续跑。原因：新字段由更新的写入方落库，
  旧 Worker 不认识它，若忽略就会**静默失效**——配置说「只带 pdf」，实际跑的是全部。
  没有 `schemaVersion` 的 legacy 记录不受此约束（它们本来就带 `skills` / `extensions` /
  `sandboxPolicy` 等 v1 已删除的键，且不可变、不迁移），未知键维持既有忽略行为。
  因此部署顺序是 **exec / Worker 先于允许写入新字段的 API**。

##### 激活的乐观并发

`POST .../versions`（`activate` 为真时）与 `POST .../active-version` 接受可选的
`expected_active_version_id`：

- **不传** = 跳过检查（旧客户端兼容窗口），行为与上线前一致。
- 传 `null` = 断言"我读到的是还没有活跃版本"，与不传**不是**一回事。
- 与当前指针不一致时返回 409 `ACTIVE_VERSION_CONFLICT`，响应带 `active_version_id`
  （当前真实指针），供 UI 展示差异后再提交，而不是盲目重试覆盖别人的激活结果。
- `activate: false` 的保存**不做**这项检查：它不与别人的激活竞争。

版本号仍由 MySQL 事务决定。

选择 Agent 的入口有三个，都只接受 `agent_id`（ULID），不接受 `agent_version_id`：

| 入口 | 何时生效 |
|------|---------|
| `POST /api/runs` / `/api/conversations/{id}/runs` | `conversation_id` 为空时——首轮消息就是"建会话" |
| `POST /api/conversations` | 显式建会话 |
| `POST /api/sessions/ensure` | 不带 `conversation_id` 时 |

**一个会话绑定一个 Agent，绑定在建会话时完成，此后不可变**：换 Agent 要新建会话。
已存在的会话即使不传 `agent_id`，后续 Run 也继续用它绑定的那个 Agent，不会回落到
租户默认。不传 `agent_id` 建新会话时的行为与多 Agent 上线前完全一致（租户默认 Agent）。
`GET /api/conversations{,/id}` 的响应带 `agent_id`，即该会话绑定的智能体。`GET /api/conversations/:id` 的
`messages` **只含用户回合**（`role: "user"`，带 `message_id` / `run_id` / `sequence_no` / `created_at`，文本取自创建 Run 时
落库的 `content_json.text`）；助手的文本、思考、工具一律经 `GET /api/runs/:id/events` 的时间线获得，转录里不再出现
assistant 行或 `thinking` 字段。

进程接口的事实与控制权在 exec 的 `exec_jobs`，不在 Agent。BFF 先让 Agent
按当前浏览器身份授权 `session_id` 并取得其 `workspace_id`，再用 owner-scoped
exec 公共适配器查询或控制；返回给浏览器时仍投影原 `session_id`。不存在或
跨租户访问统一返回 404。`logs` 返回 `next_offset`、`completed`、`truncated`、
`log_total`；进程详情含 `process_id`、`run_id`、`status`、`command` 和时间字段。
`kill` 未指定信号时发送 `SIGKILL`（立即终止），`signal` 未指定时发送 `SIGTERM`；
两者都可以在 body 传 `signal` 指定信号。需要「先 TERM、超时再 KILL」的升级语义使用 `cancel`。Agent 不提供
`/internal/processes*` 路由。

`me` 与登录响应里的 **`roles: string[]`** 是角色的权威投影（按字典序，只含白名单值）；
兼容字段 `role` 是主角色（含 `admin` 时为 `admin`，否则 `user`），前端改读 `roles`。
服务端把角色集合写进 `X-Acting-Role`（逗号分隔，没有角色时仍是 `user`），并在
**每个请求**重读账本——所以授予或撤销在下一个请求即生效，不必等 JWT 过期（JWT 里的
`role` 只作展示）。

角色由 admin 在「成员与角色」页配置，见上文「成员与角色管理」。
`SANDBOX_AUTH_ADMIN_USERNAMES`（逗号分隔，大小写不敏感）只保留**引导与锁定**语义：
只授予、不降级；从名单移除不会自动降级，需由 admin 在界面撤销。
注册接口忽略客户端提交的 `role` / `organization_id`。
`BFF_DEV_ACTING_ROLE` 只影响 `AUTH_ENABLED=false` 的开发身份，不会提升真实用户；
它接受与生产同一线格式的逗号集合（`admin,reviewer`），未知值被丢弃（等价于 `user`）。

认证数据与 token 的唯一权威是 Agent：BFF 的 `/api/auth/*` 适配器调用
Agent `/internal/auth/*`，成功后只把 JWT 写入 HttpOnly Cookie。exec 不保存密码、
不签发或验证浏览器 JWT，也没有 `/auth/*` 路由。

登录/注册的应用 JWT 现在携带 `sid`；Agent 每次 `me`/profile 读取
`tbl_agsvc_browser_auth_sessions` 并校验有效期、撤销状态、内部 owner 与外部兼容映射、
active user/org/Membership，再读当前 `member_roles`。旧无 sid JWT 返回 401，升级后重新登录。
登录/me/profile 增加 `login_method:"local"`、`identity_provider:null`，保留现有 `roles` 与身份字段。

`GET /api/auth/config` 返回 `{mode,methods,profile_policy}`。`SSO_ENABLED=false` 时 mode 为
`local`，`methods.local.enabled=true`，`registration_enabled` 由真实注册策略决定，
`methods.sso={enabled:false,available:false,label:"公司 SSO"}`。`SSO_ENABLED=true` 时 mode 为
`sso`：`registration_enabled=false`，本地登录只对部署管理员名单开放（其他人 403
`LOCAL_LOGIN_RESTRICTED`，注册 403 `REGISTRATION_DISABLED`），`methods.sso.enabled=true`，
`available` 为 Agent 与 BFF 两侧配置都完整时才为 true。profile_policy 是默认策略，
个人编辑字段以 profile.editable_fields 为准。配置/权威依赖不可用返回 503，不返回空能力集。

公司 SSO（OIDC 授权码 + PKCE，[设计](design/sso-oidc-dev.md)）：`/api/auth/sso/login` 与
`/callback` 是浏览器顶层导航，不返回 JSON；失败一律 303 到 `/?sso_error=<码>`，码为
`SSO_STATE_INVALID` / `SSO_CALLBACK_INVALID` / `SSO_ACCESS_DENIED` / `SSO_CONFIG_UNAVAILABLE` /
`SSO_UPSTREAM_UNAVAILABLE` / `SSO_TOKEN_INVALID` / `SSO_ACCESS_UNAVAILABLE` /
`IDENTITY_BINDING_CONFLICT` 等稳定码，不带 IdP 原文。回调不经认证写请求的跨站防护
（IdP 回跳本身就是跨站 GET），由 state、PKCE、nonce 与加密事务 Cookie 保护。
SSO 会话的 me/profile 返回 `login_method:"sso"`、`identity_provider:<issuer>`，用户名为工号。
内部镜像 `POST /internal/auth/oidc/exchange`（内部 token；body `{id_token,nonce}`，返回
`{token,user}` 仅给 BFF）：Agent 独立验签，按 `(iss, sub)` 找人或 JIT 建号（零角色、固定 org）。

`POST /api/auth/logout`：200 `{ok:true,revocation:"confirmed"}` 表示当前有效 sid 已撤销；
200 `{ok:true,revocation:"not_required"}` 表示无凭据、无效/已过期/已撤销凭据无需写入；
合法未到期旧 JWT 缺 sid 返回 409 `LEGACY_SESSION_NOT_REVOCABLE`；
DB/内部网络故障或超时返回 503 `AUTH_REVOCATION_UNCONFIRMED`。进入 BFF 退出处理器后所有撤销结果均清 Cookie；跨站403拒绝不触发退出。
内部 gate 的 401 不证明用户会话已失效，不得映射退出成功。退出不取消已有 Run。

上述接口内部镜像为 `/internal/auth/{config,logout}`（GET/POST），沿用 Agent 内部 token gate；
内部 logout 使用应用 Authorization，不从浏览器 claims 构造 acting 身份。
所有认证投影响应 `Cache-Control:no-store`。认证 POST 与 profile PATCH 拒绝明确跨站
Origin/Fetch Metadata，403 `CSRF_ORIGIN_REJECTED`；CORS 不替代这一检查。
同源浏览器和无 Origin 的合法非浏览器 Bearer 调用继续可用。
已打开的 Run SSE 每 15 秒重查当前认证，沿用有限的 Agent 请求超时；无法确认即关闭订阅并释放 relay，
因此实际撤销关流上界包含检查间隔与请求耗时，不能声称严格 15 秒内关闭。

认证依赖连接失败、超时或成功响应无法解析时，login/register/me/profile 返回 `503 AUTH_DEPENDENCY_UNAVAILABLE`；config 和 logout 分别保留自己的错误码。

`/api/auth/profile`（账户页）：`GET` 在 `me` 之外返回 `organization_name`、`status`（`active` /
`disabled`）、`created_at`、`last_login_at`、`editable_fields`（目前是 `display_name`、`email`、
`notify_run_complete`）、`notify_run_complete`（布尔，长任务完成邮件开关，默认 `false`）与
`notifications.email`（`{ available, min_run_duration_ms }`：部署是否配好了邮件发送、多长的 Run 才发；
不可用时阈值为 `null`，前端据此禁用开关，不自行判断）。
它与 `me` 分开，因为 `me` 挂在 BFF 每个请求的鉴权上，不能多查库。`PATCH` 请求体只允许这三个键：
出现其他键返回 422 `PROFILE_FIELD_NOT_EDITABLE`（不静默忽略）；`display_name` 需 1–255 个字符；
`email` 为 `null` 或空串表示清除，否则须是合法地址且不超过 320 个字符，不合法返回 422
`AUTH_INPUT_INVALID`；`notify_run_complete` 须是布尔，否则 422 `AUTH_INPUT_INVALID`。打开开关时部署未配置
邮件发送返回 422 `NOTIFICATION_UNAVAILABLE`；开关开着（或本次打开）却没有邮箱——包括单独清空邮箱——返回 422
`NOTIFY_EMAIL_REQUIRED`（同一请求里一并关掉开关即可清空）。关闭开关总是允许。修改在同一事务里写
`auth_credentials` 与 `users` 两处（开关只在 `users`）——后者是运行账本、管理端用户列与运行完成通知收件人的来源。
用户名、角色、机构、状态由部署或管理员决定。

#### 管理端运行查询

只读，全组织范围。BFF 只转发与写入服务端解析的 `X-Acting-*`（含角色），判定都在 Agent
（`application/admin-run-query-service.ts`）：

- 角色不是 `admin`（含角色缺失）→ 403 `ADMIN_REQUIRED`；
- runId 属于别的 org 或不存在 → 同一个 404 `NOT_FOUND`；所有查询都以调用者的 org 为作用域；
- 参数非法 → 400 `VALIDATION_ERROR`，不会带着坏参数查库。

`GET /api/admin/runs` 查询参数（BFF 只转发这些键）：

| 参数 | 说明 |
|---|---|
| `status` | 分组 `running` / `waiting` / `failed` / `completed`，或 plan §10 状态，逗号分隔 |
| `agent_id` `user_id` | ULID |
| `from` `to` | ISO-8601，按 `created_at` 过滤（`to` 不含） |
| `q` | 会话标题 / 用户输入 / 用户显示名模糊匹配，或精确 Run ID |
| `cursor` `limit` | 键集分页（按 `created_at`、`run_id` 倒序）；`limit` 1–200，默认 50 |

返回 `{ runs, next_cursor }`；每行含 `run_id`、`status`、`user_id`、`user_name`、`conversation_id`、
`conversation_title`、`agent_id`、`agent_name`、`agent_version_no`、`model_id`（取自版本配置
`modelPolicy.modelId`，未固定为 `null`）、`parent_run_id`、`trace_id`、`tool_count`、`approval_count`、`user_input_excerpt`（触发这次运行的用户消息前 200 字）、
`turn_no`（在会话顶层运行中的序号，子运行为 `null`）
与各时间戳。**不含 token 用量**：Run 账本目前没有采集 usage。

`GET /api/admin/runs/stats?day_start=<ISO>`：`day_start` 为调用方本地零点（须在最近两天内），
返回 `today`、`yesterday`、`failed_today`、`failure_rate`、`waiting`（等待审批 / 回答，不限时间）、
`longest_wait_ms`、`median_ms`、`p95_ms`（近 7 天已结束运行的耗时）、`last_7_days`（每日运行数，
旧→新）、`truncated`（近 7 天超过 2 万行时为 true，数值为下限）。

`GET /api/admin/runs/{id}` 在列表行之外多一个 `user_input`（触发这次运行的用户消息文本）。
`/events` 返回 `{ events, truncated }`，形状同会话事件回放（`run_id`、`sequence`、`event_id`、`type`、
`payload`、`created_at`），BFF 分页拉齐（上限 2 万条）；`/tools` 形状同 `/api/runs/{id}/tools`。
沙箱进程与日志仍按所有者隔离，管理端不提供跨用户的进程读取。

`GET /api/admin/skill-usage?days=7` 返回 `{ days, since, usage: [{ name, scope, calls }] }`，按调用次数倒序。
只统计名为 `skill` 的工具调用（名字取自参数信封 `$payload.name`，兼容旧的扁平参数）；模型直接读取 Skill 文件
（例如 `read` 某个 `SKILL.md`）不计入。权限规则同上：非 admin 403，参数非法 400。

`scope`（ADR 0015 D1/D7 / design §7.4）取 `system` | `org` | `user`，由**那次 Run 的
AgentVersion 引用账本**决定：被该版本钉在系统层的名字记 `system`，钉在 org 层的记 `org`，
不在账本里的记 `user`（用户层随调用者启用集变化，不进账本）。同一个名字在不同 AgentVersion
下属于不同层时会**各出一行**——把两层合成一个数字，就答不出「这个系统 Skill 到底有没有人用」。

### BFF 健康检查

- `GET /health/live`：仅检查 BFF 进程，正常返回 200。
- `GET /health/ready`：并行访问 Agent `GET /ready` 与 Sandbox `GET /ready`（不是它们的 liveness
  `/health`），两者都返回 2xx 且 body `status: "ready"` 才返回 200，否则 503。
  下游状态只投影为 `ready` / `not_ready`（答了但未就绪）/ `unreachable`（超时或网络错误）；
  本端点免鉴权，不转发下游 body（MCP Server 名、错误文本）。

```json
// Response (HTTP 200；任一依赖未就绪时 503 且 status 为 "degraded"，不含密钥)
{
  "status": "ok",
  "version": "4.0.0",
  "agent": { "status": "ready" },
  "sandbox": { "status": "ready" }
}
```

### 文件代理

| 端点 | 说明 |
|------|------|
| `GET /api/files/artifact-download?session_id=xxx&artifact_id=yyy` | **Agent 交付物下载**（代理到 Sandbox artifact download） |
| `GET /api/files/download?session_id=xxx&path=yyy` | 按路径下载 workspace 文件（上传文件等非交付物场景） |
| `POST /api/files/upload?session_id=xxx` | 上传附件 (multipart，流式代理) |
| `POST /api/sessions/ensure` | 创建/复用 Conversation + Sandbox Session（供上传前准备，不发消息） |
| `POST /api/conversations/{id}/artifact-imports` | 将当前用户已有 Artifact 导入目标会话 workspace；不创建新 Artifact |

- Artifact 下载代理到 `GET /sessions/{id}/artifacts/{aid}/download`
- 路径下载 / 上传代理到 `/sessions/{id}/files/download` 与 `/sessions/{id}/files/upload`；
  三条代理都先把 `session_id` 换成 `workspace_id` 再跳转（见下节公共面的 `{id}` 说明）
- 上传支持 `Idempotency-Key` 与 `X-Trace-Id` 请求头；BFF 流式落盘后转发，不整包进堆内存
- 超限返回 **413**，业务码见下方 Attachment 约定

---

## 三、Sandbox 内部兼容适配层（非公共 API）

Base URL: `http://sandbox:8081`（Docker 内网）

正式的 Agent 工具调用只走带 scope、claim 和 replay protection 的
`/internal/v1/*` HMAC 平面。剩下的 `/sessions/{id}/files/*`、
`/sessions/{id}/datasets/*`、`/sessions/{id}/artifacts/*`、
`/sessions/{id}/processes/*` 是 BFF 上游代理的
兼容路径，不是浏览器或第三方可依赖的公共 API；`/sessions/{id}/executions/*`
这一层已经删除。生产环境不发布 Sandbox 宿主端口。新的集成必须添加对应的
`/api/*` BFF 路由或 Agent internal contract，不能把 `X-API-Key`
当作终端用户身份。

> **这些路径里的 `{id}` 一律是 `workspace_id`，不是浏览器持有的
> `sandbox_session_id`**——exec 的 `requireOwnedSession()` 拿它派生物理工作区路径。
> BFF 在每次跳转前经 Agent `GET /internal/sessions/{sid}` 换一次，
> `files` / `datasets` / `artifacts` / `processes` 四组代理同一条规则；换不出来一律
> **503 `SESSION_WORKSPACE_UNAVAILABLE`**，不退化成拿 session id 顶替。

### 通用约定

- 所有请求/响应为 JSON
- 错误返回 `{ "detail": "message" }`
- `X-Trace-Id` header 回显 + 关联审计日志
- 兼容适配器认证: exec 公共会话面校验 `X-API-Key`（常量时间比较，不匹配 401），调用方只有 BFF 与 agent；正式 Agent
  internal plane 使用短期 HMAC claim（scope、owner、run/session、body
  digest），不接受一个永不过期的全局 token 作为执行授权
- exec 的 public 探针豁免认证：`/health`, `/ready`, `/metrics`；浏览器认证只存在于 BFF `/api/auth/*`
- **可选用户归属**（BFF `AUTH_ENABLED=true`；`SANDBOX_AUTH_ENABLED` 仅保留为 BFF 的旧配置别名）:
  - 浏览器终端用户：`POST /api/auth/register|login` 后由 BFF 写入 `HttpOnly; SameSite=Lax` 会话 Cookie；JWT 不暴露给前端 JavaScript。`POST /api/auth/logout` 撤销当前 sid 后清 Cookie（失败契约见认证章节）。
  - 非浏览器 API 客户端仍可使用 `Authorization: Bearer <jwt>`；BFF 经 Agent `/internal/auth/me` 验证后写入可信 `X-Acting-*` 上下文。
  - BFF→exec compatibility adapters 只发送服务 `X-API-Key` + 已验证的 `X-Acting-User-Id` / `X-Acting-Organization-Id` / `X-Acting-Role`；exec 不接收浏览器 JWT。
  - 正式 Agent→Sandbox execution: `/internal/v1/*` HMAC claim（scope + owner + run/session + body digest + replay jti）；不接受浏览器 JWT 或裸 service key 作为执行授权
  - **服务 Token alone 不是终端用户**：不能替代 BFF/Agent 注入的 actor；跨用户/跨组织资源统一 fail-closed
  - 跨用户/跨组织访问 Conversation 返回 **404**（不泄露资源是否存在）
  - 旧数据迁移绑定 `user_bootstrap` / `org_bootstrap`；新用户默认加入 bootstrap org
  - BFF `AUTH_ENABLED`（默认同 `SANDBOX_AUTH_ENABLED`）保护 `/api/conversations`、`/api/runs`、Extension diagnostics、文件/产物路由；`/health/*` 与 `/api/auth/*` 保持公开


### `/internal/v1/*` — Agent 专用执行平面

正式的 Agent → Sandbox 调用全部走这一层。每次请求携带短期 HMAC claim
（scope + owner + run/session + body digest + replay jti），Sandbox 独立校验，
不信任 Agent 侧的策略结论。

| 方法 | 路径 | 对应工具 |
|------|------|----------|
| `POST` | `/internal/v1/sessions/ensure` | Session 绑定 |
| `POST` | `/internal/v1/fs/resolve\|stat\|lstat\|list` | `read` / `read_image` / `glob` 的远程 FS provider |
| `POST` | `/internal/v1/fs/read-text\|read-bytes\|write-text\|edit-text` | `read` / `read_image` / `write` / `edit` |
| `GET` | `/internal/v1/fs/stream-text` | 大文本流式读取 |
| `POST` | `/internal/v1/fs/find\|grep` | `glob` / `grep` |
| `POST` | `/internal/v1/shell/run\|start` | 前台 / 后台 `bash` |
| `POST` | `/internal/v1/jobs/status\|read\|kill\|signal\|stdin` | exec 作业查询与控制 |
| `POST` | `/internal/v1/artifacts/submit` | `submit_artifact` |
| `POST` | `/internal/v1/artifacts/download` | 交付物取回 |
| `POST` | `/internal/v1/review/artifacts/snapshot` | 审核材料快照（恒 `withdrawn`，只供审核员读） |
| `POST` | `/internal/v1/review/artifacts/get` | 审核员按 id 读取任一版本（含字节，org 作用域） |
| `POST` | `/internal/v1/review/artifacts/meta` | 按 id **批量**取元数据（名称 / 大小 / `createdByKind` / 时间，**不含字节**，跨 org 与不存在的 id 跳过） |
| `POST` | `/internal/v1/review/artifacts/revision` | 审核员修订上传（新产物 + `revision_of` 链，恒 `held`） |
| `POST` | `/internal/v1/review/artifacts/visibility` | 放行 / 撤回状态变更（单事务、幂等，只接受 `held → released\|withdrawn`） |
| — | `/internal/mcp/v1/*` | `sandbox-mcp` facade（独立部署，见 [`sandbox-mcp.md`](./sandbox-mcp.md)） |

`/internal/v1/review/*` 是**审核流程**的面，与上面那组**模型工具**的面刻意分开：它的作用域是
**org**（审核员不是发起人），其中放行/撤回只由 agent 的 outbox 投递驱动，`held` 不是可以被外部
设置的目标值（允许改回待审等于给了撤销放行的口子）。完整流程见
[design/agent-output-review.md](design/agent-output-review.md) §5–§6。

这五个端点**发生在 Run 之外**（领取、上传修订、通过/驳回都可能在原 Run 终态之后很久），所以
它们签发的内部令牌允许 `run_id` 与 `execution_fence_token` **同时为 null**——这是绑定表里唯一
允许这种形状的路径族（`allowNullRun`），其余路径仍然要求 Run 信封与 fence。exec 侧按同一口径
校验，**不是**把 fence 校验整体关掉。

令牌的 `htm` / `htu` / `scope` / `tool_name` 四项都**逐字绑定**这张表（2026-09-04 起）：

- `htm` 必须与实际方法相等。以前 contract 把它钉死为 `'POST'`，而
  `GET /internal/v1/fs/stream-text` 也要签，于是校验侧写了一条「htm 是 POST 但
  方法是 GET 就放行」的例外——任何一枚 POST 令牌都能拿去打 GET 端点。现在
  `htm` 允许 `'GET'`，例外删除。
- `scope` / `tool_name` 按路由族校验，表在 `@dsh/contract` 的
  `internalBindingForHtu()`，签发与校验两侧共用：`fs/*` → `sandbox.fs` / `fs`，
  `shell/*` → `sandbox.shell` / `shell`，`jobs/*` → `sandbox.jobs` / `jobs`，
  `artifacts/submit` → `sandbox.artifacts.submit` / `artifact.submit`，
  `artifacts/download` → `sandbox.artifacts.download` / `artifact.download`，
  `sessions/ensure` → `sandbox.sessions.ensure` / `session.ensure`，
  `review/*` → `sandbox.review` / `review`（唯一允许 `run_id` 为 null 的一族）。
  以前这两项谁都不看，`ExecRpcClient` 对所有 RPC 都写死 `fs` / `internal:fs`——
  一枚「文件」令牌可以拿去起进程。**未登记的内部路径一律拒**，新端点不会默认免检。

#### `shell/run` 与 `shell/start` 的请求体

两侧共用 `@dsh/contract` 的 `parseShellRunPayload()` / `parseShellStartPayload()`；
**越界或类型非法在执行前拒绝**（`ENVELOPE_INVALID` → 400），不静默退回默认值。
2026-09-16 之前路由只挑 `command` 与 `timeoutMs`，其余字段丢掉仍返回 200——
「指定了子目录却在工作区根执行」不会报错，只会写错文件。

| 字段 | run | start | 规则 |
|---|---|---|---|
| `command` | 必填 | 必填 | 字符串 |
| `workdir` | 可选 | 可选 | 沙箱**逻辑**路径，只认 `/home/sandbox/workspace[/…]` 与 `/tmp[/…]`；必须已规范化（无 `..`、无空段）。缺省为工作区根 |
| `stdin` | 可选 | 可选 | spawn 时一次性写入并关闭 fd 0。`""` 表示「有输入、内容为空」，与缺省的「无输入」不同 |
| `env` | 可选 | 可选 | 合法变量名 → 字符串；最多 64 条。再经执行面 safe-env 过滤，宿主服务凭据不会透传 |
| `stdoutMaxBytes` | 可选 | 可选 | **字节**，上限 `SANDBOX_MAX_OUTPUT_CHARS × 4`。截断按字符边界，不会切出半个字符，并置 `truncated` |
| `timeoutMs` | 可选 | **拒绝** | 有限正整数，上限 `SANDBOX_EXECUTION_TIMEOUT_SECONDS × 1000`。后台作业按异步进程契约运行，没有前台预算，带了这个字段直接 400 |
| `id` / `runId` | — | 可选 | 作业账本标识 |

请求体顶层（与 `envelope`、`payload`、`enabledSkills` 并列）可带 `dataSources: string[]`：本 Run
的 AgentVersion 授权的数据源 id（≤16，同样进 `body_sha256`），只随 `shell/run|start` 下发。exec 为这次
执行把每个库的 unix socket 只读挂到 `/run/dsh-db/<id>/mysql.sock`，并注入 `DSH_DB_SOURCES` 与
`DSH_DB_<ID>_{ENGINE,SOCKET,DATABASE,USER,PASSWORD}`；子进程仍在 `--unshare-net` 下，只能经这个
socket 到达目录里登记的地址。`payload.env` 里的 `DSH_DB_*` 一律丢弃。结果与后台输出中出现的口令
替换为 `***`。清单里的 id 不在 exec 目录 → `DATA_SOURCE_UNKNOWN`（400）；已登记但启动时取密失败或
转发建不起来 → `DATA_SOURCE_UNAVAILABLE`（503）；两者都不执行命令。执行结束（后台作业结束）时
socket 目录回收，每个连接记一条只含元数据的审计日志（`event: data_source_connection`）。

取消与截止：

- Agent 侧 `ExecRpcClient.post()` 的传输截止 = 执行预算 + 15 秒有界回传余量
  （不再是与 payload 无关的固定 15 秒），并与调用方的 `AbortSignal` 融合；
- exec 的监听器把「客户端提前断开」转成请求的 `AbortSignal`，路由再把它接到
  执行面，bwrap 进程树随之终止——取消不再只是让客户端不等了；
- `signal` **不进** payload。以前 Agent 发 `signal: true`，一个既表达不了取消、
  也没人读的布尔值。

模型默认工具面由 `agent/src/runtime/policy/tool-names.ts` 的
`ENTERPRISE_DEFAULT_TOOLS` 唯一定义：`read` / `write` / `edit` / `read_image`、
`glob` / `grep`、`bash`、`job_list` / `job_output` / `job_kill`、`todo_write`、
`skill`、`subagent`、`submit_artifact`、`ask_user_question`。其中只有需要工作区
字节或进程的工具走上述 exec provider；MCP 工具在启动时另行发现并仍受策略层控制。

本地 FS / Shell / Jobs provider 不进入生产装配；Agent 只组装远程 provider，
因此模型不能读取或启动 Agent 容器内的文件与进程。

---

### 兼容适配层实际剩余的公共路由

历史上的 `POST /sessions`、`/sessions/{id}/executions/*`、Sandbox 侧的
`/approvals` 与 `/conversations` **均已删除**。执行只存在于 `/internal/v1/*`；
审批与 Conversation 的唯一权威是 Agent MySQL，经 BFF `/api/*` 访问。

当前 exec（compose 服务名 `sandbox`）实际挂载的非 internal 路由只有：

| 方法 | 路径 | 说明 |
|------|------|------|
| `DELETE` | `/sessions/{session_id}` | 按保留策略清理该 Session 的私有存储 |
| — | `/sessions/{id}/files/*` | 见下方 Files |
| `GET` `POST` | `/sessions/{id}/datasets` | 列出 / 创建 Dataset |
| `GET` | `/sessions/{id}/datasets/{did}` | Dataset 详情 |
| `GET` | `/sessions/{id}/datasets/{did}/content` | 流式取内容 |
| `POST` | `/sessions/{id}/datasets/{did}/abort` | 中止上传 |
| — | `/sessions/{id}/artifacts/*` | 见下方 Artifacts |
| `GET` | `/sessions/{id}/processes/{pid}` | 进程状态（owner 校验） |
| `GET` | `/sessions/{id}/processes/{pid}/logs\|read` | 进程输出（偏移 / 游标） |
| `POST` | `/sessions/{id}/processes/{pid}/signal\|stdin\|cancel` | 进程控制 |
| `GET` | `/health` `/ready` `/metrics` | 探针与指标 |

---

### Files

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/sessions/{id}/files?path=.` | 列出文件（浅层） |
| `POST` | `/sessions/{id}/files/ls` | **结构化 ls**（深度/隐藏/预算） |
| `POST` | `/sessions/{id}/files/find` | **结构化 find**（glob/类型/深度） |
| `POST` | `/sessions/{id}/files/grep` | **结构化 grep**（字面/受限正则） |
| `GET` | `/sessions/{id}/files/read?path=&offset=&limit=` | 读取文件 |
| `POST` | `/sessions/{id}/files/read` | 读取文件（POST body） |
| `POST` | `/sessions/{id}/files/write` | 写入文件 |
| `POST` | `/sessions/{id}/files/edit` | 按锚点编辑文件 |
| `POST` | `/sessions/{id}/files/apply_patch` | 应用补丁 |
| `GET` | `/sessions/{id}/files/preview?path=` | 预览文件前 40 行 |
| `GET` | `/sessions/{id}/files/download?path=` | 下载文件 |
| `DELETE` | `/sessions/{id}/files?path=` | 删除文件 |
| `POST` | `/sessions/{id}/files/upload` | 上传附件 (multipart，隔离路径) |

#### Structured search (`ls` / `find` / `grep`)

Agent 工具 `ls` / `find` / `grep` 覆盖 SDK 本地同名工具，全部转发到下列 Sandbox 端点。仅访问当前 workspace 或其持久化 `/tmp`；不跟随逃逸 symlink；不返回物理根路径。调用方只能收紧限制。

| 工具 | 默认 | 硬上限 |
|------|------|--------|
| `ls` | `path=.`, `depth=1`, `include_hidden=false` | 深度 5，最多 1000 项 |
| `find` | `path=.`, `pattern=*`, `max_depth=20`, `limit=500` | 深度 20，最多 500 项 |
| `grep` | `path=.`, `regex=false`, `case_sensitive=true` | 500 matches、context 每侧 5、单文件 5MB、总扫描 100MB、超时 5s |

统一响应 envelope（`ls`/`find` 用 `items`，`grep` 用 `matches`）：

```json
{
  "items": [{ "path": "src/a.py", "name": "a.py", "type": "file", "size": 12 }],
  "skipped": [{ "path": "bin.dat", "reason": "binary" }],
  "stats": {
    "examined": 10,
    "matched": 1,
    "skipped": 1,
    "bytes_scanned": 0,
    "duration_ms": 1.2,
    "depth_reached": 2
  },
  "truncated": false,
  "stop_reason": null
}
```

```json
// POST /sessions/{id}/files/ls
{ "path": ".", "depth": 1, "include_hidden": false }

// POST /sessions/{id}/files/find
{ "path": ".", "pattern": "*.py", "type": "file", "max_depth": 20, "limit": 500 }

// POST /sessions/{id}/files/grep
{
  "path": ".",
  "query": "TODO",
  "glob": "*.py",
  "regex": false,
  "case_sensitive": true,
  "context": 1,
  "limit": 100
}
```

`stop_reason` 常见值：`item_limit` / `match_limit` / `timeout` / `scan_budget` / `not_found`。路径逃逸 → **403**；非法参数/不安全正则 → **400**。

#### Attachment upload (`POST /sessions/{id}/files/upload`)

- **存储路径**：`uploads/{attachment_id}/{sanitized_name}`（同名文件不覆盖）
- **请求**：`multipart/form-data` 字段 `file`；可选头 `Idempotency-Key`、`X-Trace-Id`
- **流式写入**：分块落临时文件再原子提交，不在内存中拼接完整 body
- **白名单扩展名**：常见文本/代码/图片/PDF/Office 以及 `.zip` / `.tar` / `.gz` / `.tgz` / `.tar.gz`（上传不自动解压）
- **限额**（可配置）：单文件默认 50MB、workspace 500MB；超限 **413**

```json
// Response 201
{
  "attachment_id": "att_…",
  "path": "uploads/att_…/report.pdf",
  "name": "report.pdf",
  "size": 12345,
  "mime_type": "application/pdf",
  "idempotency_key": "idem_…"
}
```

稳定业务码（`detail.code` 或 BFF `code`）：

| code | HTTP | 说明 |
|------|------|------|
| `attachment_too_large` | 413 | 单文件超限 |
| `workspace_quota_exceeded` | 413 | workspace 配额不足 |
| `attachment_type_denied` | 400 | 扩展名不在白名单 |
| `turn_attachment_limit` | 400/413 | 回合附件个数/总量（前端与可选服务端） |
| `upload_incomplete` | 500 | 提交失败 |

同一 `Idempotency-Key` 重试返回同一 `attachment_id` / `path`，不生成第二份文件。

#### `POST /sessions/{id}/files/write`

```json
// Request
{ "path": "test.txt", "content": "hello world" }

// Response (201)
{ "path": "test.txt", "size": 11, "mime_type": "text/plain" }
```

#### `GET /sessions/{id}/files/read?path=test.txt`

```json
// Response (200)
{ "path": "test.txt", "content": "hello world", "size": 11, "truncated": false }
```

支持 `offset` 和 `limit` 参数（行分页）。

---

### Artifacts

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/artifacts` | 产物库：同一 owner 跨会话的产物（见下） |
| `GET` | `/sessions/{id}/artifacts` | 列举本工作区的产物 |
| `POST` | `/sessions/{id}/artifacts/register` | 注册产物（旧端点） |
| **`POST`** | **`/sessions/{id}/artifacts/submit`** | **显式提交产物（推荐）** |
| `POST` | `/sessions/{id}/artifacts/imports` | 将 owner-scoped Artifact 导入本 Session workspace（BFF 上游兼容端点） |
| `GET` | `/sessions/{id}/artifacts/{aid}/download` | 下载产物 |

**产物库 `GET /artifacts`**：没有会话参数，归属只取 BFF 写入的 `X-Acting-Organization-Id` /
`X-Acting-User-Id`（正式 ULID），缺失返回 404；与会话路由一样要求服务令牌（`X-API-Key`）。
参数：`q`（文件名或源路径子串）、`kind`（`image` / `document` / `data`，按 MIME 分组，定义在
`exec/src/db/repositories/artifacts.ts` 的 `ARTIFACT_KIND_MIME`）、`cursor`（上一页最后一个
`artifact_id`；ID 是 ULID，按 ID 倒序即按创建时间倒序）、`limit`（1–200，默认 60）。返回
`{ artifacts, next_cursor }`，每项多一个 `workspace_id`。BFF 的 `GET /api/artifacts`（不带
`session_id`）先经 Agent `GET /internal/identity/owner` 取调用者的正式归属（取不到即失败，不回退到
浏览器身份），再以 `X-Acting-Role: user` 调用这里，只转发上述四个参数。

> **公共面这几条路由里的 `{id}` 是 `workspace_id`，不是 `sandbox_session_id`。**
> exec 的 `requireOwnedSession()` 拿它派生物理工作区路径，产物的归属判定也按
> `workspace_id`。浏览器只认 sandbox session id，所以 BFF 在每次 Sandbox 跳转前
> 都会先经 Agent 的 `GET /internal/sessions/{sid}` 换成 `workspace_id`；换不出来
> 一律 **503 `SESSION_WORKSPACE_UNAVAILABLE`**，不退化成拿 session id 顶替
> （那会静默落到一个不存在的工作区：列表恒空、导入写进错的目录）。
>
> 记录里的 `session_id` 列**不是**列表键：内部面的 `submit_artifact` 往里写
> sandbox session id，MCP facade 写的是 workspace id（facade 够不到 session 概念）。
> 两个写入方唯一一致的键是 `workspace_id`，所以列表与下载都按它判。

> **核心设计（P7）**：系统**不会自动扫描** workspace。`write` / `edit` / `bash` 只改私有工作区，**不会**注册 artifact，也**不会**触发 `file_ready`。只有通过 `submit_artifact`（或等价 `POST .../artifacts/submit`）显式提交的文件才会出现在 artifact 列表并可供用户下载。

`artifacts/imports` 只把 owner-scoped 不可变 snapshot 复制成目标 workspace
输入文件。它不复用源 `artifact_id` 作为目标会话交付记录，不写 Artifact
metadata，也不触发 `artifact.ready/file_ready`。目标会话如需正式交付，
仍须再次调用 `submit_artifact`。

#### `POST /sessions/{id}/artifacts/submit` — 显式提交产物（推荐）

```json
// Request
{
  "name": "chart.png",
  "path": "chart.png",
  "mime_type": "image/png"
}

// Response (201)
{
  "artifact_id": "art_abc123",
  "name": "chart.png",
  "path": "chart.png",
  "mime_type": "image/png",
  "size": 11234,
  "created_at": "2026-07-04T10:00:00Z"
}
```

#### `POST /sessions/{id}/artifacts/register` — 注册产物（旧端点）

```json
// Request
{
  "name": "report.pdf",
  "path": "output/report.pdf",
  "mime_type": "application/pdf",
  "source_execution_id": "exec_abc123"
}

// Response (201) — 同 submit
```

---

### MCP (Model Context Protocol)

Agent Runtime 的 MCP Connection Manager 仍直接连接外部 MCP Gateway/Server，并在进程启动时对每个 `enabled=true` 的 `MCP_SERVERS_JSON` 条目执行 `tools/list`。发现的工具直接注册为 `mcp__{serverId}__{toolName}`，并默认走 approval；配置不支持热加载。任一启用 Server 不可连接时，Agent `GET /ready` 返回 503，该 Server 以 `status: "unavailable"`、`tool_count: 0` 留在 `mcp.servers` 里，避免将故障静默降级为没有 MCP 工具。`/ready` 每次按当前工具注册表重算，Server 恢复或重连预算耗尽后无需重启即反映。

另外，执行面镜像提供**第二个入口** `sandbox-mcp`（Streamable HTTP，`/mcp`），用于不经过 Agent 的受限 Python、文件和 Artifact 工作流。它是独立进程、独立凭据，只能经 `/internal/mcp/v1/*` 窄桥访问执行面，够不到 HMAC 内部面；不挂载任何工作区卷。详细部署与认证边界见 [`sandbox-mcp.md`](./sandbox-mcp.md)。

---

### Health & Monitoring

| 方法 | 路径 | 说明 |
|------|------|------|
执行面（exec，8081）：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health`、`/health/live` | **Liveness** — 进程能应答即 **200**，不查依赖 |
| `GET` | `/ready`、`/health/ready` | **Readiness** — 数据库、四个数据根与启动期 Bubblewrap 预检都通过才 **200**，否则 **503** |

均为 public 路由（无需 `X-API-Key` / HMAC）。响应**不**包含密钥、连接串、路径或错误文本。

```json
// GET /health — 200
{ "status": "ok" }

// GET /ready — 200 就绪；未就绪时 503 且 status="not_ready"
{
  "status": "ready",
  "shutting_down": false,
  "database": "ok",
  "storage": { "workspaces": "ok", "tmp": "ok", "artifacts": "ok", "control": "ok" },
  "isolation": "ok"
}
```

| 字段 | 取值 | 说明 |
|------|------|------|
| `database` | `ok` / `unavailable` / `not_configured` | 每次请求 `SELECT 1`，2s 超时；`not_configured` 只出现在非生产内存模式，不算失败 |
| `storage.<名>` | `ok` / `unavailable` | `SANDBOX_WORKSPACES_ROOT`、`SANDBOX_TEMP_ROOT`、`SANDBOX_ARTIFACTS_ROOT`、`SANDBOX_CONTROL_ROOT` 是可读写目录，各 2s 超时 |
| `isolation` | `ok` / `unchecked` / `unavailable` | 启动期真跑一次 bwrap 探针的结果，请求时不重跑；预检失败时进程本身拒绝启动 |
| `shutting_down` | `true` 时只返回 `status` 与该字段 | 收到 SIGTERM 后立即 503 |

执行面没有 `/metrics` 端点（旧 Python 执行面的 Prometheus 指标已随其删除）。
