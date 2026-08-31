# Architecture

## Overview

Pi Enterprise Sandbox 采用**五个进程、四份镜像**：前端、BFF、Agent、执行面
（compose 服务名仍叫 `sandbox`）以及同一镜像的 MCP facade（`sandbox-mcp`）。

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
│    DeepSeek Harness · Run API · policy · tools            │
│    agent/src/runtime = providers + policy + projection    │
│    host:4100 → container:4100                            │
├──────────────────────────────────────────────────────────┤
│              Exec Service (Node.js / TypeScript)          │
│    Internal execution plane: files · execution · process │
│    search · datasets · artifacts · resource limits       │
│    + MCP facade as a second entrypoint (same image)      │
│    MySQL 8 (sole formal DB topology, dev + prod)         │
│    container:8081 only — no host port in dev or prod     │
├──────────────────────────────────────────────────────────┤
│    Redis 7 (Agent-only runtime coordination)             │
│    Queue · Lease · Stream · cancel · Outbox wakeup       │
│    (not fact authority — MySQL + Outbox recover)         │
├──────────────────────────────────────────────────────────┤
│     Bubblewrap Isolated Workspace + Persistent /tmp       │
│    workspace_id · mount ns · --unshare-net · ulimit      │
└──────────────────────────────────────────────────────────┘
```

## 组件职责

| 组件 | 容器名 | 技术栈 | 职责 |
|------|--------|--------|------|
| **Frontend** | `pi-enterprise-frontend` | Vite + React → Nginx | 纯 UI 渲染，零 Agent 逻辑；Nginx 反向代理 `/api/*` |
| **API Server (BFF)** | `pi-enterprise-api` | Node.js 22 | 认证、会话文件边缘、Run API 与 SSE relay |
| **Agent** | `pi-enterprise-agent` | Node.js 22 + `@deepseek-ai/dsh-*` `0.1.1-rc.2` | MySQL Run/Session authority；经 `agent/src/runtime/` 组合 DSH：远程 fs/shell/jobs provider、MySQL 会话持久化、策略挂载点、SSE 投影 |
| **Sandbox（执行面）** | `pi-enterprise-sandbox` | Node.js 22 + TypeScript + Bubblewrap | Agent 专用内部执行平面（HMAC `/internal/v1/*`）+ 对 BFF 的公共会话面；命令执行、文件、搜索、数据集、产物。compose 中无 `ports:` 段——宿主不可直连，只能从 `backend_internal` 访问 |
| **Sandbox MCP** | `pi-enterprise-sandbox-mcp` | 同一镜像，入口 `dist/mcp-main.js` | 对外的 Streamable HTTP MCP 面。**只能走 `/internal/mcp/v1/*` 窄桥**，够不到内部面——这是它单独成进程的全部理由 |

> **Python 还在，但换了角色。** 服务代码全是 TypeScript；Python 3.11 只作为
> 沙箱镜像里给**模型执行代码**用的解释器与运行库（`exec/requirements.txt`），
> 挂载在 `/opt/pi-python/venv`，由 `AGENT_PYTHON_VENV` 单一事实源同时决定
> Bubblewrap 的只读挂载与子进程 `PATH`。

## 通信协议

```
Browser → Frontend → BFF (Node:4000) → Agent (Node:4100) → Exec (Node:8081)
                       │ SSE relay      │ DSH loop + LLM     │ HMAC 内部面

外部 MCP 客户端 → Sandbox MCP (Node:8082) ──窄桥──→ Exec (Node:8081)
                   只持有 SANDBOX_MCP_INTERNAL_TOKEN，只认 /internal/mcp/v1/*
```

- **Browser → Frontend**: HTTP，静态文件服务 + `/api/*` 反向代理
- **Frontend → API Server**: 反向代理（Docker 内网），无需 CORS
- **API Server → Agent**: 内部 Run API（`X-Internal-Token`），序列化 SSE 事件；Run/event 事实仅 Agent MySQL
- **Agent → Sandbox**: HMAC-authenticated internal HTTP (`/internal/v1/*`) for execution, files, processes, datasets and artifact submit; **不** dual-write Run 状态
- **Browser/BFF → Sandbox**: 浏览器不直连 Sandbox。用户可见的文件、Dataset、Artifact 操作只能经 BFF `/api/*`，并由 BFF/Agent 注入 owner context；旧 `/sessions/*` adapters 仅供兼容测试或受控开发代理，不是正式公共 API。
- **Agent → MCP**: 直连外部 MCP（不经执行面）
- **Agent → LLM**: HTTPS 直连，API Key 仅存 Agent 服务环境变量
- **Browser ← API Server**: SSE (`text/event-stream`)，事件驱动渲染
- **Artifact 下载**: 仅 `artifact_id` → control-plane snapshot；禁止 workspace path 作为交付 fallback
- **Artifact 模块**: 快照落 exec 控制面（`exec/src/artifact/`），通过
  公共面 submit/list/download/import 暴露；工作区不可改已提交产物
- **跨会话 Import**: 以 `org_id + user_id` 校验源 Artifact，将不可变 snapshot
  原子复制为目标 workspace 输入；不创建 Artifact、不发交付事件

## Key Design Decisions

Sub-Agent 以普通 Run 落地（`subagent-spawn`，见 §4c）。启用门槛与安全边界以 `plan.md` 与代码为准。

### 1. 独立 Node Agent 服务

Agent（DeepSeek Harness）运行在独立 `agent/` 服务中，而非浏览器或 BFF。收益：

- **LLM API Key 零暴露** — 仅存 Agent 服务环境变量
- **BFF / Agent / Sandbox 可独立扩缩容与回滚**
- **工具调用不可篡改** — 用户只能发文本消息，无法绕过服务端
- **Python 只是模型的执行语言之一** — 服务代码全是 TypeScript，镜像里的
  Python 解释器与运行库只供 Bubblewrap 子进程使用

### 2. 前端纯 UI，零 Agent 依赖

前端为自研 React/TypeScript SPA（Vite），通过 BFF SSE 消费事件流并自行管理 UI 状态。**不**依赖任何 Agent SDK（`@earendil-works/*` 已整仓移除，见 `tests/test_runtime_versions.py::test_no_earendil_direct_deps`）。运行时版本钉见根目录 `runtime-versions.json`。

### 3. AgentSession-owned workspace 隔离（Bubblewrap + `workspace_id`）

每个 Agent Session 独占一个稳定工作区；同一 Agent Session 的多轮 Run 复用同一 `workspace_id`：
- 公共协议只暴露 opaque **`workspace_id`**；不绑定临时 runner/PID
- 相对路径与 `/home/sandbox/workspace/...` 都指向当前 workspace；`/tmp/...` 指向同一 Agent Session 的持久化临时树
- 每次不可信进程通过 Bubblewrap 创建 mount/PID/IPC/user namespace，仅挂载当前 workspace、当前 `/tmp`、本 Session 的 XDG home 与只读 Skills
- `$HOME` 是 Bubblewrap 每次执行新建的 tmpfs，因此 `~/.config`、`~/.cache`、`~/.local/share` 显式绑定到 `<session tmp>/.home/` 下的对应目录（`XDG_*_HOME` 同步设置）。依赖用户配置目录的应用（LibreOffice 宏、插件、缓存）因此能在同一 Session 内复用配置；这些目录随 Session 私有 `/tmp` 一同计入配额并一同清理，不构成第四个存储根，也不跨租户共享
- 内部物理根仅存于 service/repository，不进入 API、SSE、模型上下文或活跃文档示例
- Skills：共享系统根在 workspace 外并始终只读；用户根按 org/user 隔离。新建只允许当前回合 ZIP attachment 或 Agent 结构化生成，所有变更走审批并由 Agent 原子落盘，Sandbox 执行侧始终只读
- 副作用执行按 `workspace_id` 串行，避免同一 Session 的并发写竞态
- Conversation 不拥有或派生 Workspace；Workspace 的保留与清理由 Agent Session 生命周期决定

`/tmp` 采用 Session 私有持久化目录而不是每次执行独立 tmpfs。该选择、配额与
清理边界见 [ADR 0004](adr/0004-session-persistent-tmp.md)。

### 4. MySQL 8 唯一正式持久化拓扑

- **dev / prod 均使用 MySQL 8**（`docker-compose.yml` + `docker-compose.prod.yml`）
- 凭据与 DSN 来自环境变量：`AGENT_DATABASE_URL`、`SANDBOX_DATABASE_URL`、`MYSQL_*`
- 所有服务启动（含 development）都拒绝 SQLite / PostgreSQL；Sandbox
  测试使用 connection-free fakes 或不可连接的 MySQL-shaped DSN，不安装
  SQLite compatibility runtime。MySQL import path 不加载旧 database/
  repository/router stack
- Agent 拥有 Knex 核心 schema migration（utf8mb4 / InnoDB）：Conversation / Message / Run 与 Sandbox 执行域表（`sandbox_sessions`、`sandbox_executions`、`sandbox_audit_events`、`process_executions`、`datasets`、`artifacts`）
- `agent_sessions.sandbox_session_id` 与 `sandbox_sessions.agent_session_id` 为逻辑索引引用（无循环外键）；租户列 `org_id`/`user_id` 由 SQL 谓词强制
- 不可变 migration + checksum；失败事务回滚；重复 init 幂等
- 需推到 Redis Stream 的持久化事件与领域状态同事务写入 `domain_outbox`（Outbox pattern）

### 4b. Redis 7 Agent-only 运行态协调拓扑

- **dev / prod 均使用 Redis 7**（`redis:7.2`；AOF + 命名 volume 默认持久协调数据）
- **Agent 独占 Redis 权威**：`AGENT_REDIS_URL` / `REDIS_URL`（仅 `redis://` / `rediss://`）、`TEST_REDIS_URL`（测试）
- BFF **不**注入 Redis 连接权威配置（PR-03 边界）。Sandbox internal plane 使用**独立** `sandbox-replay-redis` + `SANDBOX_INTERNAL_REDIS_PASSWORD`（replay jti 防重放；与 Agent `REDIS_PASSWORD` / queue/lease/stream **凭据隔离**，DB 索引不算隔离）
- 职责边界（plan §7.2 / §9）：BullMQ Run Queue（`agent-runs`）、Worker Lease（TTL 30s / 续约 10s）、Run Stream（`MAXLEN ~ 10000`）、取消信号、短期 cache/presence、Outbox wakeup
- Redis **不得**成为 Run 状态或对话事实的唯一来源
- **清空 Redis 的后果**：仅丢失运行态协调（queue job、lease、live stream 游标、短期 cache）；MySQL 中 Conversation / Run / `run_events` / 审计事实保留
- **恢复路径**：Outbox publisher 从 `domain_outbox` 重试未发布事件；SSE/历史从 MySQL `run_events` 重放；Worker 按 MySQL Run 状态 + 幂等记录决定重试或失败
- 生产：`REDIS_PASSWORD` 必填（compose fail-fast）；禁止无密码生产 Redis

### 4c. 企业工具面与策略挂载

Pi 的 first-party Extension 包（`agent/src/extensions/`）已随 ADR 0007 删除。
`REQUIRED_EXTENSION_NAMES` / `REGISTERED_EXTENSION_NAMES` 现在是空名单
（`agent/src/infrastructure/dsh/constants.ts`），只留给 diagnostics 投影兼容
BFF `/api/extensions/diagnostics` 的字段形状。能力本身还在，挂载点换了：

| 能力 | 现在在哪 | 角色 |
|------|----------|------|
| 工作区工具（原 `sandbox-bridge`） | DSH remote provider：`ctx.fs` / `ctx.shell` / `ctx.jobs` | 注册 `SANDBOX_TOOL_NAMES` 的 13 个工具，全部 RPC 到 exec internal plane |
| 企业策略（原 `enterprise-policy`） | `agent/src/runtime/policy/` 四个挂载点 | 纯拦截器；对每次 tool_call 给出 allow / require_approval / deny |
| 可观测性（原 `observability`） | 账本 + OTel：`fenced-tool-governance-recorder` 等 | 记录工具结果与审计事件 |
| 用户提问（原 `user-interaction`） | application `interaction-response-service` + 策略面 | 注册 `ask_user`。名字不叫 `interaction`，因为那是必须持续拒绝的 legacy 包名 |

可选能力仍要求容器注入对应的持久化端口——端口缺失时装配期直接报错，而不是
让模型在第一次调用时才拿到一个永远失败的工具。

装载规则：AgentVersion **显式列出** extensions 时，那份列表仍是 diagnostics
与 AgentVersion 校验的权威投影。列表为空时（`defaultAgentConfigJson()` 的默认
形态），`skill-lifecycle` 与 `task-state` 在各自依赖就绪的前提下自动装载；
`subagent-spawn` 仍需显式列出。

| Extension | 角色 | 必需依赖 |
|-----------|------|----------|
| `skill-lifecycle` | 用户态 Skill 的安装、Agent 生成、编辑与卸载 | 可写的 per-user Skill 根 |
| `subagent-spawn` | `spawn_subagent` / `check_subagent`：创建并轮询子 Run | `subagentSpawnPort`（MySQL + Run Queue） |
| `task-state` | `todo_write` / `todo_read` / `memory_write` / `memory_search` | `taskStateStore`（`task_todos` / `task_memories`）；**依赖就绪时默认装载** |

新增可选 Extension 必须同时为它注册的每个工具补 tool-risk-classifier 条目，否则
这些工具会以 `UNKNOWN_TOOL_DENIED` 被拒（有守卫测试）。

#### 子 Run（sub-agent）

子 Run 就是普通 Run：同一张 `runs` 表、同一个 `agent-runs` 队列、同一套 worker
与恢复路径，只是多了血缘字段 `source='subagent'` / `parent_run_id` /
`subagent_depth`（migration `20260822000001`）。三条硬约束：

- **子 Run 有自己的 Conversation 与 AgentSession**。父 Run 在整个生命周期内持有其
  AgentSession 的执行 fence 与 Redis 锁，共用会话的子 Run 永远拿不到锁——它会一直
  排队等一个正在等它的父 Run。AgentVersion 仍然继承父 Run 的版本。
- **一次 tool call 只产生一个子 Run**。`toolCallId` 就是幂等键，重试认领已建
  的子 Run。
- **深度与并发在事务内复查**。父行加锁后再数存活兄弟，两个并发 spawn 不会同时读到
  "还剩一个名额"。默认 `maxDepth=2`、`maxConcurrent=5`，可由
  `AGENT_SUBAGENT_MAX_DEPTH` / `AGENT_SUBAGENT_MAX_CONCURRENT` 收紧，也可由
  AgentVersion 的 `configJson.subagent` 按租户收紧（只能更严，不能更松）。

子 Run 沿用父 Run 的 `trace_id`，并把 `trace_parent_span_id` 指向父 Run 的 run
span，所以一次 fan-out 在链路上是一棵树而不是 N 个孤立的 root。

取消会级联：取消父 Run 时，沿 `parent_run_id` 深度有界地为每个存活后代写入持久
cancel intent 并发信号。**只写 intent**——`execute-run-service` 在进入 runtime 前
和每步前后都检查它（MySQL 权威，Redis 加速），所以排队中的子 Run 被捡起时就地终
止，运行中的子 Run 走它本来就有的取消路径。已终态的父 Run 也会回收存活子 Run。父
行的 `FOR UPDATE` 让"取消"与"创建子 Run"串行：取消先提交则新的 spawn 被拒
（`SUBAGENT_PARENT_NOT_RUNNABLE`），spawn 先提交则级联能看到这个新子 Run。

子 Run **不注册 `ask_user`**：它的对话不在会话列表里，也没有任何路径把它的提问送到
人面前，停泊在 WAITING_INPUT 就是永久卡死。停泊 Run 的取消回收也已对齐——
WAITING_INPUT 与 WAITING_APPROVAL 现在共用 `run-recovery-parked-cancel.ts`，此前只
有后者会响应 cancel intent。

子 Run 的 Conversation 带 `parent_run_id`（migration `20260822000003`），
`listForOwner` 默认过滤掉它们，但 `getById` 不过滤——列表里看不到，按 id 仍然读得
到 transcript。

`LEGACY_REQUIRED_EXTENSION_NAMES`（三个，不含 `user-interaction`）仅用于兼容
`user-interaction` 拆分之前的配置：给出这三个即隐含启用 `user-interaction`，
`ask_user` 不会静默消失。

### 5. 审批工作流（外部副作用）

Workspace 内的 `read`、`write`、`edit`、`bash`、Python、Node、文件删除和长进程默认不审批；安全边界由隔离、路径、资源、网络和审计策略保证。审批只用于数据库写入、生产变更、消息发送、外部资源删除、部署、敏感凭证及其他高风险企业 Tool。

### 6. Trace ID 全链路

每个跨服务请求携带 W3C `traceparent`（可选 `tracestate`）；BFF 仅为
兼容旧调用方回显 `X-Trace-Id`：
- 解析合法的 32-hex non-zero trace id，并为下游创建新的 span id
- 审计日志关联
- 可查询单个 Run 的 owner-scoped durable trace：`GET /api/runs/{run_id}/trace`
- 事件行是账本；span 投影挂在同一 append 事务里，用 `SELECT … FOR UPDATE` 读 Run 根 span。投影 CAS 耗尽时提交事件、不把成功的 Agent 循环写成 `FAILED`；`GET /trace` 会从事件重建 span。

### 7. 非 Root 执行

所有子进程以 `sandbox` 用户运行（UID != 0），配合 ulimit 资源控制，防止容器逃逸和资源耗尽。

## Main Data Flows

### 一次完整对话

```
1. 用户输入 → Browser 发送 `POST /api/runs`，取得 canonical `run_id`
2. Frontend Nginx 反向代理到 api-server:4000
3. Browser 通过 `GET /api/runs/:id/events` 消费 BFF relay 的序列化 SSE（BFF 不 import 任何 Agent SDK）
4. Agent：
   a. 创建或复用 conversation + Agent Session，并恢复其 sandbox session（`workspace_id`）
   b. 经 `agent/src/runtime/` 组合 DSH 会话（基础 tools、model、auth；per-Run scope 承载工具视图/guard/skill 层；profile skill 策略）。进程启动时已对每个启用 MCP 执行 `tools/list`（`pi-mcp-adapter`，DSH 自身没有 MCP transport），并将工具注册为 `mcp__{serverId}__{toolName}`；MCP 配置变更须重启 Agent。
   c. 绑定策略挂载点后以 DSH active tools + 启用集 skills + MCP 注入结果做权威 reconcile，并发布 diagnostics 可消费的 live snapshot
   d. 调用 session.prompt(text)；清单/数量类问题须经 `capabilities` 工具（list/search/describe）
   e. Agent 循环：
      - LLM text_delta → SSE: {type:"token", text:"..."}
      - Sandbox-backed 或已发现的 MCP 工具调用 → 对应执行平面 → SSE: tool_start/tool_end
      - write/edit 成功 → 仅私有工作区变更，**不**发 file_ready
      - submit_artifact 成功 → Artifact API + SSE: {type:"file_ready", artifact_id, path, name, mime_type, size}
   f. SSE: {type:"done"} — 无自动 workspace 扫描
5. Browser 消费 SSE 流；交付物用 artifact_id 下载（`/api/files/artifact-download`）
```

### SSE 事件协议

| 事件类型 | 字段 | 说明 |
|----------|------|------|
| `session` | `{ session_id, workspace_id, conversation_id? }` | Sandbox 会话已创建；跨轮次文件由 Agent Session 的 `workspace_id` 持久化 |
| `token` | `{ text: string }` | LLM 文本增量 |
| `tool_start` | `{ id, name, args }` | 工具开始执行 |
| `tool_end` | `{ id, name, result, isError }` | 工具执行完成 |
| `file_ready` | `{ artifact_id, path, name?, mime_type?, size? }` | 产物可供下载（仅 `submit_artifact` 成功后） |
| `done` | `{}` | Agent 回合结束 |
| `session_closed` | `{ session_id }` | 会话连接关闭 |
| `error` | `{ message: string }` | 错误信息 |
| `capability_registry_updated` | `{ reason, registry_version, counts?, run_id? }` | Session capability registry 变更（有界、无密钥） |

### 会话生命周期

```
Conversation
  → 一个活跃 Agent Session（绑定一个 Sandbox Session + Workspace）
  → 多个 Run（每条用户消息一个）
  → Agent Session 关闭/保留策略触发时清理其 Workspace 与私有 /tmp

`POST /api/sessions/ensure` 只用于上传前确保绑定；它不创建新的 Run。
Sandbox Session 不保存 Agent 对话，不能用 Sandbox 的会话 TTL 代替
Agent Session 生命周期。
```

## 安全模型

| 层级 | 防护措施 |
|------|----------|
| **Docker** | 容器隔离；`backend_internal`（internal）与 `service_egress`；Sandbox 无 NET_ADMIN/NET_RAW |
| **执行网络** | 生产 `network_mode=disabled` + Bubblewrap `--unshare-net`；无 per-child egress proxy 时禁止 allowlist 伪装隔离 |
| **入站 HTTP** | `SANDBOX_ALLOWED_CLIENT_CIDRS`（与出站执行策略分离） |
| **non-root** | Sandbox 子进程以 `sandbox` 用户运行；api-server 与 agent 容器自 2026-08-23 起以基础镜像 `node` 用户运行（存量 `agent_user_skills` 卷需 chown 一次） |
| **BFF 出站边界** | 所有 BFF→Agent/Sandbox 调用受超时约束（`AGENT_REQUEST_TIMEOUT_MS` / `SANDBOX_REQUEST_TIMEOUT_MS`，默认 15s；SSE 长连接除外），挂起的依赖不会钉死浏览器请求与 socket |
| **ulimit** | CPU 300s、内存 512MB、进程数 20、文件大小 50MB |
| **Path validation** | `resolve()` + `is_relative_to()` — 防止路径逃逸；每 session 物理根隔离 |
| **Artifact-only delivery** | 仅 `submit_artifact` 向用户交付；`write` 不自动分享 |
| **Command blocking** | 禁止 `sudo`, `su`, `rm -rf /`, `dd`, `mkfs`, `fdisk`, `chmod 777`（hard_deny） |
| **Output limits** | stdout/stderr 上限 50K chars |
| **Audit logging** | 每次执行记录 trace_id |
| **Approval** | 外部副作用 Tool 由 Agent durable policy/approval ledger 控制；普通 Sandbox bash/python/node 不审批 |
| **Internal auth** | Agent→Sandbox 使用短期 HMAC claim + body digest + replay jti；密钥仅在服务端，浏览器零接触。Agent 自身 `/internal/*` 面由 `AGENT_INTERNAL_TOKEN` 保护（常量时间比较），token 缺失即 fail-closed 关闭平面 |
| **DSH 策略挂载** | Agent 侧统一 `tool_call` 策略入口（`runtime/policy`）；异常 fail-closed |
| **Run 收敛保护** | 每个 Run 限制模型回合、总工具调用和重复的工具/参数调用；到达任一上限后移除工具并要求模型根据已有结果完成回答 |

### 双重强制（Agent Extension + Sandbox）

安全策略在两层独立执行，**Sandbox 不信任 Extension 结论**：

```text
Agent Host + `agent/src/runtime/`（DSH 的四个既有挂载点，不建平行体系）
  tools/pre-execute      → 风险表、参数守卫、source_digest、持久 PENDING 审批
  ctx.tools.guard()      → 租户与 fence 的单调兜底；拒绝后监听器无法翻案
  tools/execute（环绕）  → 每 Run 工具数、轮次、deadline
  tools/post-execute     → 脱敏、账本、上下文附加
  远程 provider          → ctx.fs / ctx.shell / ctx.jobs 全部指向 exec，
                           agent 进程内零本机文件与进程操作
  durable MySQL ledger   → 外部副作用审批、审计、resume
        │
        ▼
Exec internal plane (TypeScript)
  HMAC claim/scope/body digest           → 调用身份 fail-closed
  /internal/v1/* hard deny               → 危险命令不进入审批
  path / ownership / isolation           → 路径、租户与执行资源独立校验
  Bubblewrap                             → **唯一的安全边界**（ADR 0007 D11）
```

**Exec 不信任 Agent 侧的策略结论**：上面两层是独立的，agent 侧策略被绕过也不等于
执行面放行。

| 策略结果 | `APPROVAL_MODE=ask` | `APPROVAL_MODE=deny` | `APPROVAL_MODE=auto_approve` |
|----------|----------------------|-----------------------|-----------------------------------|
| `allow` | 直接执行 | 直接执行 | 直接执行 |
| `require_approval` | 暂停等人审 | **明确拒绝，不创建审批** | 执行 + bypass 审计 |
| `hard_deny` | 拒绝 | **仍拒绝** | **仍拒绝** |

- 读工具（`read`/`ls`/`find`/`grep`）可并行；Workspace 写操作按 Agent Session/workspace 串行。是否审批取决于外部副作用策略，而不是 `bash` 这一工具名。
- **Skill 树只能通过声明的入口脚本执行**：`bash` / `process_start` 的命令一旦提到任何 Skill 路径，
  必须整条是 `python|python3 <skill>/<package>/scripts/<file>.py [args]` 或
  `bash|sh …/scripts/<file>.sh [args]`，否则 `SKILL_SCRIPT_COMMAND_DENIED`。脚本必须落在该
  package 的 `scripts/` 下，**允许再套子目录**（首方包本来就这么发，例如
  `xlsx/scripts/office/pack.py`）；路径里含 `..` 一律拒绝。命令里不允许出现 shell 操作符或
  glob，因此 `cd … && …`、管道、重定向、`$(...)`、`python -m`、换用别的解释器、以及用 `cat`
  读 Skill 文件都会被拒——读文件用 `read` 工具，需要更复杂的命令先把脚本复制到 workspace。
  这条规则同时写进 system prompt 的 Skills 段，模型不必靠撞墙去发现它。
- **Enterprise system prompt** 由 `agent/src/runtime/prompt/enterprise-clauses.ts`
  装配进 DSH：身份可被 AgentVersion / `AGENT_SYSTEM_PROMPT` lead 整段替换，路径 /
  Skill 入口 / 工具契约 / `## Doing work` 不可被替换。`## Tools` 正文按本 run
  绑定的工具现场拼接（各工具自己的 `promptSnippet` / `promptGuidelines`），基座
  不写死工具清单。`## Doing work` 只写工具无关的工作纪律（本轮做完并验证、不擅自
  改范围、进度写在用户可见回复、密钥不进回复、有交付工具就走交付工具）；todo /
  memory / `ask_user` / 子代理 / artifact 的用法只出现在对应工具被绑定后的
  guideline 里，避免没装该能力的 run 读到幽灵工具。`AGENT_SYSTEM_PROMPT` 只替换
  身份 lead，不再另拼一层「平台安全」附录。
- 策略版本常量 `POLICY_VERSION`（当前 `2026-07-15.1`）写入审批响应与审计 meta，便于追溯。
- `SANDBOX_POLICY_PROFILE=strict|balanced` 在 Agent 与 Sandbox 对称生效；`balanced` 仅在 required Bubblewrap 已通过配置校验时激活，并只放行常见包管理命令的审批前置门。`SANDBOX_NETWORK_MODE` 仍是网络权限唯一事实源，生产固定 `strict`。
- approval key 由 durable `run_id`、Sandbox session、工具名、稳定 SDK
  `tool_call_id` 和规范化参数生成；pending/approved/rejected 与 operation
  fingerprint 由 Agent MySQL ledger 原子维护。resume 只授权完全相同的
  外部副作用操作，不把一次批准扩展成 Sandbox 通用执行权限。
- 实现：`agent/src/runtime/policy/`、`agent/src/runtime/providers/remote-*.ts`、
  `agent/src/infrastructure/mysql/repositories/approval-repository.ts`、
  `exec/src/security/hmac.ts`、`exec/src/shell/blocked-commands.ts`。

## Technology Stack

| 组件 | 技术 |
|------|------|
| Exec / Sandbox | **Node.js 22 / TypeScript** + Bubblewrap；镜像内另带 Python 3.11 venv 供模型执行代码 |
| Persistence | **MySQL 8**（dev/prod 唯一正式拓扑；`AGENT_DATABASE_URL` / `EXEC_DATABASE_URL`）；Agent Knex migrations + exec 自有 `exec_*` 表 |
| Runtime coordination | **Redis 7**（Agent-only；`AGENT_REDIS_URL` / `REDIS_URL`；queue/lease/stream；非事实权威） |
| API Server (BFF) | **Node.js 22** — 薄 BFF，不托管 Agent SDK |
| Frontend | Vite + React 19 + TypeScript SPA（`frontend/src/*.tsx`/`*.ts`），构建镜像 Node 22 |
| Agent Harness | 独立 Node 22 服务（`@deepseek-ai/dsh-*` `0.1.1-rc.2`，逐包 exact pin） |
| MCP | 对外 facade 用 `@modelcontextprotocol/sdk`（exec 的第二入口）；Agent 侧的外部 MCP 接入见 `docs/sandbox-mcp.md` |
| Container | Docker, docker compose |
| Testing | `node:test`（exec / contract / agent / api-server / frontend）；pytest 只做仓库卫生（结构棘轮、版本钉、compose 安全、SSE 夹具）；无密钥 cross-service smoke；CI 见 `.github/workflows/test.yml` |

## 健康检查语义

| 端点 | 语义 | 失败 |
|------|------|------|
| `GET /health` | 进程存活（liveness） | 无响应 |
| `GET /ready` | 工作区可写 + DB 可 ping（readiness） | **HTTP 503** `status=not_ready` |
| `GET /health/live` | API Server BFF 进程存活 | 非 200 |
| `GET /health/ready` | BFF、Agent、Sandbox 均可用 | 503 |

探针响应不包含密钥、连接串或环境 dump。
