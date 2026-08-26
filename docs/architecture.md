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
│    Internal execution plane: files · execution · process │
│    datasets · artifacts · resource limits                │
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
| **Agent** | `pi-enterprise-agent` | Node.js 22 + pi-coding-agent SDK `0.80.3` | MySQL Run/Session authority、Pi Runtime、四个必需 Extension + 一个可选、`pi-mcp-adapter` |
| **Sandbox** | `pi-enterprise-sandbox` | Python 3.11 + FastAPI | Agent 专用内部执行平面（HMAC `/internal/v1/*`）；安全命令执行、文件读写、产物管理（无 Agent 主循环）。compose 中无 `ports:` 段——宿主不可直连，只能从 `backend_internal` 访问 |

## 通信协议

```
Browser → Frontend → BFF (Node:4000) → Agent (Node:4100) → Sandbox (FastAPI:8081)
                       │ SSE relay      │ SDK loop + LLM     │ REST 执行点
```

- **Browser → Frontend**: HTTP，静态文件服务 + `/api/*` 反向代理
- **Frontend → API Server**: 反向代理（Docker 内网），无需 CORS
- **API Server → Agent**: 内部 Run API（`X-Internal-Token`），序列化 SSE 事件；Run/event 事实仅 Agent MySQL
- **Agent → Sandbox**: HMAC-authenticated internal HTTP (`/internal/v1/*`) for execution, files, processes, datasets and artifact submit; **不** dual-write Run 状态
- **Browser/BFF → Sandbox**: 浏览器不直连 Sandbox。用户可见的文件、Dataset、Artifact 操作只能经 BFF `/api/*`，并由 BFF/Agent 注入 owner context；旧 `/sessions/*` adapters 仅供兼容测试或受控开发代理，不是正式公共 API。
- **Agent → MCP**: `pi-mcp-adapter` 直连外部 MCP（不经 Sandbox）
- **Agent → LLM**: HTTPS 直连，API Key 仅存 Agent 服务环境变量
- **Browser ← API Server**: SSE (`text/event-stream`)，事件驱动渲染
- **Artifact 下载**: 仅 `artifact_id` → control-plane snapshot；禁止 workspace path 作为交付 fallback
- **Artifact 模块**: Sandbox 内由 `sandbox/artifact/` 聚合，通过
  `ArtifactFacade` 暴露 submit/list/download/import；旧 service/router 路径仅兼容
- **跨会话 Import**: 以 `org_id + user_id` 校验源 Artifact，将不可变 snapshot
  原子复制为目标 workspace 输入；不创建 Artifact、不发交付事件

## Key Design Decisions

Sub-Agent 暂不进入运行时。启用门槛与安全边界以 `plan.md` 与代码为准（当前无 Sub-Agent 运行时路径）。

### 1. 独立 Node Agent 服务

Agent（`pi-coding-agent` SDK）运行在独立 `agent/` 服务中，而非浏览器或 BFF。收益：

- **LLM API Key 零暴露** — 仅存 Agent 服务环境变量
- **BFF / Agent / Sandbox 可独立扩缩容与回滚**
- **工具调用不可篡改** — 用户只能发文本消息，无法绕过服务端
- **Python 仅作 Sandbox 执行语言** — 无 Python Agent 主循环

### 2. 前端纯 UI，零 Agent 依赖

前端为自研 React/TypeScript SPA（Vite），通过 BFF SSE 消费事件流并自行管理 UI 状态。**不**依赖 `@earendil-works/pi-coding-agent` / `pi-ai` / `pi-web-ui`（后者已从 `frontend/package.json` 移除：静态搜索确认无 import）。运行时版本钉见根目录 `runtime-versions.json`。

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

### 4c. 第一方 Extension 名单

`REQUIRED_EXTENSION_NAMES` 是**四个**（`agent/src/extensions/constants.js`）：

| Extension | 角色 |
|-----------|------|
| `sandbox-bridge` | 注册 `SANDBOX_TOOL_NAMES` 的 13 个工具，全部路由到 Sandbox internal plane |
| `enterprise-policy` | 纯拦截器；不注册任何工具，对每次 `tool_call` 给出 allow / require_approval / deny |
| `observability` | 记录工具结果与审计事件 |
| `user-interaction` | 注册 `ask_user`。名字不叫 `interaction`，因为那是 registry 必须持续拒绝的 legacy enterprise-agent-kit 包名 |

`OPTIONAL_EXTENSION_NAMES` 有三个，都要求容器注入对应的持久化端口——端口缺失时
bundle 在装配期直接报错，而不是让模型在第一次调用时才拿到一个永远失败的工具。

装载规则：AgentVersion **显式列出** extensions 时，那份列表是权威的（
`pi-runtime-factory` 会按列表逐一校验 factory，静默追加会把一个合法 AgentVersion
变成 `PI_EXTENSIONS_COUNT` 错误）。列表为空时（`defaultAgentConfigJson()` 的默认
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
- **一次 tool call 只产生一个子 Run**。Pi 的 `toolCallId` 就是幂等键，重试认领已建
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
WAITING_INPUT 与 WAITING_APPROVAL 现在共用 `run-recovery-parked-cancel.js`，此前只
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
3. Browser 通过 `GET /api/runs/:id/events` 消费 BFF relay 的序列化 SSE（BFF 不 import pi-coding-agent）
4. Agent：
   a. 创建或复用 conversation + Agent Session，并恢复其 sandbox session（`workspace_id`）
   b. 初始化 pi-coding-agent session（基础 tools、model、auth；session-scoped capability registry；profile skill 策略）。进程启动时已对每个启用 MCP 执行 `tools/list`，并将工具注册为 `mcp__{serverId}__{toolName}`；MCP 配置变更须重启 Agent。
   c. 绑定 Extensions 后以 Pi active tools + resourceLoader skills + MCP 注入结果做权威 reconcile，并发布 diagnostics 可消费的 live snapshot
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
| **SDK Extension** | Agent 侧统一 `tool_call` 策略入口；异常 fail-closed |
| **Run 收敛保护** | 每个 Run 限制模型回合、总工具调用和重复的工具/参数调用；到达任一上限后移除工具并要求模型根据已有结果完成回答 |

### 双重强制（Agent Extension + Sandbox）

安全策略在两层独立执行，**Sandbox 不信任 Extension 结论**：

```text
Agent Host + first-party Extensions
  sandbox-bridge         → 注册 13 个工具；owner/run/session 绑定、写工具串行互斥
  enterprise-policy      → 拦截每次 tool_call：allow | require_approval | deny
  observability          → 记录工具结果与审计事件
  user-interaction       → 注册 ask_user（必需；由 interaction 这个 legacy 包名改名而来）
  skill-lifecycle        → 可选，用户态 Skill 安装/生成/编辑/卸载
  subagent-spawn         → 可选，创建/轮询子 Run（同队列、同 worker、同恢复路径）
  task-state             → 默认装载（store 就绪时），会话 todo 列表 + owner 级长期备忘
  durable MySQL ledger   → 外部副作用审批、审计、resume
        │
        ▼
Sandbox internal plane (FastAPI)
  HMAC claim/scope/body digest/replay jti → 调用身份 fail-closed
  /internal/v1/* hard deny               → 危险命令不进入审批
  path / ownership / isolation           → 路径、租户与执行资源独立校验
```

| 策略结果 | `APPROVAL_MODE=ask` | `APPROVAL_MODE=deny` | `APPROVAL_MODE=auto_approve` |
|----------|----------------------|-----------------------|-----------------------------------|
| `allow` | 直接执行 | 直接执行 | 直接执行 |
| `require_approval` | 暂停等人审 | **明确拒绝，不创建审批** | 执行 + bypass 审计 |
| `hard_deny` | 拒绝 | **仍拒绝** | **仍拒绝** |

- 读工具（`read`/`ls`/`find`/`grep`）可并行；Workspace 写操作按 Agent Session/workspace 串行。是否审批取决于外部副作用策略，而不是 `bash` 这一工具名。
- 策略版本常量 `POLICY_VERSION`（当前 `2026-07-15.1`）写入审批响应与审计 meta，便于追溯。
- `SANDBOX_POLICY_PROFILE=strict|balanced` 在 Agent 与 Sandbox 对称生效；`balanced` 仅在 required Bubblewrap 已通过配置校验时激活，并只放行常见包管理命令的审批前置门。`SANDBOX_NETWORK_MODE` 仍是网络权限唯一事实源，生产固定 `strict`。
- approval key 由 durable `run_id`、Sandbox session、工具名、稳定 SDK
  `tool_call_id` 和规范化参数生成；pending/approved/rejected 与 operation
  fingerprint 由 Agent MySQL ledger 原子维护。resume 只授权完全相同的
  外部副作用操作，不把一次批准扩展成 Sandbox 通用执行权限。
- 实现：`agent/src/extensions/enterprise-policy/`、`agent/src/extensions/sandbox-bridge/`、
  `agent/src/infrastructure/mysql/repositories/approval-repository.js`、
  `sandbox/security/internal_http_auth.py`、`sandbox/services/policy_checker.py`。

## Technology Stack

| 组件 | 技术 |
|------|------|
| Sandbox API | Python 3.11 / FastAPI |
| Persistence | **MySQL 8**（dev/prod 唯一正式拓扑；`AGENT_DATABASE_URL` / `SANDBOX_DATABASE_URL`）；Agent Knex migrations + Sandbox PyMySQL repos |
| Runtime coordination | **Redis 7**（Agent-only；`AGENT_REDIS_URL` / `REDIS_URL`；queue/lease/stream；非事实权威） |
| API Server (BFF) | **Node.js 22** — 薄 BFF，不托管 Agent SDK |
| Frontend | Vite + React 19 + TypeScript SPA（`frontend/src/*.tsx`/`*.ts`），构建镜像 Node 22 |
| Agent SDK | 独立 Node 22 服务（`@earendil-works/pi-coding-agent` 精确锁定） |
| MCP Adapter | Agent Node runtime `pi-mcp-adapter@2.11.0`（exact lock）；直连外部 MCP Gateway/Server |
| Container | Docker, docker compose |
| Testing | pytest；`node:test`（api-server + agent + frontend）；无密钥 cross-service smoke；CI 见 `.github/workflows/test.yml` |

## 健康检查语义

| 端点 | 语义 | 失败 |
|------|------|------|
| `GET /health` | 进程存活（liveness） | 无响应 |
| `GET /ready` | 工作区可写 + DB 可 ping（readiness） | **HTTP 503** `status=not_ready` |
| `GET /health/live` | API Server BFF 进程存活 | 非 200 |
| `GET /health/ready` | BFF、Agent、Sandbox 均可用 | 503 |

探针响应不包含密钥、连接串或环境 dump。
