# Pi Enterprise Sandbox 重构开发设计

版本：v1.0
状态：开发实施基线
目标读者：Codex、项目开发人员、测试人员、架构评审人员
目标仓库：`nusduck/pi-enterprise-sandbox`

---

# 1. 文档目标

本设计用于指导 Codex 对现有项目进行完整重构，而不是在当前代码上继续叠加零散功能。

重构完成后，系统应成为一套基于 Pi Coding Agent 的企业级 Agent Runtime，具备：

1. Pi 原生 Agent Session、Tool Calling、Skill 和 Extension 能力。
2. Conversation、Agent Session、Run、Workspace 的明确生命周期。
3. 用户、组织、对话和运行级隔离。
4. MySQL 持久化事实状态。
5. Redis 管理运行态、队列、事件流和分布式协调。
6. Sandbox 中稳定、隔离、可恢复的文件和进程执行。
7. 前端完整呈现消息、工具调用、进程、审批、文件、Artifact 和 Trace。
8. 浏览器断连、刷新或 Agent 进程重启后，可以恢复运行状态。
9. 通过 A2A 协议和 SSE 被其他智能体调用。
10. 全链路携带 `org_id`、`user_id` 和 Trace 上下文。
11. MCP 工具直接由 Agent 调用，不绕行 Sandbox。
12. 业务数据只能通过受控的数据库 MCP 获取。
13. 用户上传 Dataset 时直接流式写入当前 Session Workspace。
14. 不重新开发 Pi 已经提供的 Agent Loop、Tool Dispatcher、Provider、Skill Loader 等能力。

---

# 2. 已锁定的架构决策

以下决策属于本次重构的硬约束，Codex 不得自行改变。

## 2.1 Pi Runtime

继续使用 `pi-coding-agent` SDK。

禁止：

* 自研新的 ReAct Loop。
* 自研 Tool Calling 协议。
* 自研模型消息转换层替代 Pi。
* 为兼容旧代码长期保留两套 Agent Runtime。
* 手工只恢复文本消息而忽略 Pi Session 和 Tool 状态。

Pi Runtime 负责：

* 模型调用。
* Agent Loop。
* Tool Calling。
* 上下文组织。
* Skill Progressive Disclosure。
* Agent Session。
* 消息压缩。
* Extension 生命周期。

企业代码只负责在 Pi 外围提供：

* 身份和租户上下文。
* 持久化。
* Sandbox 远程执行。
* MCP 接入。
* Policy。
* Trace 和审计。
* API 和前端呈现。

## 2.2 Extension 数量

企业自研 Extension 只保留三类：

```text
sandbox-bridge
enterprise-policy
observability
```

其中：

| Extension           | 职责                                          |
| ------------------- | ------------------------------------------- |
| `sandbox-bridge`    | 将文件、Shell、Python、进程、Artifact 等能力路由到 Sandbox |
| `enterprise-policy` | 租户隔离、工具权限、外部副作用审批、参数校验                      |
| `observability`     | Trace、事件、Token、成本、Tool、模型调用和审计记录            |

不再建立大量单功能 Extension。

## 2.3 MCP

删除自研 MCP Client、MCP 协议解析器和重复工具注册逻辑。

统一使用：

```text
pi-mcp-adapter
```

调用链：

```text
Pi Agent
  → pi-mcp-adapter
  → External MCP Server
```

禁止：

```text
Pi Agent
  → Sandbox
  → Sandbox MCP Client
  → External MCP Server
```

MCP 不是 Sandbox 执行能力的替代品。

MCP 用于：

* 数据库查询。
* 企业业务系统。
* 知识库。
* Git、搜索或其他外部系统。

Sandbox 用于：

* Shell。
* Python。
* Node。
* 文件读写。
* 数据处理。
* 长进程。
* Skill 脚本。
* Artifact 生成。

## 2.4 数据访问

Agent 不得直接获得业务数据库连接信息。

业务数据必须通过数据库 MCP 查询：

```text
Agent
  → DB MCP Tool
  → 受控 SQL Gateway
  → Business Database
```

DB MCP 必须实施：

* 数据源白名单。
* 租户约束。
* 只读默认策略。
* SQL 类型校验。
* 行数限制。
* 超时限制。
* 敏感字段脱敏。
* 查询审计。
* 结果大小限制。

## 2.5 持久化

```text
MySQL = 事实状态和持久化状态
Redis = 运行态、队列、事件和短期协调
Workspace Volume = Session 私有文件
```

Redis 不能成为业务事实的唯一来源。

禁止继续使用：

* SQLite 作为任何正式环境的默认数据库。
* Node 进程内 `Map` 作为 Run 的权威状态。
* Conversation 整体 JSON 消息字段。
* 进程内 SSE Event Buffer 作为唯一恢复来源。
* 两套 Run 状态机。
* MySQL 和 Redis 分别维护互相独立的 Run 事实状态。

## 2.6 Workspace

一个 Agent Session 独占一个 Workspace。

```text
Agent Session 1 ── 1 Workspace
```

规则：

1. 同一 Agent Session 的多轮对话复用同一 Workspace。
2. 不同 Agent Session 不共享 Workspace。
3. Workspace 创建时为空。
4. Skill 不复制到 Workspace。
5. Workspace 内的中间文件默认不向用户展示。
6. 只有显式提交的 Artifact 才进入用户交付列表。
7. Dataset 直接流式写入 Workspace。
8. Workspace 生命周期由 Agent Session 决定，而不是由单次 Run 决定。

Agent 可见路径固定为：

```text
/home/sandbox/workspace
/home/sandbox/skill
```

其中：

```text
/home/sandbox/workspace  可读写
/home/sandbox/skill      只读
```

禁止使用进程全局可变软链接，把不同 Session 的物理 Workspace 轮流链接到同一个路径。

必须通过以下任一方式为每个执行上下文提供稳定路径：

* 每执行进程独立 mount namespace。
* Bubblewrap bind mount。
* 独立 Sandbox Worker。
* 受控的 chroot/pivot_root。
* 进程级路径代理。

一期推荐：

```text
Bubblewrap + 每次 Execution 独立 mount namespace
```

物理路径示例：

```text
/var/lib/pi-sandbox/workspaces/{org_id}/{agent_session_id}
```

执行时映射：

```text
physical workspace
  → /home/sandbox/workspace

shared skill root
  → /home/sandbox/skill:ro
```

## 2.7 审批

普通 Sandbox 命令不再弹出审批。

以下操作默认不审批：

* Workspace 内 read。
* Workspace 内 write。
* Workspace 内 edit。
* Workspace 内 bash。
* Workspace 内 Python。
* Workspace 内 Node。
* Workspace 内文件删除。
* 启动 Workspace 内长进程。

安全性由以下机制保证：

* Workspace 隔离。
* 非 Root 用户。
* Path Policy。
* Resource Limit。
* Network Policy。
* Process Limit。
* Runtime Timeout。
* 审计。

审批仅用于外部副作用，例如：

* 数据库写入。
* 调用生产系统变更接口。
* 发送邮件或消息。
* 删除外部资源。
* 发布部署。
* 使用敏感凭证。
* 调用高风险企业 Tool。
* 跨租户访问。
* 管理员级操作。

## 2.8 Artifact

`write` 和 `edit` 只修改 Workspace。

禁止在每次写文件后自动发送 `file_ready`。

唯一交付链路：

```text
Workspace file
  → submit_artifact
  → Artifact metadata persisted
  → artifact.ready event
  → Frontend Deliverables
  → Artifact Download API
```

Artifact 适用于：

* 用户明确要求的文件。
* 最终报告。
* 最终数据集。
* 最终代码包。
* 最终图片、PDF、PPT、表格。
* 对任务有明确交付价值的结果。

中间脚本、缓存、日志、临时文件不应自动提交。

---

# 3. 目标总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│                         User / Caller                        │
│                                                              │
│ Browser Web UI       Enterprise System       Other Agent     │
└──────────┬────────────────────┬────────────────────┬─────────┘
           │ REST + SSE         │ REST              │ A2A/SSE
           ▼                    ▼                   ▼
┌──────────────────────────────────────────────────────────────┐
│                         API Server / BFF                     │
│                                                              │
│ Authentication                                               │
│ Tenant Context                                               │
│ Conversation API                                             │
│ Run API                                                      │
│ Dataset Streaming Proxy                                      │
│ Artifact Download                                            │
│ SSE Replay Gateway                                           │
│ A2A Authentication Gateway                                   │
│                                                              │
│ No Agent Loop                                                │
│ No Runtime State Authority                                   │
└──────────────────────────────┬───────────────────────────────┘
                               │ Internal API
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                          Agent Service                       │
│                                                              │
│ Run Application Service                                      │
│ Agent Session Service                                        │
│ Pi Runtime Factory                                            │
│ Run Worker                                                    │
│ Event Projector                                               │
│ A2A Task Adapter                                              │
│                                                              │
│ Pi Coding Agent Runtime                                       │
│   ├─ sandbox-bridge Extension                                 │
│   ├─ enterprise-policy Extension                              │
│   ├─ observability Extension                                  │
│   ├─ Pi Skills                                                │
│   └─ pi-mcp-adapter                                           │
└───────────────┬───────────────────────────────┬──────────────┘
                │ Internal HTTP                 │ MCP
                ▼                               ▼
┌──────────────────────────────┐    ┌──────────────────────────┐
│       Sandbox Service        │    │ External MCP Servers     │
│                              │    │                          │
│ Session/Workspace            │    │ DB MCP                   │
│ Files                        │    │ Knowledge MCP            │
│ Execution                    │    │ Business MCP             │
│ Process Handle               │    │ Other approved MCP       │
│ Dataset Writer               │    └──────────────────────────┘
│ Artifact Registration        │
│ Isolation                    │
│ Resource Control             │
└───────────────┬──────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────┐
│                     Infrastructure                          │
│                                                              │
│ MySQL             Redis             Workspace Volume         │
│ Durable Facts     Queue/Stream      Session Files            │
│ Outbox            Lease/Cache       Runtime Files            │
│ Audit             Rate Limit        Dataset Files            │
└──────────────────────────────────────────────────────────────┘
```

---

# 4. 核心领域对象

系统不得继续混用 Conversation、Session、Run 和 Sandbox Session。

## 4.1 Organization

租户边界。

```text
organization
  org_id
  name
  status
  created_at
  updated_at
```

所有用户资源必须属于一个 `org_id`。

## 4.2 User

用户身份。

```text
user
  user_id
  display_name
  email
  status
```

User 可以属于多个 Organization，但每次请求必须选择一个当前 Organization。

## 4.3 Agent Definition

Agent 的逻辑定义。

```text
agent_definition
  agent_id
  org_id
  name
  description
  status
  active_version_id
```

## 4.4 Agent Version

不可变的 Agent 配置快照。

包含：

```text
model policy
system prompt
enabled extensions
enabled skills
enabled MCP servers
tool policy
resource policy
A2A configuration
```

Run 创建后必须绑定具体 `agent_version_id`，不能随着 Agent 配置更新而漂移。

## 4.5 Conversation

用户层的对话容器。

```text
conversation
  conversation_id
  org_id
  user_id
  agent_id
  title
  status
```

Conversation 负责组织消息，不直接代表执行环境。

## 4.6 Agent Session

Pi Runtime 和 Workspace 的生命周期单元。

```text
agent_session
  agent_session_id
  org_id
  user_id
  conversation_id
  agent_version_id
  sandbox_session_id
  workspace_id
  status
```

一期默认：

```text
一个 Conversation 对应一个活跃 Agent Session
```

但数据模型不要把二者合并，以便后续支持：

* 重启 Session。
* Session 分支。
* Conversation 内切换 Agent Version。
* Archived Session。

## 4.7 Run

一次用户消息触发的一次执行。

```text
run
  run_id
  agent_session_id
  triggering_message_id
  status
  started_at
  completed_at
```

同一个 Agent Session 可包含多个 Run。

## 4.8 Sandbox Session

Sandbox 对 Workspace 和执行资源的管理对象。

Sandbox Session 不保存 Agent 对话。

## 4.9 Execution

一次具体工具执行。

类型包括：

```text
file_read
file_write
file_edit
command
python
node
process_start
process_signal
artifact_submit
```

## 4.10 Process Handle

长运行任务的持久化句柄。

```text
process_id
execution_id
sandbox_session_id
pid
status
started_at
ended_at
exit_code
```

## 4.11 Dataset

上传到 Workspace 的用户数据对象。

Dataset 不是消息附件的 Base64 字段，也不是 MySQL Blob。

## 4.12 Artifact

显式交付给用户的最终文件对象。

## 4.13 A2A Task

外部 Agent 调用本 Agent 后创建的协议层任务。

A2A Task 映射到内部 Run，但不能直接把内部数据库结构暴露给调用方。

---

# 5. ID 与时间规范

统一使用 ULID，字符串长度 26。

示例：

```text
01K0G2PAV8FPMVC9QHJG7JPN4Z
```

优点：

* 按时间排序。
* 前端可安全处理。
* 不需要暴露数据库自增 ID。
* 分布式生成无冲突。

所有时间：

```text
数据库存 UTC
API 返回 ISO 8601 UTC
前端按用户时区显示
```

示例：

```text
2026-07-18T04:31:22.417Z
```

禁止在领域表中依赖本地时区时间。

---

# 6. 全链路上下文

所有外部和内部请求都必须建立统一上下文。

```typescript
interface RequestContext {
  orgId: string;
  userId: string;
  conversationId?: string;
  agentSessionId?: string;
  runId?: string;
  sandboxSessionId?: string;
  executionId?: string;
  traceId: string;
  spanId: string;
  requestId: string;
  callerType: "web" | "api" | "a2a" | "worker" | "system";
  callerId?: string;
}
```

## 6.1 HTTP Header

外部请求：

```text
Authorization: Bearer <token>
X-Request-Id: <optional client request id>
X-Idempotency-Key: <required for creation APIs>
traceparent: <W3C trace context>
```

内部请求：

```text
X-Org-Id
X-User-Id
X-Conversation-Id
X-Agent-Session-Id
X-Run-Id
X-Sandbox-Session-Id
X-Request-Id
traceparent
tracestate
```

不得信任浏览器直接传入的 `org_id` 和 `user_id`。

BFF 必须从已验证身份和 Membership 中解析并覆盖它们。

## 6.2 Trace

采用 W3C Trace Context。

调用链：

```text
Frontend
  → BFF
  → Agent Service
  → Pi Runtime
  → Extension
  → Sandbox or MCP
```

必须保持同一 `trace_id`。

每次以下操作创建子 Span：

* Run 接收。
* Queue 等待。
* Pi Session 恢复。
* Model Call。
* Tool Call。
* Sandbox Execution。
* MCP Call。
* Artifact Submit。
* A2A Projection。

---

# 7. 单一事实源设计

## 7.1 MySQL

MySQL 是以下内容的唯一事实源：

* Organization。
* User。
* Membership。
* Agent Definition。
* Agent Version。
* Conversation。
* Message。
* Agent Session。
* Run。
* Run Event。
* Tool Execution。
* Process metadata。
* Dataset metadata。
* Artifact metadata。
* Approval。
* A2A Task。
* Audit。
* Idempotency。
* Outbox。

## 7.2 Redis

Redis 只负责：

* Run Queue。
* Worker Lease。
* 分布式锁。
* SSE Redis Stream。
* 取消信号。
* Process 实时输出。
* Rate Limit。
* 短期 Session Cache。
* Presence。
* 临时幂等加速。
* Pub/Sub 通知。

Redis 清空后，系统必须可以根据 MySQL 恢复事实状态。

## 7.3 Workspace

Workspace 保存：

* 用户上传文件。
* Dataset。
* Agent 创建的中间文件。
* Skill 执行文件。
* Python 自动生成脚本。
* Process stdout/stderr 文件。
* 最终输出文件。
* Pi 原生 Session 文件或快照副本。

Workspace 丢失属于文件层故障，但不能导致 MySQL 中 Run 状态被默认为成功。

---

# 8. MySQL 数据模型

生产环境必须使用数据库迁移工具，例如：

```text
Knex migrations
或
Prisma migrations
```

不得在应用启动时通过手写 `CREATE TABLE IF NOT EXISTS` 隐式演进生产数据库。

字符集：

```text
utf8mb4
```

引擎：

```text
InnoDB
```

## 8.1 organizations

```sql
CREATE TABLE organizations (
  org_id CHAR(26) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL
);
```

## 8.2 users

```sql
CREATE TABLE users (
  user_id CHAR(26) PRIMARY KEY,
  external_subject VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  email VARCHAR(320),
  status VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_users_external_subject (external_subject)
);
```

## 8.3 organization_memberships

```sql
CREATE TABLE organization_memberships (
  org_id CHAR(26) NOT NULL,
  user_id CHAR(26) NOT NULL,
  role VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id) REFERENCES organizations(org_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);
```

## 8.4 agent_definitions

```sql
CREATE TABLE agent_definitions (
  agent_id CHAR(26) PRIMARY KEY,
  org_id CHAR(26) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(32) NOT NULL,
  active_version_id CHAR(26),
  created_by CHAR(26) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_agents_org (org_id, status)
);
```

## 8.5 agent_versions

```sql
CREATE TABLE agent_versions (
  agent_version_id CHAR(26) PRIMARY KEY,
  agent_id CHAR(26) NOT NULL,
  version_no INT NOT NULL,
  config_json JSON NOT NULL,
  config_hash CHAR(64) NOT NULL,
  pi_sdk_version VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_by CHAR(26) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_agent_version (agent_id, version_no),
  FOREIGN KEY (agent_id) REFERENCES agent_definitions(agent_id)
);
```

`config_json` 包含：

```json
{
  "modelPolicy": {},
  "systemPrompt": "",
  "extensions": [],
  "skills": [],
  "mcpServers": [],
  "toolPolicy": {},
  "sandboxPolicy": {},
  "a2a": {}
}
```

## 8.6 conversations

```sql
CREATE TABLE conversations (
  conversation_id CHAR(26) PRIMARY KEY,
  org_id CHAR(26) NOT NULL,
  user_id CHAR(26) NOT NULL,
  agent_id CHAR(26) NOT NULL,
  title VARCHAR(500),
  status VARCHAR(32) NOT NULL,
  current_agent_session_id CHAR(26),
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  archived_at DATETIME(3),
  INDEX idx_conversations_owner (
    org_id,
    user_id,
    updated_at
  )
);
```

## 8.7 messages

禁止把全部历史存成 Conversation 的一个 JSON 字段。

```sql
CREATE TABLE messages (
  message_id CHAR(26) PRIMARY KEY,
  conversation_id CHAR(26) NOT NULL,
  agent_session_id CHAR(26),
  run_id CHAR(26),
  role VARCHAR(32) NOT NULL,
  message_type VARCHAR(64) NOT NULL,
  content_json JSON NOT NULL,
  sequence_no BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_message_sequence (
    conversation_id,
    sequence_no
  ),
  INDEX idx_messages_session (
    agent_session_id,
    sequence_no
  )
);
```

`role`：

```text
user
assistant
tool
system
```

`message_type`：

```text
text
multimodal
tool_call
tool_result
status
error
```

## 8.8 agent_sessions

```sql
CREATE TABLE agent_sessions (
  agent_session_id CHAR(26) PRIMARY KEY,
  org_id CHAR(26) NOT NULL,
  user_id CHAR(26) NOT NULL,
  conversation_id CHAR(26) NOT NULL,
  agent_version_id CHAR(26) NOT NULL,
  sandbox_session_id CHAR(26) NOT NULL,
  workspace_id CHAR(26) NOT NULL,
  status VARCHAR(32) NOT NULL,
  pi_session_version BIGINT NOT NULL DEFAULT 0,
  last_run_id CHAR(26),
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  closed_at DATETIME(3),
  UNIQUE KEY uk_active_conversation_session (
    conversation_id,
    status
  )
);
```

如果 MySQL 不适合通过唯一索引限制多个状态，可在事务中显式加锁检查。

## 8.9 agent_session_snapshots

```sql
CREATE TABLE agent_session_snapshots (
  snapshot_id CHAR(26) PRIMARY KEY,
  agent_session_id CHAR(26) NOT NULL,
  snapshot_version BIGINT NOT NULL,
  snapshot_format VARCHAR(32) NOT NULL,
  snapshot_json JSON,
  workspace_path VARCHAR(1024),
  checksum CHAR(64) NOT NULL,
  pi_sdk_version VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_session_snapshot (
    agent_session_id,
    snapshot_version
  )
);
```

平台消息和 Run Event 是长期恢复依据。

Pi 原生 Snapshot 是适配器级加速，不是唯一记录。

## 8.10 runs

```sql
CREATE TABLE runs (
  run_id CHAR(26) PRIMARY KEY,
  org_id CHAR(26) NOT NULL,
  user_id CHAR(26) NOT NULL,
  conversation_id CHAR(26) NOT NULL,
  agent_session_id CHAR(26) NOT NULL,
  agent_version_id CHAR(26) NOT NULL,
  triggering_message_id CHAR(26) NOT NULL,
  source VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  status_reason VARCHAR(255),
  queue_name VARCHAR(128) NOT NULL,
  attempt INT NOT NULL DEFAULT 0,
  trace_id CHAR(32) NOT NULL,
  started_at DATETIME(3),
  completed_at DATETIME(3),
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_runs_session (
    agent_session_id,
    created_at
  ),
  INDEX idx_runs_trace (trace_id),
  INDEX idx_runs_status (status, created_at)
);
```

## 8.11 run_events

Append-only。

```sql
CREATE TABLE run_events (
  event_id CHAR(26) PRIMARY KEY,
  run_id CHAR(26) NOT NULL,
  org_id CHAR(26) NOT NULL,
  sequence_no BIGINT NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  event_version INT NOT NULL,
  payload_json JSON NOT NULL,
  trace_id CHAR(32) NOT NULL,
  span_id CHAR(16),
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_run_event_sequence (
    run_id,
    sequence_no
  ),
  INDEX idx_run_events_created (
    run_id,
    created_at
  )
);
```

禁止：

```text
SELECT MAX(sequence_no) + 1
```

推荐分配方式：

在 `runs` 表增加：

```text
next_event_sequence BIGINT
```

每次写事件时执行：

```sql
UPDATE runs
SET next_event_sequence = LAST_INSERT_ID(next_event_sequence + 1)
WHERE run_id = ?;
```

随后在同一事务中读取分配序号并插入事件。

也可以建立单独的 `run_event_counters` 表并使用行锁。

## 8.12 tool_executions

```sql
CREATE TABLE tool_executions (
  tool_execution_id CHAR(26) PRIMARY KEY,
  run_id CHAR(26) NOT NULL,
  agent_session_id CHAR(26) NOT NULL,
  tool_call_id VARCHAR(255) NOT NULL,
  tool_name VARCHAR(255) NOT NULL,
  tool_source VARCHAR(32) NOT NULL,
  risk_level VARCHAR(32) NOT NULL,
  arguments_json JSON NOT NULL,
  result_json JSON,
  status VARCHAR(32) NOT NULL,
  error_code VARCHAR(128),
  trace_id CHAR(32) NOT NULL,
  started_at DATETIME(3),
  completed_at DATETIME(3),
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_tool_call (
    run_id,
    tool_call_id
  )
);
```

`tool_source`：

```text
sandbox
mcp
internal
```

## 8.13 process_executions

```sql
CREATE TABLE process_executions (
  process_id CHAR(26) PRIMARY KEY,
  sandbox_session_id CHAR(26) NOT NULL,
  run_id CHAR(26) NOT NULL,
  execution_id CHAR(26) NOT NULL,
  command_json JSON NOT NULL,
  status VARCHAR(32) NOT NULL,
  pid INT,
  exit_code INT,
  stdout_path VARCHAR(1024),
  stderr_path VARCHAR(1024),
  started_at DATETIME(3),
  ended_at DATETIME(3),
  created_at DATETIME(3) NOT NULL
);
```

## 8.14 datasets

```sql
CREATE TABLE datasets (
  dataset_id CHAR(26) PRIMARY KEY,
  org_id CHAR(26) NOT NULL,
  user_id CHAR(26) NOT NULL,
  conversation_id CHAR(26) NOT NULL,
  agent_session_id CHAR(26) NOT NULL,
  original_filename VARCHAR(1024) NOT NULL,
  stored_relative_path VARCHAR(1024) NOT NULL,
  mime_type VARCHAR(255),
  size_bytes BIGINT,
  sha256 CHAR(64),
  status VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3)
);
```

## 8.15 artifacts

```sql
CREATE TABLE artifacts (
  artifact_id CHAR(26) PRIMARY KEY,
  org_id CHAR(26) NOT NULL,
  user_id CHAR(26) NOT NULL,
  conversation_id CHAR(26) NOT NULL,
  agent_session_id CHAR(26) NOT NULL,
  run_id CHAR(26) NOT NULL,
  relative_path VARCHAR(1024) NOT NULL,
  relative_path_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (LOWER(SHA2(relative_path, 256))) STORED NOT NULL,
  display_name VARCHAR(1024) NOT NULL,
  mime_type VARCHAR(255),
  size_bytes BIGINT NOT NULL,
  sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_artifact_file (
    run_id,
    relative_path_hash,
    sha256
  )
);
```

`relative_path_hash` 是完整 `relative_path` 的 SHA-256（不是前缀索引）。
它保留完整路径幂等语义，同时避免 `utf8mb4 VARCHAR(1024)` 与其他列组成
唯一键时超过 InnoDB 3072-byte 索引上限；读取或去重时仍须同时核对原始
`relative_path`，不能仅依赖哈希值。

## 8.16 approvals

只用于企业外部副作用。

```sql
CREATE TABLE approvals (
  approval_id CHAR(26) PRIMARY KEY,
  org_id CHAR(26) NOT NULL,
  run_id CHAR(26) NOT NULL,
  tool_execution_id CHAR(26) NOT NULL,
  requested_by CHAR(26) NOT NULL,
  decision_by CHAR(26),
  status VARCHAR(32) NOT NULL,
  request_json JSON NOT NULL,
  decision_reason TEXT,
  expires_at DATETIME(3),
  created_at DATETIME(3) NOT NULL,
  decided_at DATETIME(3)
);
```

## 8.17 domain_outbox

所有需要发送到 Redis Stream 的持久化事件，必须和领域状态在同一 MySQL 事务中写入 Outbox。

```sql
CREATE TABLE domain_outbox (
  outbox_id CHAR(26) PRIMARY KEY,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id CHAR(26) NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  payload_json JSON NOT NULL,
  status VARCHAR(32) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  published_at DATETIME(3),
  INDEX idx_outbox_pending (
    status,
    created_at
  )
);
```

## 8.18 idempotency_records

```sql
CREATE TABLE idempotency_records (
  org_id CHAR(26) NOT NULL,
  user_id CHAR(26) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  operation VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response_status INT,
  response_json JSON,
  resource_id CHAR(26),
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (
    org_id,
    user_id,
    idempotency_key,
    operation
  )
);
```

---

# 9. Redis 设计

建议使用 BullMQ 管理 Run Queue。

## 9.1 Queue

```text
queue:agent-runs
queue:outbox-publisher
queue:workspace-cleanup
queue:artifact-index
```

Run Queue Job 数据只保存引用：

```json
{
  "runId": "01...",
  "orgId": "01...",
  "traceId": "..."
}
```

不要把完整对话或 Dataset 放进 Redis Job。

## 9.2 Redis Key

```text
run:lease:{run_id}
run:cancel:{run_id}
run:stream:{run_id}
run:presence:{run_id}
session:cache:{agent_session_id}
process:stream:{process_id}
process:cancel:{process_id}
rate:{org_id}:{user_id}:{operation}
lock:session:{agent_session_id}
lock:workspace:{workspace_id}
outbox:wakeup
```

## 9.3 Run Stream

使用 Redis Stream：

```text
run:stream:{run_id}
```

字段：

```json
{
  "eventId": "01...",
  "sequence": "18",
  "type": "tool.execution.started",
  "payload": "{...}",
  "createdAt": "..."
}
```

Redis Stream 用于低延迟推送。

MySQL `run_events` 用于完整历史和重放。

## 9.4 Stream 保留

Redis Stream 可以按长度或时间裁剪，例如：

```text
MAXLEN ~ 10000
```

裁剪不能影响历史恢复，因为历史仍在 MySQL。

## 9.5 Lease

Worker 开始执行 Run 时：

```text
SET run:lease:{run_id} worker_id NX PX 30000
```

Worker 每 10 秒续约。

Lease 丢失时：

1. 当前 Worker 停止进入新的副作用步骤。
2. 标记执行异常。
3. 由恢复任务检查 MySQL Run 状态。
4. 根据幂等记录决定重试或失败。

---

# 10. Run 状态机

```text
ACCEPTED
  → QUEUED
  → STARTING
  → RUNNING
  → SUCCEEDED

RUNNING
  → WAITING_APPROVAL
  → RUNNING

RUNNING
  → WAITING_INPUT
  → RUNNING

RUNNING
  → CANCELLING
  → CANCELLED

QUEUED
  → CANCELLING
  → CANCELLED

STARTING / RUNNING
  → RETRYING
  → QUEUED

STARTING / RUNNING / RETRYING
  → FAILED
```

终态：

```text
SUCCEEDED
FAILED
CANCELLED
```

状态更新必须通过统一的 `RunStateMachine`。

禁止在：

* BFF。
* Sandbox。
* Frontend。
* Redis Consumer。

分别实现独立状态转换逻辑。

---

# 11. Agent Session 状态机

```text
CREATING
  → ACTIVE
  → CLOSING
  → CLOSED

ACTIVE
  → SUSPENDED
  → ACTIVE

CREATING / ACTIVE / SUSPENDED
  → FAILED
```

`ACTIVE` Session 可以顺序处理多个 Run。

一期默认同一 Agent Session 同时只允许一个 Active Run。

用户在前一 Run 执行期间发送新消息时：

```text
默认：创建 follow-up message，等待当前 Run 完成后自动执行
```

用户显式选择“立即指导当前任务”时：

```text
创建 steer instruction，注入当前 Run
```

不要把 follow-up 和 steer 混为同一接口。

---

# 12. Agent Service 重构

## 12.1 目标结构

```text
agent/
  src/
    bootstrap/
      server.ts
      worker.ts
      config.ts
      dependency-container.ts

    domain/
      agent/
      conversation/
      session/
      run/
      event/
      tool/
      artifact/
      a2a/

    application/
      create-run-service.ts
      execute-run-service.ts
      cancel-run-service.ts
      steer-run-service.ts
      follow-up-service.ts
      agent-session-service.ts
      session-snapshot-service.ts
      event-query-service.ts
      a2a-task-service.ts

    runtime/
      pi-runtime-factory.ts
      pi-session-adapter.ts
      run-executor.ts
      prompt-context-builder.ts
      event-projector.ts

    extensions/
      sandbox-bridge/
        index.ts
        sandbox-client.ts
        tools/
          read.ts
          write.ts
          edit.ts
          bash.ts
          python.ts
          process-start.ts
          process-status.ts
          process-read.ts
          process-kill.ts
          submit-artifact.ts

      enterprise-policy/
        index.ts
        policy-engine.ts
        tool-risk-classifier.ts
        approval-policy.ts
        tenant-policy.ts

      observability/
        index.ts
        trace-context.ts
        event-recorder.ts
        token-recorder.ts
        audit-recorder.ts

    infrastructure/
      mysql/
        repositories/
        transaction-manager.ts
      redis/
        redis-client.ts
        run-queue.ts
        run-event-stream.ts
        lease-manager.ts
      outbox/
        outbox-publisher.ts
      sandbox/
        sandbox-api-client.ts
      mcp/
        mcp-config-loader.ts
        pi-mcp-adapter-factory.ts

    presentation/
      internal-http/
      a2a/
      health/
```

## 12.2 Pi Runtime Factory

`PiRuntimeFactory` 负责根据 Agent Version 创建 Pi Runtime。

输入：

```typescript
interface PiRuntimeCreateInput {
  context: RequestContext;
  agentVersion: AgentVersion;
  agentSession: AgentSession;
  piSnapshot?: PiSessionSnapshot;
}
```

输出：

```typescript
interface ManagedPiRuntime {
  session: AgentSessionRuntime;
  dispose(): Promise<void>;
}
```

Factory 必须：

1. 创建 Model Runtime。
2. 创建 Session Manager。
3. 加载 Agent Version 固定的配置。
4. 加载三类企业 Extension。
5. 加载 Pi Skill。
6. 配置 `pi-mcp-adapter`。
7. 注入 Request Context。
8. 注入 Sandbox Session。
9. 注册事件订阅。
10. 恢复 Pi Snapshot。
11. 校验 SDK 版本兼容性。

## 12.3 Run Worker

Run Worker 处理流程：

```text
1. 从 BullMQ 获取 run_id
2. 获取 Redis Lease
3. MySQL 读取 Run
4. 校验 Run 状态
5. 锁定 Agent Session
6. 加载 Agent Version
7. 加载消息历史和 Session Snapshot
8. 验证 Sandbox Session / Workspace
9. 创建 Pi Runtime
10. 将用户消息交给 Pi Session
11. 接收 Pi Event
12. 投影为平台 Run Event
13. 写入 MySQL + Outbox
14. 定期保存 Pi Snapshot
15. 完成后写 Assistant Message
16. 更新 Run 状态
17. 释放 Runtime、Lease 和 Session Lock
```

浏览器是否连接不得决定 Worker 是否继续执行。

## 12.4 Browser Disconnect

当前端 SSE 断开：

```text
只断开订阅
不取消 Run
不关闭 Pi Runtime
不关闭 Sandbox Process
```

只有以下情况取消 Run：

* 用户调用 Cancel API。
* Run 超过总体 Timeout。
* 管理员取消。
* Policy 强制终止。
* 系统无法恢复的错误。

## 12.5 Session 恢复

恢复优先级：

```text
1. Pi 原生 Session Snapshot
2. 平台 Message + Run Event Journal
3. 如果二者校验不一致，进入 RECOVERY_REQUIRED
```

不得只把历史文本重新拼进 Prompt，然后声称恢复了完整 Session。

至少应恢复：

* User/Assistant Message。
* Tool Call。
* Tool Result。
* Compaction Summary。
* Agent Version。
* Model Policy。
* Skill Version。
* MCP 配置。
* Pending Approval。
* Follow-up 队列。
* 已完成副作用的幂等记录。

---

# 13. sandbox-bridge Extension

## 13.1 目标

保留 Pi 默认工具名称和使用习惯，但把实际执行重定向到远程 Sandbox。

需要覆盖或注册：

```text
read
write
edit
bash
python
process_start
process_status
process_read
process_kill
submit_artifact
```

## 13.2 read

输入：

```json
{
  "path": "data/input.csv",
  "offset": 0,
  "limit": 20000
}
```

要求：

* 只允许 Workspace 或 Skill 只读路径。
* 默认路径相对 `/home/sandbox/workspace`。
* Skill 路径必须显式以 `/home/sandbox/skill` 开头。
* 大文件必须分页。
* 二进制文件返回 metadata，不直接返回原始内容。
* 输出内容进行最大字节限制。

## 13.3 write

输入：

```json
{
  "path": "output/result.json",
  "content": "...",
  "encoding": "utf-8"
}
```

要求：

* 原子写入：临时文件后 rename。
* 自动创建父目录。
* 禁止写 Skill 目录。
* 返回文件 metadata。
* 不产生 Artifact。
* 不产生下载链接。

## 13.4 edit

要求：

* 支持精确替换或 Patch。
* 写入前校验目标文件版本或哈希。
* 并发修改时返回 `FILE_VERSION_CONFLICT`。
* 不允许悄悄覆盖已变化文件。

## 13.5 bash

输入：

```json
{
  "command": "python script.py",
  "timeoutSeconds": 120,
  "env": {}
}
```

默认：

* cwd 固定为 `/home/sandbox/workspace`。
* 使用最小环境变量。
* 禁止注入宿主密钥。
* stdout 和 stderr 有大小限制。
* 超时后终止整个进程组。
* 返回 exit code。
* 普通命令不要求审批。

## 13.6 python

提供独立 Python Tool，避免模型反复构造复杂 Shell heredoc。

输入：

```json
{
  "code": "print('hello')",
  "args": [],
  "timeoutSeconds": 120
}
```

处理规则：

```text
单行且较短代码
  → python -c

多行代码
或代码长度超过阈值
  → 自动写入 .runtime/python/{execution_id}.py
  → python 文件执行
```

建议阈值：

```text
代码包含换行
或长度 > 2048 字节
```

事件中记录：

```text
materialized_path
python_version
exit_code
```

自动生成脚本属于中间文件，不自动 Artifact 化。

## 13.7 Process Handle

长任务必须使用 Process Handle，而不是让 Tool Call 一直占用 HTTP 请求。

### process_start

```json
{
  "command": "python train.py",
  "env": {},
  "timeoutSeconds": 14400
}
```

返回：

```json
{
  "processId": "01...",
  "status": "running",
  "stdoutCursor": "0-0",
  "stderrCursor": "0-0"
}
```

### process_status

返回：

```json
{
  "processId": "01...",
  "status": "running",
  "exitCode": null,
  "startedAt": "...",
  "elapsedSeconds": 351
}
```

### process_read

支持按 Cursor 读取增量日志。

### process_kill

支持：

```text
TERM
KILL
INT
```

默认先 TERM，等待 Grace Period 后 KILL。

## 13.8 submit_artifact

输入：

```json
{
  "path": "output/report.pdf",
  "displayName": "风险分析报告.pdf",
  "description": "最终分析报告"
}
```

Sandbox 校验：

* 文件属于当前 Workspace。
* 文件存在。
* 不是目录。
* 大小未超过限制。
* MIME 类型可识别。
* 计算 SHA-256。

Agent Service 创建 Artifact metadata，并产生：

```text
artifact.ready
```

---

# 14. enterprise-policy Extension

## 14.1 Policy 层次

```text
Platform Policy
  > Organization Policy
  > Agent Version Policy
  > Tool Policy
  > Request Context
```

低层策略不能放宽高层策略。

## 14.2 Tool 分类

### 本地低风险

```text
read
write
edit
bash
python
process_*
submit_artifact
```

前提是操作被限制在当前 Sandbox Session。

### 外部只读

```text
DB SELECT
Knowledge Search
Read-only Business API
```

通常不审批，但必须审计和限流。

### 外部高风险

```text
DB INSERT/UPDATE/DELETE
发送消息
创建工单
修改业务配置
发布模型
删除资源
触发生产任务
```

必须根据 Agent Policy 判断：

```text
allow
deny
require_approval
```

## 14.3 Policy Result

```typescript
interface PolicyDecision {
  decision: "allow" | "deny" | "require_approval";
  reasonCode: string;
  reason: string;
  policyId: string;
  riskLevel: "low" | "medium" | "high" | "critical";
}
```

每次决策写入审计。

## 14.4 Tenant Enforcement

任何 Tool Call 必须绑定：

```text
org_id
user_id
agent_session_id
run_id
```

外部 MCP 参数中的租户条件不能只依赖模型生成。

例如 DB MCP 查询时，应由 Gateway 在服务端强制注入允许的数据域，而不是让模型自己在 SQL 中附加 `org_id`。

---

# 15. observability Extension

## 15.1 事件订阅

需要订阅或包装：

* Session 创建和关闭。
* User Message。
* Assistant Message。
* Model Request。
* Model Response。
* Tool Proposal。
* Tool Start。
* Tool Progress。
* Tool Completion。
* Tool Failure。
* Compaction。
* Token Usage。
* Retry。
* Cancellation。
* Error。

## 15.2 平台事件

统一事件命名：

```text
run.accepted
run.queued
run.started
run.status.changed
run.completed
run.failed
run.cancelled

message.created
message.delta
message.completed

model.request.started
model.request.completed
model.request.failed

tool.call.proposed
tool.execution.started
tool.execution.progress
tool.execution.completed
tool.execution.failed

process.started
process.output
process.completed
process.failed
process.cancelled

approval.requested
approval.resolved

dataset.upload.started
dataset.upload.progress
dataset.ready
dataset.failed

artifact.ready

session.snapshot.saved
session.compacted

error.occurred
```

## 15.3 Event Envelope

```json
{
  "eventId": "01K...",
  "eventVersion": 1,
  "sequence": 18,
  "type": "tool.execution.completed",
  "timestamp": "2026-07-18T04:31:22.417Z",
  "context": {
    "orgId": "01...",
    "userId": "01...",
    "conversationId": "01...",
    "agentSessionId": "01...",
    "runId": "01...",
    "traceId": "b7...",
    "spanId": "91..."
  },
  "data": {}
}
```

Frontend、A2A 和审计都基于该统一事件投影，不各自读取 Pi 私有事件格式。

---

# 16. Sandbox Service 重构

## 16.1 目标结构

```text
sandbox/
  app/
    main.py
    config.py

    api/
      internal_sessions.py
      internal_files.py
      internal_executions.py
      internal_processes.py
      internal_datasets.py
      internal_artifacts.py
      health.py

    domain/
      session.py
      workspace.py
      execution.py
      process.py
      dataset.py
      artifact.py

    services/
      session_service.py
      workspace_service.py
      file_service.py
      execution_service.py
      process_service.py
      dataset_service.py
      artifact_service.py
      cleanup_service.py

    isolation/
      bwrap_runner.py
      mount_policy.py
      process_limits.py
      network_policy.py
      environment_policy.py

    persistence/
      mysql_repositories.py
      redis_runtime.py

    security/
      internal_auth.py
      path_resolver.py
      secret_redactor.py

    observability/
      tracing.py
      audit.py
      metrics.py
```

## 16.2 Sandbox 内部鉴权

Agent Service 调用 Sandbox 使用服务身份。

一期可以使用：

```text
HMAC signed internal token
```

Token Claims：

```json
{
  "iss": "agent-service",
  "aud": "sandbox-service",
  "org_id": "01...",
  "user_id": "01...",
  "agent_session_id": "01...",
  "sandbox_session_id": "01...",
  "run_id": "01...",
  "scope": ["files:write", "execute:command"],
  "exp": 1760000000
}
```

不得只使用一个永不过期的全局共享字符串。

后续可替换为：

* mTLS。
* Workload Identity。
* 短期 JWT。

## 16.3 Path Resolver

所有入口必须调用同一个 Path Resolver，包括：

* REST File API。
* Bash。
* Python。
* Node。
* Dataset。
* Artifact。
* Process。
* Preview。
* Download。

禁止每个 Router 自己拼路径。

逻辑：

```text
logical path
  → normalize
  → reject null byte
  → reject path escape
  → resolve symbolic link
  → verify resolved physical root
  → check read/write permission
```

Symbolic Link 必须校验最终目标。

## 16.4 Isolation

Bubblewrap 推荐参数思路：

```text
--unshare-user
--unshare-pid
--unshare-ipc
--unshare-uts
--unshare-cgroup
--die-with-parent
--new-session

--bind <physical_workspace> /home/sandbox/workspace
--ro-bind <skill_root> /home/sandbox/skill
--ro-bind /usr /usr
--ro-bind /bin /bin
--ro-bind /lib /lib
--ro-bind /lib64 /lib64
--proc /proc
--dev /dev
--tmpfs /tmp
--chdir /home/sandbox/workspace
```

网络：

```text
默认关闭或受限
```

需要网络的 Skill 或命令必须通过 Agent Version Policy 显式开启。

不得给予 Sandbox 容器：

```text
NET_ADMIN
NET_RAW
privileged
docker.sock
```

## 16.5 Resource Limit

每次执行至少限制：

```text
CPU time
wall time
memory
process count
open files
file size
stdout bytes
stderr bytes
workspace quota
```

建议默认值：

```text
Command timeout: 120 秒
Python timeout: 300 秒
Max stdout: 4 MB
Max stderr: 4 MB
Max process count: 128
Max workspace: 10 GB
Max single upload: 5 GB
```

具体值必须配置化。

## 16.6 Execution Idempotency

所有 Sandbox 执行请求必须带：

```text
execution_id
idempotency_key
```

Sandbox 发现相同 `execution_id` 已完成时，应返回原结果，不重复执行。

对于命令副作用只能保证 Workspace 级幂等时，需要记录执行结果和输出文件哈希。

---

# 17. Dataset 流式写入 Workspace

## 17.1 API

```http
POST /api/conversations/{conversation_id}/datasets
Content-Type: multipart/form-data
X-Idempotency-Key: ...
```

也可支持分片：

```http
POST /api/dataset-uploads
PUT  /api/dataset-uploads/{upload_id}/parts/{part_no}
POST /api/dataset-uploads/{upload_id}/complete
```

一期先实现单 HTTP 流式上传，但不得在 BFF 内存中完整缓冲。

## 17.2 数据流

```text
Browser Stream
  → BFF Authentication
  → reserve Dataset row in MySQL
  → BFF pipes stream
  → Sandbox Dataset API
  → write .uploading temporary file
  → calculate sha256 while streaming
  → fsync
  → atomic rename
  → update Dataset READY
  → emit dataset.ready
```

## 17.3 Workspace 路径

```text
datasets/{dataset_id}/{safe_filename}
```

Agent 可在 Workspace 中看到：

```text
/home/sandbox/workspace/datasets/{dataset_id}/{safe_filename}
```

## 17.4 安全要求

* Filename 清洗。
* 不接受绝对路径。
* 限制文件大小。
* 校验 Workspace Quota。
* 流式计算 SHA-256。
* 可选病毒扫描。
* 失败时删除临时文件。
* 上传完成前 Agent 不得读取。
* 不把文件内容写入 MySQL。
* 不把文件内容放入 Redis。
* 不把文件 Base64 放进消息。

---

# 18. BFF 重构

## 18.1 职责

BFF 只负责：

* 用户认证。
* Organization 上下文。
* API DTO。
* Ownership 检查。
* Idempotency。
* 调用 Agent Internal API。
* Dataset 流式代理。
* Artifact 下载代理或签名。
* SSE 订阅和历史重放。
* Rate Limit。
* 错误标准化。

BFF 不负责：

* Agent Loop。
* Tool 调度。
* Run 状态机。
* Session 恢复。
* Process 管理。
* Pi Event 解析。
* Workspace 生命周期决策。

## 18.2 目标结构

```text
api-server/
  src/
    server.ts
    config.ts

    middleware/
      authentication.ts
      tenant-context.ts
      trace-context.ts
      idempotency.ts
      rate-limit.ts
      error-handler.ts

    routes/
      conversations.ts
      messages.ts
      runs.ts
      events.ts
      datasets.ts
      artifacts.ts
      approvals.ts
      traces.ts
      agents.ts

    clients/
      agent-service-client.ts
      sandbox-upload-client.ts

    services/
      access-control-service.ts
      event-replay-service.ts
      dataset-stream-service.ts
      artifact-delivery-service.ts
```

## 18.3 创建 Run

```http
POST /api/conversations/{conversation_id}/runs
X-Idempotency-Key: ...
```

Body：

```json
{
  "message": {
    "content": [
      {
        "type": "text",
        "text": "分析已上传数据"
      }
    ]
  }
}
```

响应必须在 Run 已写入 MySQL 后返回：

```http
202 Accepted
```

```json
{
  "runId": "01...",
  "conversationId": "01...",
  "agentSessionId": "01...",
  "status": "ACCEPTED",
  "eventsUrl": "/api/runs/01.../events"
}
```

这样前端不会在创建 Run 后立即查询时遇到“Run 尚未写入”的竞态。

## 18.4 SSE

```http
GET /api/runs/{run_id}/events?afterSequence=17
Accept: text/event-stream
Last-Event-ID: 01...
```

连接流程：

```text
1. 校验用户是否拥有 Run
2. 从 MySQL 读取 afterSequence 之后的历史事件
3. 按 sequence 顺序发送
4. 切换到 Redis Stream 实时订阅
5. 检查订阅切换间隙
6. 补发缺失事件
7. 持续推送
```

SSE 格式：

```text
id: 01K...
event: tool.execution.completed
data: {"sequence":18,...}

```

必须发送 Heartbeat：

```text
event: ping
data: {"timestamp":"..."}
```

## 18.5 Cancel

```http
POST /api/runs/{run_id}/cancel
X-Idempotency-Key: ...
```

Cancel API 只写入取消意图和 Redis Signal。

真正状态转换由 Run Worker 完成。

## 18.6 Steer

```http
POST /api/runs/{run_id}/steer
```

用于改变当前正在执行的 Run。

## 18.7 Follow-up

```http
POST /api/conversations/{conversation_id}/follow-ups
```

用于当前 Run 完成后执行的新用户请求。

---

# 19. 前端完整重构

后端增加任何能力时，必须同步增加前端状态、组件和交互，不允许出现“后端已实现但 UI 不可见”。

## 19.1 目标结构

```text
frontend/src/
  app/
    router/
    providers/
    stores/

  entities/
    conversation/
    message/
    run/
    tool-execution/
    process/
    dataset/
    artifact/
    approval/
    trace/

  features/
    conversation-list/
    send-message/
    cancel-run/
    steer-run/
    follow-up/
    upload-dataset/
    download-artifact/
    resolve-approval/
    inspect-trace/

  widgets/
    conversation-sidebar/
    chat-timeline/
    run-status-bar/
    tool-call-panel/
    process-panel/
    dataset-panel/
    artifact-panel/
    approval-panel/
    trace-panel/
    agent-api-panel/

  pages/
    chat/
    agent-management/
    run-details/
    trace-details/
    a2a-access/
```

## 19.2 前端状态源

前端状态必须可以完全通过以下内容重建：

```text
Conversation Snapshot
Messages
Run Snapshot
Ordered Run Events
Datasets
Artifacts
Approvals
```

实时 SSE 只是增量更新来源。

刷新页面后：

```text
1. GET Conversation
2. GET Messages
3. GET active/recent Runs
4. GET latest sequence
5. 建立 SSE from latest sequence
6. reducer 重建 Tool、Process、Artifact 等 UI
```

不得只从当前 SSE 连接维护 Tool 状态。

## 19.3 Event Reducer

建立统一 Reducer：

```typescript
reducePlatformEvent(state, event)
```

负责把事件投影为：

* Assistant Streaming Message。
* Tool Card。
* Process Card。
* Run Status。
* Approval Card。
* Artifact。
* Dataset Status。
* Error Banner。

Live Event 和 Historical Event 必须走同一个 Reducer。

## 19.4 Chat Timeline

时间线应统一呈现：

```text
User Message
Assistant Thinking/Progress
Tool Call
Tool Result
Process Progress
Approval Request
Assistant Final Message
Artifact
Error
```

## 19.5 Tool Call Panel

显示：

* Tool 名称。
* 来源：Sandbox / MCP / Internal。
* 参数摘要。
* 状态。
* 开始时间。
* 耗时。
* 输出摘要。
* 错误。
* Trace Link。

敏感参数必须由后端脱敏后再返回。

## 19.6 Process Panel

显示：

* Command。
* 状态。
* 已运行时间。
* 实时 stdout/stderr。
* Cursor。
* Exit Code。
* Stop 按钮。
* 下载完整日志。
* 关联输出文件。

## 19.7 Dataset Panel

显示：

* 文件名。
* 上传进度。
* 文件大小。
* 校验状态。
* Workspace 相对路径。
* 上传时间。
* 删除或替换操作。
* 当前 Agent 是否可见。

## 19.8 Artifact Panel

Artifact 是“交付物”而不是普通 Workspace 文件。

显示：

* 文件名称。
* 类型。
* 大小。
* 生成 Run。
* 创建时间。
* 下载。
* SHA-256。
* 描述。

## 19.9 Approval Panel

只在外部高风险操作出现。

显示：

* Tool。
* 操作摘要。
* 风险说明。
* 参数摘要。
* 请求时间。
* 过期时间。
* Approve。
* Deny。
* 决策理由。

禁止再为普通 Bash 连续弹出 Approval。

## 19.10 Trace Panel

显示树形调用链：

```text
Run
  Model Call
  Tool Call
    Sandbox Execution
  MCP Call
  Artifact Submit
```

显示：

* trace_id。
* span_id。
* duration。
* status。
* token。
* cost。
* error。
* org_id/user_id。
* Tool/Model metadata。

## 19.11 A2A/API Panel

Agent 创建后，管理页需要展示：

* Agent ID。
* Agent Version。
* Agent Card 地址。
* A2A Endpoint。
* Streaming 是否启用。
* 鉴权方式。
* API Credential 管理入口。
* 示例调用。
* 最近 A2A Task。
* 调用审计。

---

# 20. A2A + SSE 设计

A2A 必须按照协议语义实现，而不是把现有聊天 SSE 接口改名为 A2A。

A2A 官方协议支持 Agent Card、任务、消息、Artifact、流式任务更新和任务重新订阅；流式方法返回 `text/event-stream`，事件承载 JSON-RPC 响应。

## 20.1 Agent Card

提供：

```http
GET /.well-known/agent-card.json
```

或 Agent 级：

```http
GET /a2a/agents/{agent_id}/.well-known/agent-card.json
```

示例：

```json
{
  "name": "Enterprise Analysis Agent",
  "description": "Enterprise data analysis agent",
  "url": "https://host/a2a/agents/01...",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true
  },
  "defaultInputModes": [
    "text"
  ],
  "defaultOutputModes": [
    "text",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ],
  "skills": []
}
```

## 20.2 JSON-RPC Endpoint

```http
POST /a2a/agents/{agent_id}
```

支持：

```text
SendMessage
SendStreamingMessage
GetTask
CancelTask
SubscribeToTask
```

## 20.3 SendStreamingMessage

响应：

```http
Content-Type: text/event-stream
```

每个 SSE data 为 JSON-RPC 2.0 Response。

可能包含：

```text
Task
TaskStatusUpdateEvent
TaskArtifactUpdateEvent
```

## 20.4 内部映射

```text
A2A Task
  → Conversation or External Conversation Mapping
  → Agent Session
  → Run
```

映射表：

| Internal Run       | A2A Task                           |
| ------------------ | ---------------------------------- |
| ACCEPTED / QUEUED  | submitted                          |
| STARTING / RUNNING | working                            |
| WAITING_INPUT      | input-required                     |
| WAITING_APPROVAL   | auth-required 或 working + metadata |
| SUCCEEDED          | completed                          |
| FAILED             | failed                             |
| CANCELLED          | canceled                           |

## 20.5 Artifact 映射

内部：

```text
artifact.ready
```

投影为：

```text
TaskArtifactUpdateEvent
```

Artifact 可包含：

* Text Part。
* File Part。
* Data Part。

下载凭证必须短期有效，并限制到调用方 Organization 和 A2A Client。

## 20.6 重连

调用方断连后：

```text
SubscribeToTask(task_id)
```

服务端从 MySQL `a2a_task_events` 或内部 Run Event 投影恢复。

A2A 调用方断开不能取消内部 Run。

## 20.7 A2A 鉴权

一期支持：

```text
Bearer API Credential
```

Credential 绑定：

```text
org_id
agent_id
client_id
scopes
expires_at
```

Scopes：

```text
agent.invoke
agent.read
agent.cancel
artifact.read
```

API Key 只能存储哈希。

后续可扩展 OAuth2 Client Credentials。

## 20.8 A2A Trace

A2A Request 必须产生：

```text
caller_type = a2a
caller_id = client_id
org_id = credential org
trace_id = incoming trace or generated trace
```

External Task ID、Internal Run ID 和 Trace ID 必须可关联审计。

---

# 21. MCP 配置设计

Agent Version 中保存 MCP Server 的逻辑引用，不直接保存明文 Secret。

```json
{
  "mcpServers": [
    {
      "serverId": "db-risk-readonly",
      "enabledTools": [
        "query",
        "describe_table"
      ],
      "toolPolicy": {
        "default": "allow"
      }
    }
  ]
}
```

运行时：

```text
MCP Config Loader
  → Secret Provider
  → pi-mcp-adapter
  → Tool Registration
```

## 21.1 MCP Tool 命名

避免不同 Server 工具冲突：

```text
mcp__{server_name}__{tool_name}
```

示例：

```text
mcp__risk_db__query
mcp__knowledge__search
```

## 21.2 MCP 审计

记录：

* Server。
* Tool。
* 参数脱敏摘要。
* 返回行数。
* 返回大小。
* 耗时。
* 错误。
* trace_id。
* org_id。
* user_id。
* run_id。

## 21.3 MCP Timeout

每个 Tool 单独配置。

建议：

```text
Default: 60 秒
DB query: 120 秒
Maximum: 300 秒
```

禁止无限等待。

---

# 22. Skill 设计

Skill 保持 Pi 原生形式：

```text
skills/
  data-analysis/
    SKILL.md
    scripts/
    references/
    assets/
```

## 22.1 SKILL.md

给模型看的能力说明。

包括：

* 适用场景。
* 工作流程。
* 文件约定。
* 脚本使用方法。
* 结果验证方法。
* Artifact 交付规则。

## 22.2 企业 Metadata

可选：

```text
skill.meta.yaml
```

内容：

```yaml
name: data-analysis
version: 1.2.0
riskLevel: medium

runtime:
  python: "3.11"

permissions:
  network: false
  workspace: read-write
  skillRoot: read-only

dependencies:
  image: sandbox-runtime@sha256:...

outputs:
  artifactPatterns:
    - "output/*.xlsx"
    - "output/*.pdf"
```

`SKILL.md` 是 Pi 能力说明。

`skill.meta.yaml` 是企业治理信息。

不强制把所有 Skill 封装成 `run_skill(input_schema)`。

---

# 23. 现有代码迁移映射

## 23.1 Agent

### `agent/application/run-manager.js`

当前职责过多，应删除原实现并拆分为：

```text
CreateRunService
ExecuteRunService
CancelRunService
RunRepository
RunQueue
RunEventRepository
LeaseManager
```

禁止保留进程内 Run Map 作为主状态。

### `agent/runtime/agent-runtime.js`

拆分为：

```text
PiRuntimeFactory
PiSessionAdapter
RunExecutor
PromptContextBuilder
EventProjector
```

文件不应继续包含全部 Agent Runtime、工具、事件、Session、Policy 和持久化逻辑。

### `agent/runtime/extension-host-adapter.js`

优先替换为 Pi 原生 Extension 加载方式。

只保留无法由 Pi 官方 Loader 解决的最小适配层。

不得继续形成第二套 Extension Host。

### `agent/runtime/extension-package-loader.js`

检查是否与 Pi Package/Resource Loader 重复。

重复则删除。

企业治理部分移动到：

```text
PackageGovernanceService
```

但不重写包发现和加载机制。

### `agent/runtime/event-bridge.js`

保留“Pi Event → Platform Event”的概念，但改造成纯 Event Projector。

不得直接维护进程内 SSE Subscriber。

### `agent/services/session-persistence.js`

替换为：

```text
AgentSessionRepository
MessageRepository
PiSessionSnapshotRepository
```

MySQL 是事实源。

### `agent/services/approval-waiter.js`

删除 Sandbox 普通命令审批逻辑。

只保留外部高风险 Tool 的 Approval Coordination。

### `agent/services/interaction-waiter.js`

明确只用于：

* 用户补充输入。
* 外部审批。
* 必须的人工选择。

不能作为普遍阻塞 Agent Worker 的进程内 Promise。

应通过持久化状态和 Signal 恢复。

### `agent/services/sdk-sse-map.js`

改为：

```text
PlatformEventProjector
```

SSE DTO 投影放在 BFF Presentation 层。

## 23.2 API Server

### `api-server/services/agent-client.js`

保留并重写为有类型的 Internal Agent Client。

支持：

* Timeout。
* Retry。
* Trace。
* Idempotency。
* Error Mapping。

### `api-server/services/sandbox-client.js`

删除其对 Run 编排和 Workspace 业务操作的直接使用。

仅 Dataset 流式上传场景可以保留专用：

```text
SandboxUploadClient
```

普通文件和执行由 Agent Extension 调 Sandbox。

### Routes

将现有路由整理为资源导向 API：

```text
conversations
messages
runs
events
datasets
artifacts
approvals
traces
agents
```

禁止多个路由分别解析和创建 Session。

## 23.3 Frontend

现有 Chat 实时事件处理改为：

```text
Snapshot Query
+ Historical Event Replay
+ Live SSE
+ Unified Reducer
```

所有 Tool、Process、Artifact 状态必须可在刷新后恢复。

## 23.4 Sandbox

### `database.py` / `repositories.py`

移除 SQLite/PostgreSQL 双分支。

统一 MySQL。

不要在一个 Repository 文件中容纳全部领域。

拆分：

```text
session_repository
execution_repository
process_repository
dataset_repository
artifact_repository
audit_repository
```

### Workspace Global Symlink

删除任何进程全局：

```text
/sandbox/workspace → current session path
```

改为每个 Execution 独立 mount namespace。

### 自研 MCP Server

如果当前 Sandbox 仍对外暴露通用 MCP，需评估是否还有真实调用方。

本方案中：

* Agent 内部不通过 MCP 调 Sandbox。
* 外部智能体通过 A2A 调 Agent。
* 外部业务系统能力通过企业 MCP 接入 Agent。

因此 Sandbox 自研 MCP Server 默认删除。

只有存在明确“低代码平台直接调用 Sandbox”的独立产品需求时，才作为独立组件维护，且不能混入本次 Agent Runtime 主链路。

---

# 24. 推荐 Codex 实施顺序

每个阶段必须形成独立、可测试的 Pull Request。不要一次性修改全部代码。

## PR-01：架构契约与依赖整理

内容：

* 增加目标目录骨架。
* 固定 Node、Python、Pi SDK 版本。
* 增加共享 TypeScript Domain Types。
* 增加 Error Code 规范。
* 增加 Event Schema。
* 增加 Request Context。
* 删除废弃依赖。
* 不改变业务行为。

验收：

* 全部项目可构建。
* 旧测试仍通过或被明确替换。
* 无循环依赖。

## PR-02：MySQL Schema 和 Repository

内容：

* 引入迁移工具。
* 创建核心表。
* 建立事务管理。
* 建立 Repository。
* 删除 SQLite 默认路径。
* 增加 MySQL Integration Test。

验收：

* 可从空数据库迁移。
* 可完整回滚开发迁移。
* Foreign Key 生效。
* Message 为 append-only。
* Run Event sequence 无并发冲突。

## PR-03：Redis、BullMQ 和 Outbox

内容：

* Redis Client。
* BullMQ Run Queue。
* Lease。
* Redis Stream。
* Outbox Publisher。
* Cancel Signal。

验收：

* MySQL 提交后事件不会丢失。
* Redis 暂停后 Outbox 可重试。
* Worker 重启后 Job 可恢复。
* Redis 清空不影响 MySQL 事实。

## PR-04：Run Manager 拆分

内容：

* 删除进程内 Run 权威状态。
* 实现 Create/Execute/Cancel Run Service。
* Run 创建先持久化后返回。
* Worker 与 HTTP Server 分离。

验收：

* 创建后立即 GET Run 不返回 404。
* Browser 断连 Run 继续。
* Agent Service 重启后能识别未完成 Run。
* Duplicate Submit 不创建重复 Run。

## PR-05：Pi Runtime Factory 和 Session 恢复

内容：

* 使用 Pi SDK Factory。
* Agent Version 固定配置。
* Pi Snapshot。
* Message + Event Journal。
* Session Lock。
* Compaction 保存。

验收：

* 多轮会话复用 Session。
* 重启后历史消息存在。
* Tool Call 和 Tool Result 不丢失。
* Agent Version 更新不影响旧 Run。

## PR-06：三类 Extension

内容：

* `sandbox-bridge`。
* `enterprise-policy`。
* `observability`。
* 删除重复 Extension Host 逻辑。
* 接入 `pi-mcp-adapter`。

验收：

* Pi 默认 read/write/edit/bash 走 Sandbox。
* MCP 不走 Sandbox。
* 普通 Bash 无审批。
* 高风险外部 Tool 可以请求审批。
* 每次 Tool Call 有 Trace 和审计。

## PR-07：Sandbox Workspace 和 Isolation

内容：

* Session Workspace。
* Stable Logical Paths。
* Bubblewrap。
* Path Resolver。
* Resource Limit。
* Network Policy。
* 删除全局 Workspace Symlink。

验收：

* 两个并发 Session 不能互读。
* Skill 目录不可写。
* Path Traversal 被拒绝。
* Symlink Escape 被拒绝。
* 命令无法看到其他 Session 进程和文件。

## PR-08：Python 和 Process Handle

内容：

* Python Tool。
* 多行脚本自动物化。
* Process Start/Status/Read/Kill。
* stdout/stderr Cursor。
* 进程超时和恢复。

验收：

* 长任务不占用普通 HTTP。
* Agent 可轮询 Process。
* Process 输出可增量读取。
* Cancel Run 能终止关联进程。
* 服务重启后可识别孤儿进程。

## PR-09：Dataset 和 Artifact

内容：

* Dataset 流式上传。
* Workspace 直接落盘。
* SHA-256。
* Quota。
* Artifact Submit。
* Artifact Download。

验收：

* 大文件上传不导致 BFF 内存等量增长。
* 上传失败不留下 Ready 文件。
* write 不产生下载项。
* submit_artifact 才产生 Artifact。
* Artifact Ownership 校验有效。

## PR-10：BFF API 与 SSE Replay

内容：

* REST API 重构。
* Idempotency。
* Ownership。
* Historical Replay。
* Redis Live Stream。
* Last-Event-ID。
* Heartbeat。

验收：

* SSE 重连无事件丢失。
* 无重复 UI 事件。
* 跨用户访问返回 404 或 403。
* 浏览器刷新后可以继续查看 Run。

## PR-11：Frontend Workbench

内容：

* Unified Event Reducer。
* Tool Card。
* Process Panel。
* Dataset Panel。
* Artifact Panel。
* Approval Panel。
* Trace Panel。
* Refresh Recovery。

验收：

* 页面刷新后 Tool Call 仍存在。
* 正在运行的 Process 能继续显示。
* Run 状态与后端一致。
* Artifact 只展示显式提交文件。
* Approval 不会对普通 Bash 弹出。

## PR-12：A2A/SSE

内容：

* Agent Card。
* JSON-RPC Endpoint。
* Streaming Message。
* Task Mapping。
* Artifact Update。
* SubscribeToTask。
* API Credential。
* A2A Audit。

验收：

* 其他 Agent 可通过 SSE 调用。
* 断连后可重新订阅 Task。
* A2A Task 与 Internal Run 状态一致。
* Artifact 可作为 A2A Event 返回。
* 不同 Client 无法查看彼此 Task。

## PR-13：删除冗余代码

内容：

* 删除旧 Run Manager。
* 删除旧 Session 双写。
* 删除旧 SQLite。
* 删除重复 MCP Client。
* 删除 Sandbox 自研 MCP 主链路。
* 删除旧 SSE Buffer。
* 删除旧 Workspace Symlink。
* 删除无调用代码。
* 更新文档。

验收：

* 无 Compatibility Layer。
* 无 Dead Code。
* 无双状态源。
* 无隐藏 Feature Flag 回退到旧路径。

## PR-14：性能、安全和恢复测试

内容：

* Load Test。
* Concurrency Test。
* Security Test。
* Restart Test。
* Redis Failure Test。
* MySQL Failure Test。
* Large File Test。
* A2A Streaming Test。

---

# 25. 测试矩阵

## 25.1 Unit Test

覆盖：

* Run 状态转换。
* Event Sequence。
* Path Resolver。
* Policy Decision。
* Event Projection。
* A2A Mapping。
* Idempotency Hash。
* Secret Redaction。
* Dataset Filename 清洗。
* Error Mapping。

## 25.2 Contract Test

覆盖：

* BFF ↔ Agent。
* Agent ↔ Sandbox。
* Agent ↔ MCP。
* Frontend ↔ BFF Event Schema。
* A2A JSON-RPC。
* SSE Event。

Contract 建议使用 JSON Schema 或 Zod Schema 自动验证。

## 25.3 Integration Test

使用真实：

* MySQL。
* Redis。
* Agent Worker。
* Sandbox。
* Mock LLM Provider。
* Mock MCP Server。

不得只 Mock Repository。

## 25.4 End-to-End Test

场景：

1. 创建 Conversation。
2. 上传 Dataset。
3. 发起 Run。
4. Agent 读取 Dataset。
5. Python 生成报告。
6. 提交 Artifact。
7. 前端收到完整事件。
8. 刷新页面。
9. Tool 和 Artifact 仍可见。
10. 下载 Artifact。

## 25.5 Recovery Test

必须覆盖：

* Worker 在 Model Call 后退出。
* Worker 在 Tool Proposal 后退出。
* Sandbox 命令执行中断。
* Redis 重启。
* Agent Service 重启。
* BFF 重启。
* 浏览器断开。
* SSE Cursor 重连。
* Outbox 发布失败。
* Process 成为孤儿。

## 25.6 Concurrency Test

必须覆盖：

* 同一用户多个 Conversation。
* 同一 Conversation 快速重复提交。
* 不同用户并发。
* 不同 Organization 并发。
* 两个 Session 同时写同名相对路径。
* 一个 Session 试图访问另一个 Session。
* Run Event 并发写入。
* 同一 Approval 重复决策。

## 25.7 Security Test

覆盖：

```text
../../ escape
absolute path
symlink escape
null byte
command timeout
fork bomb
large stdout
large stderr
memory exhaustion
workspace quota
secret log leakage
cross-tenant ID fuzzing
expired internal token
forged org_id header
MCP SQL write
Artifact ownership bypass
A2A Task enumeration
```

## 25.8 Performance Test

至少验证：

```text
100 个并发 SSE
50 个并发 Run
20 个并发 Sandbox Execution
5 GB Dataset streaming
10000 条 Run Event replay
100 个并发 A2A Task
```

具体生产目标根据环境再调整，但测试框架必须建立。

---

# 26. 错误规范

统一错误响应：

```json
{
  "error": {
    "code": "RUN_NOT_FOUND",
    "message": "The requested run was not found.",
    "requestId": "01...",
    "traceId": "..."
  }
}
```

错误码分类：

```text
AUTH_*
TENANT_*
CONVERSATION_*
SESSION_*
RUN_*
TOOL_*
SANDBOX_*
PROCESS_*
DATASET_*
ARTIFACT_*
MCP_*
APPROVAL_*
A2A_*
INTERNAL_*
```

不得把内部 Stack Trace 返回浏览器或 A2A Client。

---

# 27. 日志与审计

## 27.1 应用日志

使用结构化 JSON。

```json
{
  "level": "info",
  "service": "agent-worker",
  "event": "tool_execution_completed",
  "org_id": "01...",
  "user_id": "01...",
  "conversation_id": "01...",
  "agent_session_id": "01...",
  "run_id": "01...",
  "tool_execution_id": "01...",
  "trace_id": "...",
  "duration_ms": 1743
}
```

## 27.2 审计日志

审计记录应覆盖：

* Login。
* Agent 配置变更。
* Run 创建和取消。
* Tool 调用。
* MCP 调用。
* Approval。
* Dataset 上传。
* Artifact 下载。
* A2A 调用。
* 权限拒绝。
* Workspace 清理。

审计日志原则上 append-only。

## 27.3 Secret Redaction

以下字段按字段名脱敏：

```text
authorization
api_key
apikey
access_token
refresh_token
password
secret
cookie
private_key
client_secret
```

随后进行正则兜底。

原始 Secret 不得进入：

* Prompt。
* Tool Result。
* Run Event。
* Frontend。
* Trace Attribute。
* stdout/stderr。
* Audit。

---

# 28. 指标

至少暴露：

```text
http_request_duration
run_queue_depth
run_queue_wait_duration
run_duration
run_status_total
active_agent_sessions
model_request_duration
model_tokens_total
model_cost_total
tool_execution_duration
tool_failure_total
sandbox_execution_duration
sandbox_active_processes
workspace_bytes
dataset_upload_bytes
sse_connections
sse_replay_events
redis_stream_lag
outbox_pending
a2a_task_total
a2a_stream_connections
```

高基数字段如 `run_id`、`user_id` 不得成为 Prometheus Label。

它们只进入 Log 和 Trace。

---

# 29. 配置规范

配置分为：

```text
Environment Configuration
Agent Version Configuration
Organization Policy
Secret Reference
```

环境变量只用于基础设施地址和启动配置。

示例：

```text
MYSQL_URL
REDIS_URL
SANDBOX_BASE_URL
INTERNAL_TOKEN_SIGNING_KEY
WORKSPACE_ROOT
SKILL_ROOT
PI_SDK_VERSION
OTEL_EXPORTER_OTLP_ENDPOINT
```

Agent Prompt、Tool Policy 和 Skill 列表不得长期写死在环境变量里。

---

# 30. 不在本次重构范围

本次不建设：

* 自研 Agent Loop。
* 自研模型 Gateway。
* 自研 MCP 协议实现。
* Temporal。
* Kubernetes 动态 Sandbox Pod。
* gVisor/Kata。
* 多 Region Active-Active。
* 通用 Cloud IDE。
* 用户任意安装未审核 Plugin。
* Workspace 对象存储快照。
* 完整企业 SSO。
* 旧 SQLite 数据自动迁移。
* 旧 API 长期兼容层。
* Trellis Task 文档更新。

这些能力可以作为后续演进，不应阻塞当前四服务架构的正确重构。

---

# 31. Codex 开发约束

Codex 执行时必须遵守：

1. 先阅读现有仓库和本设计，再修改代码。
2. 每个 PR 先定位现有调用链，不能只新增文件。
3. 后端变更必须检查前端是否需要呈现。
4. 不保留同一能力的旧实现和新实现。
5. 不为了兼容旧数据引入长期分支。
6. 优先使用 Pi 原生 SDK、Extension、Package 和 Skill。
7. 优先使用成熟库：

   * BullMQ。
   * MySQL Driver/ORM。
   * Redis Client。
   * OpenTelemetry。
   * Zod。
   * FastAPI/Pydantic。
   * Bubblewrap。
8. 不重新开发现成轮子。
9. 所有外部 API 必须有 Schema。
10. 所有创建操作必须考虑 Idempotency。
11. 所有资源查询必须校验 `org_id` 和 `user_id`。
12. 所有 Run Event 必须可持久化和重放。
13. 任何长任务都不得依赖浏览器连接生命周期。
14. 任何文件路径都必须通过统一 Path Resolver。
15. 任何 Secret 都不得交给 Agent 模型。
16. 每个阶段必须补充测试。
17. 删除代码前使用静态搜索确认调用关系。
18. 禁止通过空 catch、无限重试或静默 fallback 掩盖错误。
19. 禁止在生产默认配置中使用 SQLite、内存 Store 或无鉴权内部接口。
20. 不更新 `.trellis` 目录中的任务文档。

---

# 32. 最终验收标准

只有全部满足以下条件，重构才算完成。

## Agent Runtime

* 使用 Pi 原生 Agent Loop。
* 三类企业 Extension 正常加载。
* MCP 通过 `pi-mcp-adapter`。
* 多轮 Session 可恢复。
* Agent Version 固定。

## State

* MySQL 是唯一事实源。
* Redis 只保存运行态。
* 不存在进程内权威 Run Map。
* 不存在 Conversation 整体消息 JSON。
* 不存在双 Run 状态源。
* Run Event 可顺序重放。

## Sandbox

* Session 和 Workspace 一一对应。
* Agent 路径稳定。
* 无全局可变 Workspace Symlink。
* 并发 Session 隔离。
* 普通命令无需审批。
* Python 多行代码自动物化。
* 长任务使用 Process Handle。
* Dataset 直接流式写入 Workspace。

## Frontend

* 刷新后消息、Tool、Process、Artifact 均可恢复。
* 能显示 Run 状态。
* 能取消 Run。
* 能上传 Dataset。
* 能查看 Process 输出。
* 能处理企业审批。
* 能查看 Trace。
* 能查看 Agent A2A 配置。

## Artifact

* write/edit 不自动产生下载项。
* 只有 submit_artifact 产生 Artifact。
* Artifact 下载受租户和用户权限控制。

## A2A

* Agent Card 可访问。
* 支持 Streaming。
* 支持任务查询、取消和重新订阅。
* A2A Task 与内部 Run 正确映射。
* A2A SSE 断连不会取消 Run。
* org_id、client_id 和 trace_id 全程可审计。

## Reliability

* 浏览器断连 Run 继续。
* Agent Worker 重启可恢复。
* Redis 短暂故障不丢失事实事件。
* Duplicate Request 不产生重复副作用。
* Run 创建后立即查询不会出现持久化竞态。

## Security

* 跨租户访问被阻止。
* Workspace Path Escape 被阻止。
* Skill 目录不可写。
* Sandbox 不具备特权能力。
* Secret 不进入模型、日志和事件。
* 数据库业务访问只能通过受控 MCP。

---

# 33. 最终目标形态

重构后的系统职责应清晰收敛为：

```text
Frontend
  = 企业 Agent 工作台和事件投影 UI

BFF
  = 身份、租户、API、SSE Replay 和文件交付入口

Agent Service
  = Pi Runtime + Run Worker + Session + Extension + MCP + A2A

Sandbox
  = 隔离 Workspace + 文件 + 执行 + Process + Dataset

MySQL
  = 持久化事实和审计

Redis
  = Queue + Lease + Stream + Signal

Pi Extension
  = 企业能力与 Pi 原生 Runtime 的唯一集成边界

A2A
  = 其他智能体调用当前 Agent 的标准协议出口
```

本次工作的核心不是增加更多自研框架，而是删除重复实现，使 Pi、MySQL、Redis、Sandbox、MCP、前端和 A2A 各自只承担一种明确职责。
