# API Reference

Pi Enterprise Sandbox 有三层 API：

| 层 | 组件 | 说明 |
|----|------|------|
| **Public** | Frontend Nginx | `/api/*` 反向代理到 API Server |
| **API Server** | Node.js (port 4000) | `/api/chat` SSE, `/api/status`, 文件上传/下载代理 |
| **Sandbox** | FastAPI (port 8081) | 会话/执行/文件/产物/审计/审批/MCP (Docker 内网) |

> **Sandbox 端口 8081 仅 Docker 内网可访问**。API Server 自动为所有 Sandbox 请求添加 `X-API-Key` header（如配置 `SANDBOX_API_TOKEN`）。
> MCP-over-HTTP 通过 `GET /mcp/tools` + `POST /mcp/call` 对外暴露（端口 8093→8091）。

---

## 一、SSE 事件协议

API Server 通过 SSE (`text/event-stream`) 推送以下事件类型：

| 事件 | 字段 | 说明 |
|------|------|------|
| `trace` | `{ trace_id }` | 端到端追踪 ID（BFF/Agent 入口） |
| `session` | `{ session_id, workspace_path, conversation_id?, session_reused?, trace_id? }` | Sandbox 会话已创建/复用 |
| `token` | `{ text: string }` | LLM 文本增量 |
| `tool_start` | `{ id, name, args }` | 工具开始执行 |
| `tool_end` | `{ id, name, result, isError }` | 工具执行完成 |
| `file_ready` | `{ artifact_id, path, name?, mime_type?, size? }` | 产物可供下载（仅 `submit_artifact` 成功后） |
| `approval_required` | `{ approval_id, tool_name?, command?, reason?, risk_level? }` | 高风险工具等待人工审批 |
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
data: {"type":"session","session_id":"sandbox_abc123","workspace_path":"/home/sandbox/workspace","conversation_id":"conv_xxx"}
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

### `POST /api/chat` — 发送消息（SSE 流）

```json
// Request
{ "messages": [{ "role": "user", "content": "写一个 Python 脚本" }], "conversation_id": "optional" }
```

响应: SSE `text/event-stream`，见上方事件协议。

**运行时选择（`AGENT_RUNTIME`）：**

| 值 | 行为 |
|----|------|
| `node`（默认） | Node `handleChat` + pi-coding-agent |
| `python` | BFF 将请求/SSE 透传到 Sandbox `POST /agent/chat` |

回滚：将 `AGENT_RUNTIME` 设回 `node` 并重启 api-server；前端无需变更。

### `GET /api/status` — BFF 状态

```json
// Response (HTTP 200；Sandbox 不可达时 status 可为 "degraded"，不含密钥)
{
  "status": "ok",
  "version": "4.0.0",
  "agent_runtime": "node",
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

## 三、Sandbox API

Base URL: `http://sandbox:8081`（Docker 内网）

### 通用约定

- 所有请求/响应为 JSON
- 错误返回 `{ "detail": "message" }`
- `X-Trace-Id` header 回显 + 关联审计日志
- 认证: `X-API-Key` header（如配置 `SANDBOX_API_TOKEN`）
- Public 端点豁免认证: `/health`, `/ready`, `/metrics`, `/docs`, `/openapi`, `/redoc`, `/auth/*`
- **可选用户归属**（`SANDBOX_AUTH_ENABLED=true`）:
  - 终端用户: `Authorization: Bearer <jwt>`（`POST /auth/register|login` 签发，含 `organization_id` / `role`）
  - BFF→Sandbox: 服务 `X-API-Key` + 用户 JWT；或服务 key + `X-Acting-User-Id` / `X-Acting-Organization-Id` / `X-Acting-Role`
  - **服务 Token alone 不是终端用户**：可访问内部 `/sessions` 等，但 `/conversations` 与已归属 session 的 files/artifacts 需 actor，否则 401
  - 跨用户/跨组织访问 Conversation 返回 **404**（不泄露资源是否存在）
  - 旧数据迁移绑定 `user_bootstrap` / `org_bootstrap`；新用户默认加入 bootstrap org
  - BFF `AUTH_ENABLED`（默认同 `SANDBOX_AUTH_ENABLED`）保护 `/api/conversations`、`/api/chat`、文件/产物路由；`/api/status` 与 `/api/auth/*` 保持公开

### Sessions

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/sessions` | 创建会话 |
| `GET` | `/sessions` | 列出所有活跃会话 |
| `GET` | `/sessions/{id}` | 获取会话详情 |
| `DELETE` | `/sessions/{id}` | 关闭会话 + 清理工作区 |
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
  "workspace_path": "/var/sandbox/workspaces/conv_xxx"  // 可选：复用已有工作区
}

// Response (201)
{
  "session_id": "sandbox_abc123",
  "status": "RUNNING",
  "workspace_path": "/home/sandbox/workspace",  // ← agent-visible stable path (P3)
  "agent_session_id": "...",
  "enterprise_session_id": "...",
  "user_id": "...",
  "caller_id": "pi-coding-agent",
  "created_at": "2026-07-04T10:00:00Z",
  "updated_at": "2026-07-04T10:00:00Z",
  "metadata": {
    "_physical_workspace": "/var/sandbox/workspaces/sandbox_xxx"  // actual on-disk path
  }
}
```

> **workspace_path** is the stable agent-visible path **`/home/sandbox/workspace`**.  
> Physical storage is **`metadata._physical_workspace`** (session-owned; all exec/file/artifact I/O uses this).  
> Skills are always **`/home/sandbox/skill`** (read-only), outside the workspace.

---

### Executions

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/sessions/{id}/executions/python` | 执行 Python 代码 |
| `POST` | `/sessions/{id}/executions/command` | 执行 Shell 命令 |
| `POST` | `/sessions/{id}/executions/node` | 执行 Node.js 代码 |
| `POST` | `/sessions/{id}/executions/approval-check` | 预检工具风险等级 |
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

Agent 工具 `ls` / `find` / `grep` 覆盖 SDK 本地同名工具，全部转发到下列 Sandbox 端点。仅访问当前 session workspace；不跟随逃逸 symlink；不返回物理根路径。调用方只能收紧限制。

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

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/approve` | 审批决策 |

```json
// Request
{ "approval_id": "approval_abc123", "decision": "approve" }

// Response (200)
{ "approval_id": "approval_abc123", "status": "approved", "risk_level": "high", "reason": "" }
```

---

### Conversations

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/conversations` | 列出对话 |
| `POST` | `/conversations` | 创建对话 |
| `GET` | `/conversations/{id}` | 获取对话详情 |
| `PATCH` | `/conversations/{id}` | 更新对话 |
| `DELETE` | `/conversations/{id}` | 删除对话 + 清理工作区 |
| `GET` | `/conversations/{id}/workspace` | 获取对话工作区路径 |
| `GET` | `/conversations/{id}/messages` | 获取消息列表 |
| `PATCH` | `/conversations/{id}/title` | 重命名对话 |

```json
// POST /conversations — Request
{ "title": "My Conversation" }

// Response (201)
{
  "id": "conv_uuid",
  "title": "My Conversation",
  "workspace_path": "/var/sandbox/workspaces/conv_uuid",
  "messages": [],
  "created_at": "...",
  "updated_at": "..."
}
```

对话工作区路径存储在 `conversations.workspace_path` 中，可在后续 `POST /sessions` 时通过 `workspace_path` 参数复用（实现跨轮次文件持久化）。

---

### Traces

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/traces/{trace_id}` | 获取完整追踪链 |

```json
// Response (200)
{
  "trace_id": "trace_xyz",
  "session": { ... },
  "executions": [ ... ],
  "audit_logs": [ ... ]
}
```

---

### MCP (Model Context Protocol)

MCP 以 REST over HTTP 模式暴露，兼容 Dify、Hi-Agent 等外部平台。**不是**独立的 SSE 服务器——路由在 Sandbox 主应用中。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/mcp/tools` | 列出可用 MCP 工具及其参数 |
| `POST` | `/mcp/call` | 调用 MCP 工具 |

认证: `X-Auth-Token` header（如配置 `SANDBOX_MCP_AUTH_TOKENS`）

#### 可用工具（11 个）

| 工具名 | 说明 |
|--------|------|
| `create_session` | 创建 Sandbox 会话 + 初始化工作区 |
| `close_session` | 关闭会话 + 清理工作区 |
| `run_python` | 执行 Python 代码 |
| `run_command_limited` | 执行受限制的 Shell 命令（危险命令被阻止） |
| `read_file` | 读取工作区文件 |
| `write_file` | 写入工作区文件 |
| `preview_file` | 预览文件前 40 行 |
| `list_files` | 列出工作区目录 |
| `download_file` | 获取文件下载信息 |
| `get_artifacts` | 列出会话的 artifact 列表 |
| `submit_artifact` | 显式提交文件为 artifact |

#### `POST /mcp/call`

```json
// Request
{
  "tool_name": "submit_artifact",
  "caller_id": "external-platform",
  "kwargs": {
    "session_id": "sandbox_abc123",
    "path": "report.csv",
    "name": "report.csv",
    "mime_type": "text/csv"
  }
}

// Response (200)
{
  "artifact_id": "art_abc123",
  "name": "report.csv",
  "path": "report.csv",
  "mime_type": "text/csv",
  "size": 1024
}
```

#### 错误码

| HTTP 状态 | 说明 |
|-----------|------|
| `404` | 工具不存在 |
| `403` | 工具被安全策略拒绝 |
| `429` | 速率限制触发 |

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
  "runtimes": { "python": true, "bash": true, "node": true }
}
```

| 字段 | `/health` | `/ready` |
|------|-----------|----------|
| `status` | 始终 `"ok"`（能应答即存活） | `"ok"` 或 `"not_ready"` |
| HTTP | 200 | 200 就绪 / **503** 未就绪 |
| `workspace_available` | 尽力探测；失败不影响 liveness 状态码 | 工作区根目录存在且可写 |
| 数据库 | 不检查 | 必须 `SELECT 1` 成功 |

#### Prometheus Metrics

| Metric | Type | Labels | 说明 |
|--------|------|--------|------|
| `sandbox_execution_total` | Counter | `session_id`, `status` | 执行总数 |
| `sandbox_execution_failed_total` | Counter | — | 失败执行数 |
| `sandbox_execution_timeout_total` | Counter | — | 超时执行数 |
| `sandbox_execution_duration_seconds` | Gauge | — | 执行耗时 |
| `sandbox_active_sessions` | Gauge | — | 活跃会话数 |
| `sandbox_workspace_bytes` | Gauge | — | 工作区磁盘使用量 |
| `sandbox_mcp_requests_total` | Counter | `tool_name` | MCP 请求总数 |
| `sandbox_rate_limited_total` | Counter | `caller_id` | 速率限制触发数 |
