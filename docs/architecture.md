# Architecture

## Overview

Pi Enterprise Sandbox 采用**四服务架构**，前端、BFF、Agent 与沙箱执行环境各自独立容器部署。

```
┌──────────────────────────────────────────────────────────┐
│                   Frontend (Nginx)                        │
│    静态 SPA (Vite build) · /api/* 反向代理                │
│    host:3000 → container:80                              │
├──────────────────────────────────────────────────────────┤
│              API Server / BFF (Node.js)                   │
│    Auth · Conversations · Files · SSE relay               │
│    host:4000 → container:4000                            │
├──────────────────────────────────────────────────────────┤
│              Agent Service (Node.js)                      │
│    pi-coding-agent SDK · Run API · Extensions · Tools     │
│    host:4100 → container:4100                            │
├──────────────────────────────────────────────────────────┤
│              Sandbox Service (FastAPI)                     │
│    Session · Execution · File · Approval · Artifact      │
│    Audit Logging · Resource Limits · MCP Export          │
│    PostgreSQL (prod) / empty SQLite (dev·test)           │
│    host:8083 → container:8081 · MCP host:8093 → 8091     │
├──────────────────────────────────────────────────────────┤
│     Bubblewrap Isolated Workspace + Persistent /tmp       │
│    workspace_id · mount namespaces · iptables · ulimit   │
└──────────────────────────────────────────────────────────┘
```

## 组件职责

| 组件 | 容器名 | 技术栈 | 职责 |
|------|--------|--------|------|
| **Frontend** | `pi-enterprise-frontend` | Vite + pi-web-ui → Nginx | 纯 UI 渲染，零 Agent 逻辑；Nginx 反向代理 `/api/*` |
| **API Server (BFF)** | `pi-enterprise-api` | Node.js | 认证、会话/会话文件边缘、`POST /api/chat` SSE relay |
| **Agent** | `pi-enterprise-agent` | Node.js + pi-coding-agent SDK | Run 编排、模型、Skill、Extension、sandbox tools |
| **Sandbox** | `pi-enterprise-sandbox` | Python 3.11 + FastAPI | 安全命令执行、文件读写、产物管理、审批工作流（无 Agent 主循环） |

## 通信协议

```
Browser → Frontend → BFF (Node:4000) → Agent (Node:4100) → Sandbox (FastAPI:8081)
                       │ SSE relay      │ SDK loop + LLM     │ REST 执行点
```

- **Browser → Frontend**: HTTP，静态文件服务 + `/api/*` 反向代理
- **Frontend → API Server**: 反向代理（Docker 内网），无需 CORS
- **API Server → Agent**: 内部 Run API（`X-Internal-Token`），序列化 SSE 事件
- **Agent → Sandbox**: HTTP REST，Docker 内网直连。可选 `X-API-Key` 认证
- **Agent → LLM**: HTTPS 直连，API Key 仅存 Agent 服务环境变量
- **Browser ← API Server**: SSE (`text/event-stream`)，事件驱动渲染

## Key Design Decisions

### 1. 独立 Node Agent 服务

Agent（`pi-coding-agent` SDK）运行在独立 `agent/` 服务中，而非浏览器或 BFF。收益：

- **LLM API Key 零暴露** — 仅存 Agent 服务环境变量
- **BFF / Agent / Sandbox 可独立扩缩容与回滚**
- **工具调用不可篡改** — 用户只能发文本消息，无法绕过服务端
- **Python 仅作 Sandbox 执行语言** — 无 Python Agent 主循环

### 2. 前端纯 UI，零 Agent 依赖

前端仅使用 `@earendil-works/pi-web-ui` 的 UI 组件（MessageList / MessageEditor / StreamingMessageContainer），不 import `pi-agent-core`、`pi-ai`。前端通过 SSE 消费事件流直接渲染，自己管理简单状态。

### 3. Conversation-owned workspace 隔离（Bubblewrap + `workspace_id`）

每个 Conversation 默认绑定一个稳定工作区；重建 Agent/Sandbox Session 时复用同一 `workspace_id`：
- 公共协议只暴露 opaque **`workspace_id`**；不绑定临时 runner/PID
- 相对路径与 `/home/sandbox/workspace/...` 都指向当前 workspace；`/tmp/...` 指向同一 Conversation 的持久化临时树
- 每次不可信进程通过 Bubblewrap 创建 mount/PID/IPC/user namespace，仅挂载当前 workspace、当前 `/tmp` 与只读 Skills
- 内部物理根仅存于 service/repository，不进入 API、SSE、模型上下文或活跃文档示例
- Skills：共享 skill 根在 workspace 外；Agent 的 `read/load` 保持可用。`SKILLS_MODE=development` 时仅 Agent 侧 `skill_install` / `skill_edit` / `skill_reload` 可写，Sandbox 执行侧始终只读
- 副作用执行按 `workspace_id` 串行，避免 Session 重建后的并发写竞态
- Session TTL 只回收执行 Session；Conversation 删除时才清理其 workspace 与 `tmp_{workspace_id}`

### 4. PostgreSQL 生产 + 空库 SQLite 开发

- **生产强制 PostgreSQL**（`docker-compose.prod.yml` + `schema_migrations` 校验）
- **开发/测试**可从空 SQLite 初始化；不提供旧 schema 自动 ALTER/回填
- 不可变 migration + checksum；失败事务回滚；重复 init 幂等

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
3. API Server（BFF）创建 Agent run 并 relay 序列化 SSE（不 import pi-coding-agent）
4. Agent：
   a. 创建或复用 conversation + sandbox session（`workspace_id`）
   b. 初始化 pi-coding-agent session（基础 tools、model、auth；零内置 Skill）
   c. 调用 session.prompt(text)
   d. Agent 循环：
      - LLM text_delta → SSE: {type:"token", text:"..."}
      - 工具调用 → Sandbox API → SSE: tool_start/tool_end
      - write/edit 成功 → 仅私有工作区变更，**不**发 file_ready
      - submit_artifact 成功 → Artifact API + SSE: {type:"file_ready", artifact_id, path, name, mime_type, size}
   e. SSE: {type:"done"} — 无自动 workspace 扫描
5. Browser 消费 SSE 流；交付物用 artifact_id 下载（`/api/files/artifact-download`）
```

### SSE 事件协议

| 事件类型 | 字段 | 说明 |
|----------|------|------|
| `session` | `{ session_id, workspace_id, conversation_id? }` | Sandbox 会话已创建（`conversation_id` 用于跨轮次文件持久化） |
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
| **Command blocking** | 禁止 `sudo`, `su`, `rm -rf /`, `dd`, `mkfs`, `fdisk`, `chmod 777`（hard_deny） |
| **Output limits** | stdout/stderr 上限 50K chars |
| **Audit logging** | 每次执行记录 trace_id |
| **Approval** | 高风险命令需外部审批（`APPROVAL_ENABLED`，默认 true） |
| **API Key** | 仅存服务端环境变量，浏览器零接触 |
| **SDK Extension** | Agent 侧统一 `tool_call` 策略入口；异常 fail-closed |

### 双重强制（Agent Extension + Sandbox）

安全策略在两层独立执行，**Sandbox 不信任 Extension 结论**：

```text
Agent (api-server)
  Extension tool_call  → 三层策略 allow | approval_required | hard_deny
  createSandboxTools   → 写工具串行互斥、审批轮询、fail-closed
        │
        ▼
Sandbox (FastAPI)
  approval-check       → 重复策略评估；hard_deny 永不进审批队列
  /executions/command  → 再次 hard_deny；无 session 不可执行
  path / ownership     → 路径与归属校验
```

| 策略结果 | `APPROVAL_ENABLED=true` | `APPROVAL_ENABLED=false` |
|----------|-------------------------|---------------------------|
| `allow` | 直接执行 | 直接执行 |
| `approval_required` | 暂停等人审 | 执行 + bypass 审计 |
| `hard_deny` | 拒绝 | **仍拒绝**（开关与 approval credential 不可覆盖） |

- 读工具（`read`/`ls`/`find`/`grep`…）可并行；写/副作用工具（`write`/`edit`/`bash`/`submit_artifact`/未知）按 conversation/workspace 串行。
- 策略版本常量 `POLICY_VERSION`（当前 `2026-07-11.1`）写入审批响应与审计 meta，便于追溯。
- 实现：`agent/extensions/sandbox-security.js`、`sandbox/services/policy_checker.py`。

## Technology Stack

| 组件 | 技术 |
|------|------|
| Sandbox API | Python 3.11 / FastAPI |
| Persistence | PostgreSQL（生产）；空库 SQLite（开发/测试）；`schema_migrations` |
| API Server (BFF) | **Node.js 22** — 薄 BFF，不托管 Agent SDK |
| Frontend | Vite 构建的 Vanilla JS SPA（`frontend/src/*.js`），构建镜像 Node 22 |
| Agent SDK | 独立 Node 22 服务（`@earendil-works/pi-coding-agent` 精确锁定） |
| MCP Adapter | Python `mcp` library |
| Container | Docker, docker compose |
| Testing | pytest；`node:test`（api-server + agent + frontend）；无密钥 cross-service smoke；CI 见 `.github/workflows/test.yml` |

## 健康检查语义

| 端点 | 语义 | 失败 |
|------|------|------|
| `GET /health` | 进程存活（liveness） | 无响应 |
| `GET /ready` | 工作区可写 + DB 可 ping（readiness） | **HTTP 503** `status=not_ready` |
| `GET /api/status` | API Server BFF 存活；含 `agent_runtime` | 非 200 |

探针响应不包含密钥、连接串或环境 dump。
