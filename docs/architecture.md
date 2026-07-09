# Architecture

## Overview

Pi Enterprise Sandbox 采用**三层架构**，前端、API 服务、沙箱执行环境各自独立容器部署。

```
┌──────────────────────────────────────────────────────────┐
│                   Frontend (Nginx)                        │
│    静态 SPA (Vite build) · /api/* 反向代理                │
│    host:3000 → container:80                              │
├──────────────────────────────────────────────────────────┤
│                API Server (Node.js)                       │
│    pi-coding-agent SDK · SSE streaming · sandbox proxy   │
│    host:4000 → container:4000                            │
├──────────────────────────────────────────────────────────┤
│              Sandbox Service (FastAPI)                     │
│    Session · Execution · File · Approval · Artifact      │
│    Audit Logging · Resource Limits · MCP Export          │
│    SQLite Persistence (WAL mode)                         │
│    host:8083 → container:8081 · MCP host:8093 → 8091     │
├──────────────────────────────────────────────────────────┤
│           Isolated Workspace (container)                   │
│    iptables · ulimit · non-root · path security          │
└──────────────────────────────────────────────────────────┘
```

## 组件职责

| 组件 | 容器名 | 技术栈 | 职责 |
|------|--------|--------|------|
| **Frontend** | `pi-enterprise-frontend` | Vite + pi-web-ui → Nginx | 纯 UI 渲染，零 Agent 逻辑；Nginx 反向代理 `/api/*` |
| **API Server** | `pi-enterprise-api` | Node.js + pi-coding-agent SDK | Agent 运行时（LLM 直连 + 工具编排 + SSE 推送） |
| **Sandbox** | `pi-enterprise-sandbox` | Python 3.11 + FastAPI | 安全命令执行、文件读写、产物管理、审批工作流 |

## 通信协议

```
Browser ──HTTP──► Frontend (Nginx:80) ──HTTP──► API Server (Node:4000) ──HTTP──► Sandbox (FastAPI:8081)
  │  host:3000→80         │  /api/* 反向代理          │  SSE event stream            │  REST JSON API
  │                       │                          │  pi-coding-agent loop        │  多层安全防护
```

- **Browser → Frontend**: HTTP，静态文件服务 + `/api/*` 反向代理
- **Frontend → API Server**: 反向代理（Docker 内网），无需 CORS
- **API Server → Sandbox**: HTTP REST，Docker 内网直连。可选 `X-API-Key` 认证
- **API Server → LLM**: HTTPS 直连，API Key 仅存服务端环境变量
- **Browser ← API Server**: SSE (`text/event-stream`)，事件驱动渲染

## Key Design Decisions

### 1. 服务端 Agent 运行时

Agent（`pi-coding-agent` SDK）运行在 API Server 的 Node.js 进程中，而非浏览器。收益：

- **LLM API Key 零暴露** — 仅存服务端环境变量
- **无 CORS 问题** — 服务端直连 LLM API
- **无代理层** — 减少跳数，消除转发代码
- **工具调用不可篡改** — 用户只能发文本消息，无法绕过服务端

### 2. 前端纯 UI，零 Agent 依赖

前端仅使用 `@earendil-works/pi-web-ui` 的 UI 组件（MessageList / MessageEditor / StreamingMessageContainer），不 import `pi-agent-core`、`pi-ai`。前端通过 SSE 消费事件流直接渲染，自己管理简单状态。

### 3. Session-owned workspace 隔离

每个 Agent/Sandbox session 绑定 **唯一物理工作区**（1 session → 1 workspace）：
- 物理路径：`{SANDBOX_WORKSPACES_ROOT}/{session_id}/`（空目录起步）
- Agent 可见稳定路径：`/home/sandbox/workspace`（API 元数据）；执行/文件/产物一律用物理路径
- Skills：`/home/sandbox/skill`（只读，共享，不进 workspace）
- 串行执行（同一会话内命令排队，防止竞态）
- 30 分钟 TTL 自动清理

### 4. SQLite with WAL Mode

- 并发读 + 写不互斥
- 零配置、零外部依赖
- ACID 事务
- 单文件，易于备份恢复
- 可选 PostgreSQL（设置 `SANDBOX_DATABASE_URL`）

### 5. 审批工作流（策略执行）

工具按风险分级：
- **低**（`read`, `write` 文本）→ 直接放行
- **中**（`write` 二进制, `edit`）→ 日志记录后放行
- **高**（`bash`, `raw_bash`）→ 需显式审批或超时自动拒绝

### 6. Trace ID 全链路

每个请求携带 `X-Trace-Id` header：
- 响应头回显
- 审计日志关联
- 可查询完整追踪链：`GET /traces/{trace_id}`

### 7. 非 Root 执行

所有子进程以 `sandbox` 用户运行（UID != 0），配合 ulimit 资源控制，防止容器逃逸和资源耗尽。

## Main Data Flows

### 一次完整对话

```
1. 用户输入 → Browser 发送 POST /api/chat (JSON body)
2. Frontend Nginx 反向代理到 api-server:4000
3. API Server:
   a. 创建或复用会话 → POST sandbox:8081/sessions
      - 首次：自动创建 Conversation → 初始化持久工作区
      - 后续：传入 conversation_id 复用现有工作区
   b. 初始化 pi-coding-agent session（tools, model, auth, skills）
   c. 注入系统提示（文件分享说明）
   d. 调用 session.prompt(text)
   e. Agent 循环：
      - LLM text_delta → SSE: {type:"token", text:"..."}
      - 工具调用 → Sandbox API → SSE: tool_start/tool_end
      - write/edit 成功 → 仅私有工作区变更，**不**发 file_ready
      - submit_artifact 成功 → Artifact API + SSE: {type:"file_ready", artifact_id, path, name, mime_type, size}
   f. SSE: {type:"done"} — 无自动 workspace 扫描
4. Browser 消费 SSE 流；交付物用 artifact_id 下载（`/api/files/artifact-download`）
```

### SSE 事件协议

| 事件类型 | 字段 | 说明 |
|----------|------|------|
| `session` | `{ session_id, workspace_path, conversation_id? }` | Sandbox 会话已创建（`conversation_id` 用于跨轮次文件持久化） |
| `token` | `{ text: string }` | LLM 文本增量 |
| `tool_start` | `{ id, name, args }` | 工具开始执行 |
| `tool_end` | `{ id, name, result, isError }` | 工具执行完成 |
| `file_ready` | `{ artifact_id, path, name?, mime_type?, size? }` | 产物可供下载（仅 `submit_artifact` 成功后） |
| `done` | `{}` | Agent 回合结束 |
| `session_closed` | `{ session_id }` | 会话连接关闭 |
| `error` | `{ message: string }` | 错误信息 |

### 会话生命周期

```
POST /sessions → CREATE → RUNNING → (TTL 30min 无活动) → EXPIRED → CLEANUP
                                                                    ↓
                               DELETE /sessions/{id} → 工作区删除
```

## 安全模型

| 层级 | 防护措施 |
|------|----------|
| **Docker** | 容器隔离，只读 root FS |
| **iptables** | 默认 DROP 出站策略，仅放行配置的端口/CIDR |
| **non-root** | 子进程以 `sandbox` 用户运行 |
| **ulimit** | CPU 300s、内存 512MB、进程数 20、文件大小 50MB |
| **Path validation** | `resolve()` + `is_relative_to()` — 防止路径逃逸；每 session 物理根隔离 |
| **Artifact-only delivery** | 仅 `submit_artifact` 向用户交付；`write` 不自动分享 |
| **Command blocking** | 禁止 `sudo`, `su`, `rm -rf /`, `dd`, `mkfs`, `fdisk`, `chmod 777` |
| **Output limits** | stdout/stderr 上限 50K chars |
| **Audit logging** | 每次执行记录 trace_id |
| **Approval** | 高风险命令需外部审批 |
| **API Key** | 仅存服务端环境变量，浏览器零接触 |

## Technology Stack

| 组件 | 技术 |
|------|------|
| Sandbox API | Python 3.11 / FastAPI |
| Persistence | SQLite (WAL) via aiosqlite |
| API Server | Node.js 20 / @earendil-works/pi-coding-agent |
| Frontend | Vite / @earendil-works/pi-web-ui |
| Agent SDK | pi-coding-agent (pi-agent-core + pi-ai) |
| MCP Adapter | Python `mcp` library |
| Container | Docker, docker compose |
| Testing | pytest, pytest-asyncio |
