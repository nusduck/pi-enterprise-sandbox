# API Reference

Pi Enterprise Sandbox API 分层：

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

API Server 通过 SSE (`text/event-stream`) 推送以下事件类型：

| 事件 | 字段 | 说明 |
|------|------|------|
| `trace` | `{ trace_id }` | 端到端追踪 ID（BFF/Agent 入口） |
| `session` | `{ session_id, workspace_id, conversation_id?, session_reused?, trace_id? }` | Sandbox 会话已创建/复用（公共协议不暴露物理路径） |
| `token` | `{ text: string }` | LLM 文本增量 |
| `tool_start` | `{ id, name, args }` | 工具开始执行 |
| `tool_end` | `{ id, name, result, isError }` | 工具执行完成 |
| `file_ready` | `{ artifact_id, path, name?, mime_type?, size? }` | 产物可供下载（仅 `submit_artifact` 成功后） |
| `approval_required` | `{ approval_id, idempotency_key?, tool_name?, command?, reason?, risk_level? }` | 高风险工具等待人工审批；同一 key 只产生一个 durable approval |
| `interaction_requested` | `{ interaction_id, interaction_type, title, options? }` | Agent 等待用户输入 |
| `task_plan_updated` | `{ tasks }` | 结构化任务计划更新 |
| `context_warning` | `{ tokens, context_window, percent }` | 上下文使用率预警 |
| `compaction_started/completed/failed` | `{ reason }` | 上下文压缩生命周期 |
| `capability_registry_updated` | `{ reason, registry_version, counts?, run_id?, profile_id? }` | Session capability registry 变更（有界、无密钥） |
| `done` | `{}` | Agent 回合结束 |
| `session_closed` | `{ session_id }` | 流连接关闭 |
| `error` | `{ message }` | 错误信息 |

共享契约夹具：`tests/fixtures/sse_events.json`。

**file_ready 触发来源（P7 产物唯一交付）：**
- ✅ `submit_artifact` 工具执行成功 → 发出 `file_ready`（含 `artifact_id` 等字段）
- ❌ `write` / `edit` 成功 **不会** 发出 `file_ready`（仅写私有工作区）
- ❌ bash 或代码执行不会自动触发 — Agent 须调用 `submit_artifact` 显式提交
- ❌ 无 workspace 自动扫描

示例流：
```
data: {"type":"session","session_id":"sandbox_abc123","workspace_id":"ws_abc","conversation_id":"conv_xxx"}
data: {"type":"token","text":"我来帮你写一个"}
data: {"type":"token","text":"Python 脚本。"}
data: {"type":"tool_start","id":"call_1","name":"write","args":{"path":"fib.py","content":"def fib..."}}
data: {"type":"tool_end","id":"call_1","name":"write","result":{"content":[{"type":"text","text":"Written..."}]}}
data: {"type":"tool_start","id":"call_2","name":"submit_artifact","args":{"path":"fib.py","name":"fib.py"}}
data: {"type":"tool_end","id":"call_2","name":"submit_artifact","result":{...}}
data: {"type":"file_ready","artifact_id":"art_abc123","path":"fib.py","name":"fib.py","mime_type":"application/octet-stream","size":42}
data: {"type":"done"}
data: {"type":"session_closed","session_id":"sandbox_abc123"}
```

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

`skills` 是**按调用者投影**的：Agent 用服务端写入的 `X-Acting-User-Id` / `X-Acting-Organization-Id` 解析内部 owner，列出系统层、该 owner 的已发布层和草稿层。`source` 分别为 `shared-skill-root`、`user-skill-root`、`draft-skill-root`；浏览器传入的同名 header 不会被透传。

**2026-08-31（ADR 0009 D7）起，用户侧 Skill 有三个根**：系统根（只读，永远进 prompt）、已启用根（逐包只读，进 prompt）、**草稿根 `/home/sandbox/skill-draft`**（每用户一个，模型可写，**不进发现也不进 prompt**）。模型用 `write` / `bash` 在草稿根里造包——`skill_install` / `skill_create` / `skill_edit` / `skill_uninstall` 这四个工具**已整体取消**。闸门只剩一处：人在 UI 上按「启用」，那一刻平台校验结构、**把字节复制成一份只读的已发布副本**、记内容摘要与启用态（`user_skill_enablements`，owner-scoped）。因为是两份字节，模型之后改草稿动不了已启用的包，所以不需要每 Run 重算摘要。请求不带身份时只投影系统层；用户层基目录**永远不整根扫描**，否则会跨租户列出他人已安装的 Skill。

启用/停用入口是 `POST /api/capabilities/skills/{name}/enable|disable`。BFF 只做代理与身份投影；Agent 校验包、更新发布副本与 MySQL 账本。启用账本写失败时会撤回发布副本，保持 fail-closed。

草稿在**启用之后不会消失**——启用是复制字节，草稿留在原地当可编辑的源，停用只删已发布的那份副本。所以 `skill_drafts` 里会一直有它；这类条目带 `published: true` 与 `status: 'published'`，与还等着人按「Enable」的 `published: false` / `status: 'draft'` 区分。UI 的 Drafts 区只列后者，否则同一个名字会在页面上出现两次。要重新发布一份改过的草稿，先在 My Skills 里 Disable，草稿会回到 Drafts。

草稿包上传入口是 `POST /api/capabilities/skills/drafts`。支持通过 UI 或客户端直传 `.zip` 与 `.skill` 归档包（请求头带 `X-Filename`，流式二进制 body，单包上限 50MB）。BFF 受信鉴权后透传 Agent；Agent 校验包结构与 `SKILL.md`，解压落入当前用户的草稿根目录 `/home/sandbox/skill-draft/<org>/<user>/<skill-name>/`，状态保持为未启用（`enabled: false, status: 'draft'`）。草稿不进模型发现、不进 prompt，等待用户在 UI 上点击「Enable」正式启用。

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
| `POST` | `/api/auth/logout` | 清理会话 |
| `GET` | `/api/auth/me` | 当前用户 |
| `GET` `POST` | `/api/conversations` | 列出 / 创建 Conversation |
| `GET` `DELETE` | `/api/conversations/{id}` | 详情 / 删除 |
| `GET` | `/api/conversations/{id}/events` | Conversation 维度 SSE |
| `POST` | `/api/conversations/{id}/runs` | 在指定 Conversation 下创建 Run |
| `POST` | `/api/conversations/{id}/follow-ups` | 追问 |
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
| `GET` | `/api/approvals` | 待审批列表 |
| `GET` | `/api/approvals/{id}` | 审批详情 |
| `POST` | `/api/approvals/{id}/decide` | 批准 / 拒绝 |
| `GET` | `/api/artifacts` | Artifact 列表 |
| `GET` | `/api/datasets` | Dataset 列表 |
| `GET` | `/api/processes` | 长进程列表；必传 `session_id`，可按 `run_id` / `status` 筛选 |
| `GET` | `/api/processes/{id}` | 进程详情；必传 `session_id` |
| `GET` | `/api/processes/{id}/logs\|read` | 进程输出（游标读）；必传 `session_id` |
| `POST` | `/api/processes/{id}/stdin\|signal\|cancel\|kill` | 进程控制；JSON body 必传 `session_id` |
| `GET` | `/api/agents` | org 内可选的智能体（Agent 目录） |
| `POST` | `/api/agents` | 新建智能体，自带 v1 并指向它（**admin**） |
| `GET` `POST` | `/api/agents/{id}/versions` | 版本线 / 建新版本（**admin**） |
| `POST` | `/api/agents/{id}/active-version` | 切活跃版本，也是回滚（**admin**） |
| `GET` `POST` | `/api/cron-jobs` | 列出 / 创建定时任务 |
| `GET` `PATCH` `DELETE` | `/api/cron-jobs/{id}` | 详情 / 修改 / 删除 |
| `GET` | `/api/cron-jobs/{id}/runs` | 该定时任务的历史 Run |
| `POST` | `/api/cron-jobs/{id}/run` | 立即触发一次 |
| `GET` | `/api/capabilities/{skills,mcp,tools,models}` | 从 diagnostics 投影的能力清单 |
| `POST` | `/api/capabilities/skills/drafts` | 上传 Skill 草稿包（.zip / .skill）；解压至用户草稿根，保持未启用 |
| `POST` | `/api/capabilities/skills/{name}/enable\|disable` | 启用草稿 / 停用用户 Skill；owner-scoped |
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
| `systemPrompt` | ✅ | 作为租户自定义段进入发给模型的 system prompt，排在 harness 身份之后、企业条款之前；企业条款始终追加在它后面且**不可被租户覆盖** |
| `modelPolicy`（含内嵌 `model`） | ✅ | `modelResolver` 解析出本次 Run 的具体模型；内嵌完整 model 时 `input.model` 不能改身份 |
| `modelPolicy.maxOutputTokens` | ✅ | 覆盖解析出的 `Model.maxTokens` |
| `toolPolicy` | ✅ | 逐调用闸门（`tools/pre-execute`）与风险表 |
| `modelPolicy.temperature` | ❌ | 校验后携带，SDK 侧尚未接线 |
| `modelPolicy.thinkingLevel` | ❌ | 同上 |
| `skills` | ❌ | 运行时的 skill 只来自**调用者自己的 skill 目录**；这里的值仅用于 A2A agent card 展示 |
| `mcpServers` | ❌ | **按设计如此**：server 清单只来自进程环境变量 `MCP_SERVERS_JSON`（AGENTS.md §1） |
| `extensions` | ❌ | Pi Extension 机制已随 ADR 0009 H7 退役 |
| `sandboxPolicy` | ❌ | **保留字段，没有执行路径**。沙箱模式、网络模式、可写根都由 exec 的部署级配置决定，不按 Agent 分（ADR 0002 起就是如此） |
| `a2a` / `contextPolicy` | ❌ | 无读取方 |

选择 Agent 的入口有三个，都只接受 `agent_id`（ULID），不接受 `agent_version_id`：

| 入口 | 何时生效 |
|------|---------|
| `POST /api/runs` / `/api/conversations/{id}/runs` | `conversation_id` 为空时——首轮消息就是"建会话" |
| `POST /api/conversations` | 显式建会话 |
| `POST /api/sessions/ensure` | 不带 `conversation_id` 时 |

**一个会话绑定一个 Agent，绑定在建会话时完成，此后不可变**：换 Agent 要新建会话。
已存在的会话即使不传 `agent_id`，后续 Run 也继续用它绑定的那个 Agent，不会回落到
租户默认。不传 `agent_id` 建新会话时的行为与多 Agent 上线前完全一致（租户默认 Agent）。
`GET /api/conversations{,/id}` 的响应带 `agent_id`，即该会话绑定的智能体。

进程接口的事实与控制权在 exec 的 `exec_jobs`，不在 Agent。BFF 先让 Agent
按当前浏览器身份授权 `session_id` 并取得其 `workspace_id`，再用 owner-scoped
exec 公共适配器查询或控制；返回给浏览器时仍投影原 `session_id`。不存在或
跨租户访问统一返回 404。`logs` 返回 `next_offset`、`completed`、`truncated`、
`log_total`；进程详情含 `process_id`、`run_id`、`status`、`command` 和时间字段。
`kill` 是 `signal` 的兼容别名，默认同样发送 `SIGTERM`；需要终止升级语义使用
`cancel`，需要指定信号则在 body 传 `signal`。Agent 不提供
`/internal/processes*` 路由。

admin 只有一个来源：`SANDBOX_AUTH_ADMIN_USERNAMES`（逗号分隔，大小写不敏感）。
注册接口忽略客户端提交的 `role` / `organization_id`；名单内的用户名注册即为
admin，已存在的账号在下次 login 或 `/auth/me` 时提升，移出名单则降级。
`BFF_DEV_ACTING_ROLE` 只影响 `AUTH_ENABLED=false` 的开发身份，不会提升真实用户。

认证数据与 token 的唯一权威是 Agent：BFF 的四条 `/api/auth/*` 适配器调用
Agent `/internal/auth/*`，成功后只把 JWT 写入 HttpOnly Cookie。exec 不保存密码、
不签发或验证浏览器 JWT，也没有 `/auth/*` 路由。

### BFF 健康检查

- `GET /health/live`：仅检查 BFF 进程，正常返回 200。
- `GET /health/ready`：检查 Agent 与 Sandbox，任一不可用返回 503。

```json
// Response (HTTP 200；依赖不可达时 503 且 status 为 "degraded"，不含密钥)
{
  "status": "ok",
  "version": "4.0.0",
  "agent": { "status": "ok" },
  "sandbox": { "status": "ok" }
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
- 路径下载 / 上传代理到 `/sessions/{id}/files/download` 与 `/sessions/{id}/files/upload`
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

### 通用约定

- 所有请求/响应为 JSON
- 错误返回 `{ "detail": "message" }`
- `X-Trace-Id` header 回显 + 关联审计日志
- 兼容适配器认证: 仅受控 BFF/测试环境可使用 `X-API-Key`；正式 Agent
  internal plane 使用短期 HMAC claim（scope、owner、run/session、body
  digest），不接受一个永不过期的全局 token 作为执行授权
- exec 的 public 探针豁免认证：`/health`, `/ready`, `/metrics`；浏览器认证只存在于 BFF `/api/auth/*`
- **可选用户归属**（BFF `AUTH_ENABLED=true`；`SANDBOX_AUTH_ENABLED` 仅保留为 BFF 的旧配置别名）:
  - 浏览器终端用户：`POST /api/auth/register|login` 后由 BFF 写入 `HttpOnly; SameSite=Lax` 会话 Cookie；JWT 不暴露给前端 JavaScript。`POST /api/auth/logout` 清理会话。
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
| — | `/internal/mcp/v1/*` | `sandbox-mcp` facade（独立部署，见 [`sandbox-mcp.md`](./sandbox-mcp.md)） |

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
| `GET` | `/sessions/{id}/artifacts` | 列举本工作区的产物 |
| `POST` | `/sessions/{id}/artifacts/register` | 注册产物（旧端点） |
| **`POST`** | **`/sessions/{id}/artifacts/submit`** | **显式提交产物（推荐）** |
| `POST` | `/sessions/{id}/artifacts/imports` | 将 owner-scoped Artifact 导入本 Session workspace（BFF 上游兼容端点） |
| `GET` | `/sessions/{id}/artifacts/{aid}/download` | 下载产物 |

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

Agent Runtime 的 MCP Connection Manager 仍直接连接外部 MCP Gateway/Server，并在进程启动时对每个 `enabled=true` 的 `MCP_SERVERS_JSON` 条目执行 `tools/list`。发现的工具直接注册为 `mcp__{serverId}__{toolName}`，并默认走 approval；配置不支持热加载。任一启用 Server 不可连接时，Agent `GET /ready` 返回 503，避免将故障静默降级为没有 MCP 工具。

另外，执行面镜像提供**第二个入口** `sandbox-mcp`（Streamable HTTP，`/mcp`），用于不经过 Agent 的受限 Python、文件和 Artifact 工作流。它是独立进程、独立凭据，只能经 `/internal/mcp/v1/*` 窄桥访问执行面，够不到 HMAC 内部面；不挂载任何工作区卷。详细部署与认证边界见 [`sandbox-mcp.md`](./sandbox-mcp.md)。

---

### Health & Monitoring

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | **Liveness** — 进程存活。只要服务能应答即 **200**（不因依赖失败而 503） |
| `GET` | `/ready` | **Readiness** — 依赖就绪（工作区可写 + 数据库可 `SELECT 1`）。未就绪返回 **503** |
| `GET` | `/metrics` | Prometheus 指标 (文本格式) |

两者均为 public 路由（无需 `X-API-Key` / JWT）。响应**不**包含密钥、连接串、绝对路径或环境变量 dump。

```json
// GET /health — Response (200)  进程存活
// GET /ready  — Response (200)  依赖就绪；未就绪时 HTTP 503 且 status="not_ready"
{
  "status": "ok",
  "version": "0.1.0",
  "sessions_active": 3,
  "executions_total": 42,
  "workspace_available": true,
  "disk_free_mb": 15200.5,
  "runtimes": { "python": true, "bash": true, "node": true },
  "internal_plane_status": "ready"
}
```

| 字段 | `/health` | `/ready` |
|------|-----------|----------|
| `status` | 始终 `"ok"`（能应答即存活） | `"ok"` 或 `"not_ready"` |
| HTTP | 200 | 200 就绪 / **503** 未就绪 |
| `workspace_available` | 尽力探测；失败不影响 liveness 状态码 | 工作区根目录存在且可写 |
| 数据库 | 不检查 | 必须 `SELECT 1` 成功 |
| `internal_plane_status` | `disabled` 或 `not_checked` | `disabled`、`ready` 或 `not_ready` |

#### Prometheus Metrics

| Metric | Type | Labels | 说明 |
|--------|------|--------|------|
| `sandbox_execution_total` | Counter | `session_id`, `status` | 执行总数 |
| `sandbox_execution_failed_total` | Counter | — | 失败执行数 |
| `sandbox_execution_timeout_total` | Counter | — | 超时执行数 |
| `sandbox_execution_duration_seconds` | Gauge | — | 执行耗时 |
| `sandbox_active_sessions` | Gauge | — | 活跃会话数 |
| `sandbox_workspace_bytes` | Gauge | — | 工作区磁盘使用量 |
| `sandbox_rate_limited_total` | Counter | `caller_id` | 速率限制触发数 |
