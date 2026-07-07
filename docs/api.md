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
| `session` | `{ session_id, workspace_path, conversation_id? }` | **首个事件** — Sandbox 会话已创建 |
| `token` | `{ text: string }` | LLM 文本增量 |
| `tool_start` | `{ id, name, args }` | 工具开始执行 |
| `tool_end` | `{ id, name, result, isError }` | 工具执行完成 |
| `file_ready` | `{ path: string }` | 文件可供下载（前端渲染下载链接） |
| `done` | `{}` | Agent 回合结束 |
| `session_closed` | `{ session_id }` | 流连接关闭 |
| `error` | `{ message }` | 错误信息 |

**file_ready 触发来源：**
- `write` 工具执行成功 → 自动触发（显式提交）
- `submit_artifact` 工具执行成功 → 自动触发
- ❌ bash 或代码执行不会自动触发 — Agent 须调用 `submit_artifact` 显式提交

示例流：
```
data: {"type":"session","session_id":"sandbox_abc123","workspace_path":"/sandbox/workspace","conversation_id":"conv_xxx"}
data: {"type":"token","text":"我来帮你写一个"}
data: {"type":"token","text":"Python 脚本。"}
data: {"type":"tool_start","id":"call_1","name":"write","args":{"path":"fib.py","content":"def fib..."}}
data: {"type":"tool_end","id":"call_1","name":"write","result":{"content":[{"type":"text","text":"Written..."}]}}
data: {"type":"file_ready","path":"fib.py"}
data: {"type":"done"}
data: {"type":"session_closed","session_id":"sandbox_abc123"}
```

---

## 二、API Server API

Base URL: `http://host:4000`

### `POST /api/chat` — 发送消息（SSE 流）

```json
// Request
{ "messages": [{ "role": "user", "content": "写一个 Python 脚本" }] }
```

响应: SSE `text/event-stream`，见上方事件协议。

### `GET /api/status` — 健康检查

```json
// Response (200)
{ "status": "ok", "version": "4.0.0" }
```

### 文件代理

| 端点 | 说明 |
|------|------|
| `GET /api/files/download?session_id=xxx&path=yyy` | 从 Sandbox workspace 下载文件 |
| `POST /api/files/upload?session_id=xxx` | 上传文件 (multipart) |

两者均代理到 Sandbox `/sessions/{id}/files/download` 和 `/sessions/{id}/files/upload`。

---

## 三、Sandbox API

Base URL: `http://sandbox:8081`（Docker 内网）

### 通用约定

- 所有请求/响应为 JSON
- 错误返回 `{ "detail": "message" }`
- `X-Trace-Id` header 回显 + 关联审计日志
- 认证: `X-API-Key` header（如配置 `SANDBOX_API_TOKEN`）
- Public 端点豁免认证: `/health`, `/ready`, `/metrics`, `/docs`, `/openapi`, `/redoc`

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
  "workspace_path": "/sandbox/workspace",       // ← 统一路径（symlink）
  "agent_session_id": "...",
  "enterprise_session_id": "...",
  "user_id": "...",
  "caller_id": "pi-coding-agent",
  "created_at": "2026-07-04T10:00:00Z",
  "updated_at": "2026-07-04T10:00:00Z",
  "metadata": {
    "_physical_workspace": "/var/sandbox/workspaces/sandbox_xxx"  // 实际物理路径
  }
}
```

> **workspace_path 始终返回 `/sandbox/workspace`**（统一 symlink 路径）。物理路径在 `metadata._physical_workspace` 中。

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
| `GET` | `/sessions/{id}/files?path=.` | 列出文件 |
| `GET` | `/sessions/{id}/files/read?path=&offset=&limit=` | 读取文件 |
| `POST` | `/sessions/{id}/files/read` | 读取文件（POST body） |
| `POST` | `/sessions/{id}/files/write` | 写入文件 |
| `GET` | `/sessions/{id}/files/preview?path=` | 预览文件前 40 行 |
| `GET` | `/sessions/{id}/files/download?path=` | 下载文件 |
| `DELETE` | `/sessions/{id}/files?path=` | 删除文件 |
| `POST` | `/sessions/{id}/files/upload` | 上传文件 (multipart) |

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

> **核心设计**：系统**不会自动扫描** workspace 来发现产物。只有通过 `write` 工具 或 `submit_artifact` 显式提交的文件才会出现在 artifact 列表中。Agent 使用 `bash` 创建文件后，须调用 `submit_artifact` 使其可下载。

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
| `GET` | `/health` | 健康检查 |
| `GET` | `/ready` | 就绪检查 |
| `GET` | `/metrics` | Prometheus 指标 (文本格式) |

```json
// GET /health — Response (200)
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
