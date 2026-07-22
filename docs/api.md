# API Reference

Pi Enterprise Sandbox 四服务 API 分层：

| 层 | 组件 | 说明 |
|----|------|------|
| **Public** | Frontend Nginx | `/api/*` 反向代理到 API Server |
| **API Server (BFF)** | Node.js 22 (port 4000) | Run API/SSE relay、`/api/status`、文件上传/下载代理 |
| **Agent** | Node.js 22 (port 4100) | 内部 Run API + pi-coding-agent SDK（浏览器不直连） |
| **Sandbox** | FastAPI (port 8081) | Agent 专用内部执行平面（HMAC `/internal/v1/*`）；文件/执行/进程/数据集/产物（Docker 内网） |

无 Python Agent Runtime、无双 Runtime 开关。Agent **支持零 Skill 启动**；共享 `skills/` 挂载与 package skills 由 Agent Profile 策略 + session capability registry 控制。

> **Sandbox 端口 8081 仅 Docker 内网可访问，生产不发布宿主端口**。Agent 调用正式执行能力使用 HMAC-authenticated `/internal/v1/*`；浏览器不能直连 Sandbox，也不能提供 Sandbox service credential。BFF `/api/*` 是唯一浏览器 API 边界。
> MCP 由 Agent Host 的 MCP Connection Manager 直连企业 MCP Gateway/Server，不经过 Sandbox，也不向浏览器暴露凭据。

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

可用 `POST /api/runs/:id/cancel|steer|follow-up` 控制（cancel 亦要求 `Idempotency-Key`）；审批恢复使用 `resume-approval`，用户输入使用 `/interactions/:interactionId/respond`。

`GET /api/runs/{id}` 还返回 `started_at`、`completed_at`（兼容字段
`finished_at`）、`error`、`last_event_id` 与可用时的 `model_id` / `usage`；时间字段统一为 ISO 8601。Run 列表同样可包含模型与 token usage 的轻量投影，来源是 durable 事件，不是进程内计数器。

`GET /api/extensions/diagnostics` 返回 Extension Package、Agent Profile、Tool/MCP allowlist 和供应链审计状态，不含凭据。启用的 MCP Server 会在 Agent 进程启动时执行一次 `tools/list`；连接成功的工具以 `mcp__{serverId}__{toolName}` 出现在 `tools` / `registry.mcp_tools`，配置变更须重启 Agent 才会生效。响应在兼容既有 `extensions` / `tools` / `skills` / `mcp_servers` 字段的同时，增加：

| 字段 | 说明 |
|------|------|
| `view` | `configured`（尚无会话快照）或 `live`（合并最近兼容 run 的 registry 快照） |
| `registry` | `live`、`registry_version`、`run_id`、`profile_id`、`counts`、可选 `mcp_tools` |
| `*.status` | `configured` \| `connected` \| `disabled` \| `failed`（不再一律 `enabled: true` 冒充已激活） |
| `profile.shared_skills` | 共享 skill 挂载策略（`all` \| `allowlist` \| `none`） |

`GET /api/capabilities/{skills,mcp,tools,models}` 仍从 diagnostics 投影列表；字段可附加 `status` / `dynamic`。

Agent 模型侧权威清单工具：`capabilities`（`action=list|search|describe`），只读、有界、不含凭据/完整 schema/技能正文。

### BFF 健康检查

- `GET /health/live`：仅检查 BFF 进程，正常返回 200。
- `GET /health/ready`：检查 Agent 与 Sandbox，任一不可用返回 503。
- `GET /api/status`：兼容 UI 的依赖状态视图，始终返回 200。

```json
// Response (HTTP 200；依赖不可达时 status 可为 "degraded"，不含密钥)
{
  "status": "ok",
  "version": "4.0.0",
  "agent_runtime": "node-agent",
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

- Artifact 下载代理到 `GET /sessions/{id}/artifacts/{aid}/download`
- 路径下载 / 上传代理到 `/sessions/{id}/files/download` 与 `/sessions/{id}/files/upload`
- 上传支持 `Idempotency-Key` 与 `X-Trace-Id` 请求头；BFF 流式落盘后转发，不整包进堆内存
- 超限返回 **413**，业务码见下方 Attachment 约定

---

## 三、Sandbox 内部兼容适配层（非公共 API）

Base URL: `http://sandbox:8081`（Docker 内网）

本节列出的 `/sessions/*`、`/executions/*`、`/files/*`、`/artifacts/*`
路径是旧适配器和 BFF 上游代理的兼容说明，不是浏览器或第三方可依赖的
公共 API。正式 Agent 工具调用走带 scope、claim 和 replay protection 的
`/internal/v1/*` HMAC 平面；生产环境不发布 Sandbox 宿主端口。新的集成
必须添加对应的 `/api/*` BFF 路由或 Agent internal contract，不能把
`X-API-Key` 当作终端用户身份。

### 通用约定

- 所有请求/响应为 JSON
- 错误返回 `{ "detail": "message" }`
- `X-Trace-Id` header 回显 + 关联审计日志
- 兼容适配器认证: 仅受控 BFF/测试环境可使用 `X-API-Key`；正式 Agent
  internal plane 使用短期 HMAC claim（scope、owner、run/session、body
  digest），不接受一个永不过期的全局 token 作为执行授权
- Public 端点豁免认证: `/health`, `/ready`, `/metrics`, `/docs`, `/openapi`, `/redoc`, `/auth/*`
- **可选用户归属**（`SANDBOX_AUTH_ENABLED=true`）:
  - 浏览器终端用户：`POST /api/auth/register|login` 后由 BFF 写入 `HttpOnly; SameSite=Lax` 会话 Cookie；JWT 不暴露给前端 JavaScript。`POST /api/auth/logout` 清理会话。
  - 非浏览器 API 客户端仍可使用 `Authorization: Bearer <jwt>`；BFF 验证后转发可信用户上下文。
  - 兼容 BFF→Sandbox adapters: 服务 `X-API-Key` + 用户 JWT；或服务 key + `X-Acting-User-Id` / `X-Acting-Organization-Id` / `X-Acting-Role`
  - 正式 Agent→Sandbox execution: `/internal/v1/*` HMAC claim（scope + owner + run/session + body digest + replay jti）；不接受浏览器 JWT 或裸 service key 作为执行授权
  - **服务 Token alone 不是终端用户**：不能替代 BFF/Agent 注入的 actor；跨用户/跨组织资源统一 fail-closed
  - 跨用户/跨组织访问 Conversation 返回 **404**（不泄露资源是否存在）
  - 旧数据迁移绑定 `user_bootstrap` / `org_bootstrap`；新用户默认加入 bootstrap org
  - BFF `AUTH_ENABLED`（默认同 `SANDBOX_AUTH_ENABLED`）保护 `/api/conversations`、`/api/runs`、Extension diagnostics、文件/产物路由；`/api/status` 与 `/api/auth/*` 保持公开

### Sessions

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/sessions` | 创建会话 |
| `GET` | `/sessions` | 列出所有活跃会话 |
| `GET` | `/sessions/{id}` | 获取会话详情 |
| `DELETE` | `/sessions/{id}` | 关闭会话并按保留策略清理该 Agent Session 的私有存储 |
| `GET` | `/sessions/by-agent/{aid}` | 按 agent session ID 查询 |
| `GET` | `/sessions/by-enterprise/{eid}` | 按 enterprise session ID 查询 |

#### `POST /sessions` — 创建会话

```json
// Request
{
  "caller_id": "pi-coding-agent",
  "agent_session_id": "...",
  "enterprise_session_id": "...",
  "user_id": "...",
  "metadata": {},
  "conversation_id": "conversation_uuid",
  "workspace_id": "01K0G2PAV8FPMVC9QHJG7JPN4Z"
}

// Response (201)
{
  "session_id": "sandbox_abc123",
  "status": "RUNNING",
  "workspace_id": "ws_abc",
  "agent_session_id": "...",
  "enterprise_session_id": "...",
  "user_id": "...",
  "caller_id": "pi-coding-agent",
  "created_at": "2026-07-04T10:00:00Z",
  "updated_at": "2026-07-04T10:00:00Z",
  "metadata": {}
}
```

> 公共协议使用 opaque **`workspace_id`**。工具/文件/Artifact 接受 workspace 相对路径、`/home/sandbox/workspace/...` 和当前 Agent Session 私有的持久化 `/tmp/...`；其他绝对路径与路径逃逸 fail-closed。
> 物理存储根仅存在于服务内部，**不**出现在 API、SSE 或模型上下文。
> `workspace_id` 由受信任的 Agent Session provisioner 预分配，并与 `agent_session_id` 形成不可变的一对一绑定；它不从 `conversation_id` 派生。Sandbox 拒绝缺失绑定证明或与既有绑定冲突的请求。
> Skill 根在 workspace 外；Agent 可零 Skill 启动。共享/package skills 由 Profile + capability registry 控制；Sandbox 执行侧始终只读。

---

### Executions

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/sessions/{id}/executions/python` | 执行 Python 代码 |
| `POST` | `/sessions/{id}/executions/command` | 执行 Shell 命令 |
| `POST` | `/sessions/{id}/executions/node` | 执行 Node.js 代码 |
| `POST` | `/sessions/{id}/executions/approval-check` | 外部副作用工具的审批预检；普通 workspace bash/python/node 不调用此端点 |
| `GET` | `/sessions/{id}/executions/{eid}` | 查询执行结果 |
| `POST` | `/sessions/{id}/executions/{eid}/cancel` | 取消进行中的执行 |

#### `POST /sessions/{id}/executions/python`

```json
// Request
{ "code": "print('hello')", "timeout": 120 }

// Response (201)
{
  "execution_id": "exec_abc123",
  "session_id": "sandbox_abc123",
  "status": "SUCCESS",
  "stdout_preview": "hello\n",
  "stderr_preview": "",
  "exit_code": 0,
  "duration_ms": 45.2,
  "truncated": false,
  "trace_id": "trace_xyz"
}
```

#### `POST /sessions/{id}/executions/command`

```json
// Request
{ "command": "ls -la", "timeout": 120 }

// Response (201) — 同 Python 响应格式
```

> **注意**：执行完成后**不会自动注册 artifact**。如需将执行产物标记为可下载，请显式调用 `submit_artifact` 或 `register`。

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
| `GET` | `/sessions/{id}/artifacts` | 列出已注册的产物 |
| `POST` | `/sessions/{id}/artifacts/register` | 注册产物（旧端点） |
| **`POST`** | **`/sessions/{id}/artifacts/submit`** | **显式提交产物（推荐）** |
| `GET` | `/sessions/{id}/artifacts/{aid}/download` | 下载产物 |

> **核心设计（P7）**：系统**不会自动扫描** workspace。`write` / `edit` / `bash` 只改私有工作区，**不会**注册 artifact，也**不会**触发 `file_ready`。只有通过 `submit_artifact`（或等价 `POST .../artifacts/submit`）显式提交的文件才会出现在 artifact 列表并可供用户下载。

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

### Approvals

审批的 `idempotency_key` 必须由 Agent 根据 durable run、Sandbox session、工具名、稳定的 SDK
`tool_call_id` 和规范化参数生成，且只在该 session 内生效。相同 `(session_id, idempotency_key)` 的请求
原子复用同一条 pending、approved 或 rejected 记录；同一执行尝试的重试不会重复弹窗。approval resume
会携带原审批 key 和 operation fingerprint 作为一次性授权，即使 SDK 产生新的 `tool_call_id` 也只会
授权完全相同的规范化操作，并在成功使用后失效；之后相同命令的新执行仍会生成新 key。`APPROVAL_MODE=deny`
对 `approval_required` 明确拒绝且不创建记录；`auto_approve` 是显式的开发旁路，生产配置会拒绝它。

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/approvals` | 创建或复用 durable approval |
| `GET` | `/approvals/{id}` | 查询审批状态 |
| `POST` | `/approve` | 审批决策 |

```json
// Request
{ "approval_id": "approval_abc123", "decision": "approve" }

// Response (200)
{ "approval_id": "approval_abc123", "idempotency_key": "approval_hash", "status": "approved", "risk_level": "high", "reason": "" }
```

---

### Conversations

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/conversations` | 列出对话 |
| `POST` | `/conversations` | 创建对话 |
| `GET` | `/conversations/{id}` | 获取对话详情 |
| `PATCH` | `/conversations/{id}` | 更新对话 |
| `DELETE` | `/conversations/{id}` | 删除对话元数据；Workspace 生命周期由 Agent Session 决定 |
| `GET` | `/conversations/{id}/messages` | 获取消息列表 |
| `PATCH` | `/conversations/{id}/title` | 重命名对话 |

```json
// POST /conversations — Request
{ "title": "My Conversation" }

// Response (201)
{
  "id": "conv_uuid",
  "title": "My Conversation",
  "messages": [],
  "created_at": "...",
  "updated_at": "..."
}
```

Conversation 只组织消息，不拥有 Workspace。一个 Conversation 一期默认对应一个活跃 Agent Session；由该 Agent Session 绑定并复用 opaque `workspace_id` 与 `tmp_{workspace_id}`。公共响应不返回物理路径。

---

### Traces

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/runs/{run_id}/trace` | 获取 owner-scoped durable Run trace tree |

```json
// Response (200)
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

查询按已认证用户的 organization/user 与 Run 做归属校验；跨租户或
不存在的 Run 返回相同的 not-found 语义。Trace ID 是查询结果中的字段，
不是未授权的全局索引。

---

### MCP (Model Context Protocol)

Sandbox 不再暴露或代理 MCP 路由。Agent Runtime 的 MCP Connection Manager 直接连接外部 MCP Gateway/Server，并在进程启动时对每个 `enabled=true` 的 `MCP_SERVERS_JSON` 条目执行 `tools/list`。发现的工具直接注册为 `mcp__{serverId}__{toolName}`，并默认走 approval；配置不支持热加载。任一启用 Server 不可连接时，Agent `GET /ready` 返回 503，避免将故障静默降级为没有 MCP 工具。

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
