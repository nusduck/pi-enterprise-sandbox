# Pi Enterprise Sandbox

> 企业沙箱 + AI 智能体 · v4.0

五个进程、四份镜像：前端 SPA + 薄 BFF API Server + 独立 Node Agent + TypeScript 执行面（compose 名 `sandbox`）+ 同一镜像的 MCP facade（`sandbox-mcp`）。Agent 运行在独立服务中，浏览器零接触 LLM API Key 和工具执行细节。

## 快速启动

```bash
# 1. 配置
cp .env.example .env
vi .env  # 填入 LLMIO_BASE_URL 和 LLMIO_API_KEY

# 2. 构建并启动（开发模式）
docker compose up --build -d

# 3. 访问
open http://localhost:3000
```

## 架构

```
  Browser → Frontend → API Server → Agent (DSH) → Exec HMAC API
                                          │
外部 MCP 客户端 ──────────────────→ sandbox-mcp ──窄桥──→ Exec
```

| 组件 | 技术栈 | host→容器端口 |
|------|--------|---------------|
| **Frontend** | Vite + React → Nginx | `3000→80` |
| **API Server (BFF)** | Node.js 22 — auth / files / SSE relay | `4000→4000` |
| **Agent** | Node.js 22 + DeepSeek Harness（`@deepseek-ai/dsh-*`）| `4100→4100` |
| **Sandbox（执行面）** | Node.js 22 + TypeScript + Bubblewrap | 仅 Docker 内网 `8081`，不发布宿主端口 |
| **Sandbox MCP facade** | 同一镜像的第二入口 | 开发期回环 `8082`；生产由边缘代理 |

运行时版本钉（Node 22 / Python 3.11 / DSH `0.1.1-rc.2`）见根目录 `runtime-versions.json`，由 `tests/test_runtime_versions.py` 校验。

> Python 3.11 现在只有一个用途：**沙箱镜像里给模型执行代码用的解释器与运行库**
> （`exec/requirements.txt`）。服务代码已全部是 TypeScript。

## 目录结构

```
pi-sandbox/
├── frontend/             ← SPA 前端（Vite + React；纯 UI，零 Agent SDK）
│   ├── src/main.tsx      ← 前端入口
│   ├── Dockerfile        ← Nginx 静态服务
│   └── nginx.conf        ← /api/* 反向代理到 api-server
├── api-server/           ← 薄 BFF（auth / files / SSE relay）
│   ├── server.ts         ← HTTP 入口（Run API、SSE、health，容器跑 dist/server.js）
│   ├── src/routes/       ← runs, files, status, conversations, capabilities...
│   ├── src/services/     ← sandbox-client + agent-client
│   └── Dockerfile
├── agent/                ← 独立 Agent（DeepSeek Harness，TypeScript）
│   ├── server.ts         ← 内部 Run API / health（容器跑 dist/server.js）
│   ├── worker.ts         ← BullMQ worker
│   ├── src/application/  ← Run、Session、审批、A2A 应用服务
│   ├── src/infrastructure/dsh/ ← 与组合层的接线
│   ├── src/runtime/      ← DSH 组合层（provider / policy / projection）
│   │                        agent 私有，不是独立服务
│   └── Dockerfile
├── contract/             ← @pi/contract：exec ↔ agent runtime 的 RPC 信封、HMAC、错误码
├── exec/                 ← 执行面 + MCP facade（TypeScript，取代原 Python sandbox/）
│   ├── src/main.ts       ← 执行面入口（compose: sandbox）
│   ├── src/mcp-main.ts   ← MCP facade 入口（compose: sandbox-mcp，同镜像不同入口）
│   ├── src/isolation/    ← Bubblewrap profile 建模为数据 + 单一 render()
│   ├── src/fs/ shell/ search/ workspace/  ← 文件、命令与作业、搜索、工作区与配额
│   ├── src/artifact/ dataset/ attachment/ ← 产物（控制面快照）、数据集、附件
│   ├── src/http/         ← internal（HMAC）、internal-mcp（窄桥）、public（BFF 契约）
│   ├── requirements.txt  ← 镜像里给**模型执行代码**用的 Python 运行库
│   └── Dockerfile        ← 服务 + 模型工具链（python3/chromium/LibreOffice/bun…）
├── skills/               ← 可选系统 Skill 挂载（非硬依赖；AgentVersion allowlist + capabilities 控制模型可见性）
├── tests/                ← pytest：仓库卫生（结构棘轮、版本钉、compose 安全、SSE 夹具）
├── scripts/              ← 备份/恢复、development reset、跨服务 smoke
├── nginx/                ← 生产 Nginx + SSL
├── docs/                 ← 活跃文档（见 docs/README.md 权威顺序）
├── .runtime/             ← 全部宿主机运行态（Git/Docker build 均忽略）
│   ├── sandbox/          ← workspaces、tmp、artifacts、control
│   └── …                 ← smoke / release-gate 等按需创建的临时状态
├── docker-compose.yml           ← 开发编排（Frontend + BFF + Agent + Sandbox + MCP + MySQL 8 + Redis 7）
├── docker-compose.prod.yml      ← 生产 overlay（MySQL 8 + Redis 7 + Nginx + SSL）
└── .env.example          ← 环境变量模板（与部署文档一致）
```

## 环境变量

### 必需

| 变量 | 说明 |
|------|------|
| `LLMIO_BASE_URL` | LLM API 基地址（OpenAI 兼容） |
| `LLMIO_API_KEY` | LLM API 密钥 |

### 推荐

| 变量 | 说明 |
|------|------|
| `SANDBOX_API_TOKEN` | Sandbox API 认证令牌（生成: `openssl rand -hex 32`） |
| `MCP_SERVERS_JSON` | Agent Runtime 外部 MCP Server 配置（凭据使用 `authTokenRef`） |
| `AGENT_BASE_URL` | BFF → Agent 服务地址（compose 内默认 `http://agent:4100`） |
| `AGENT_INTERNAL_TOKEN` | BFF ↔ Agent 共享内部令牌（生产必填） |
| `AGENT_RUN_INIT_TIMEOUT_MS` | `15000` 默认；Durable Sandbox run 初始化超时（1000–60000 毫秒，超时返回 504） |

### Agent 服务

浏览器走 `POST /api/runs` 并通过 `GET /api/runs/:id/events` 接收序列化 SSE；编排与 SDK 循环只在 `agent/` 服务中。

```bash
# 本地四进程开发时
AGENT_BASE_URL=http://localhost:4100
SANDBOX_BASE_URL=http://localhost:8081
```

`GET /health/live` 检查 BFF 进程，`GET /health/ready` 聚合 Agent/Sandbox readiness；`GET /api/status` 保留为 UI 状态视图。Python Agent Runtime 与 `AGENT_RUNTIME` 开关已删除。

### 认证与管理员

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AUTH_ENABLED`（旧别名 `SANDBOX_AUTH_ENABLED`） | `false` | BFF 经 Agent 验证 JWT 后投影可信 owner；跨租户统一 404。exec 不读取浏览器 JWT |
| `SANDBOX_JWT_SECRET` | _(空)_ | Agent 的浏览器 JWT 签名密钥；生产必须是强密钥 |
| `SANDBOX_AUTH_ALLOW_PUBLIC_REGISTER` | `true` | Agent 公开自注册；生产必须 `false`（管理员预置 / 邀请制） |
| `SANDBOX_AUTH_ADMIN_USERNAMES` | _(空)_ | 管理员用户名白名单，逗号分隔、大小写不敏感 |

`SANDBOX_AUTH_ADMIN_USERNAMES` 是 admin 角色的**唯一**来源。注册接口忽略客户端提交的
`role` 与 `organization_id`，所以没有这份名单就永远产生不出第一个管理员，
`/api/a2a/config` 等管理面会一直 403 `ADMIN_REQUIRED`。名单内的用户名注册即为 admin；
已存在的账号在下次 login 或 `/auth/me` 时提升，从名单移除则降级回 user。

`BFF_DEV_ACTING_ROLE` 只对 `AUTH_ENABLED=false` 的开发身份生效，不会提升真实用户。

### 执行限制

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_EXECUTION_TIMEOUT_SECONDS` | `120` | 单次命令超时 |
| `SANDBOX_MAX_OUTPUT_CHARS` | `50000` | stdout/stderr 上限 |
| `SANDBOX_MAX_PROCESS_COUNT` | `20` | 最大子进程数 |
| `SANDBOX_MAX_OPEN_FILES` | `256` | 子进程最大打开文件描述符数（RLIMIT_NOFILE） |
| `SANDBOX_MAX_CPU_TIME_SECONDS` | `300` | CPU 时间上限 |
| `SANDBOX_MAX_MEMORY_MB` | `512` | 内存上限 |
| `SANDBOX_MAX_FILE_SIZE_MB` | `50` | 单文件大小上限 |
| `SANDBOX_WORKSPACE_QUOTA_MB` | `500` | 工作区总空间上限 |
| `SANDBOX_TEMP_QUOTA_MB` | `500` | Agent Session 私有持久化 `/tmp` 空间上限 |
| `SANDBOX_SHARED_ENV_KEYS` | _(空)_ | 逗号分隔；从 sandbox 进程 env 注入到每次 bash/python/node/process 子进程 |
| `SANDBOX_EXEC_ENV_<NAME>` | — | 显式 opt-in：子进程得到 `NAME=value`（推荐） |

共享执行 env 不会继承全部服务环境；平台 token、JWT、服务密码等硬拒绝。明确 allowlist
的业务 DB 变量仍可供子进程使用，但通过受控的 spawn 环境传入，不进入 Bubblewrap
命令行；单次 `env_overrides` 优先。

### 会话与工作区清理

Sandbox **不再**按空闲 TTL 后台清会话/工作区（旧 `SANDBOX_SESSION_TTL_*` /
`SANDBOX_CLEANUP_INTERVAL_*` / draft·conversation·audit TTL 配置已移除，设置了也会被忽略）。

工作区磁盘回收路径：用户删除/归档 **conversation** → Agent fail-soft 调用
`DELETE /sessions/{sandbox_session_id}` → 删除物理 workspace + 配对 temp。

### 网络策略（入站 vs 出站分离）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_NETWORK_MODE` | `disabled` | **出站执行策略**：`disabled`（Bubblewrap `--unshare-net`，生产唯一允许）/ `allowlist`（无受控 egress proxy 时不构成隔离，生产拒绝）/ `unrestricted`（仅研发显式） |
| `SANDBOX_ALLOWED_CLIENT_CIDRS` | loopback + 私网 | **入站** Sandbox HTTP 来源 CIDR；空 = 拒绝全部 |
| `SANDBOX_TRUSTED_PROXY_CIDRS` | _(空)_ | 可信反向代理；默认忽略 `X-Forwarded-For` |

Compose：`backend_internal`（`internal: true`）与 `service_egress`；Sandbox 仅挂 `backend_internal`，无 `NET_ADMIN`/`NET_RAW`，不使用 container-wide iptables。

### 数据库（MySQL 8）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AGENT_DATABASE_URL` | `mysql://sandbox:…@mysql:3306/sandbox` | Agent 事实库 DSN（`mysql://` / `mysql2://`） |
| `SANDBOX_DATABASE_URL` | `mysql+pymysql://sandbox:…@mysql:3306/sandbox` | Sandbox 持久化 DSN |
| `SANDBOX_COMPOSE_DATABASE_URL` | 未设置（默认 MySQL compose DSN） | 仅开发 Compose 的显式 Sandbox DSN override；避免旧 `.env` 的 `SANDBOX_DATABASE_URL` 覆盖正式默认 |
| `MYSQL_PASSWORD` | 开发占位；生产无默认 | 生产必填强 secret |
| `MYSQL_ROOT_PASSWORD` | 开发占位；生产无默认 | 生产必填强 secret |

**dev/prod 唯一正式拓扑为 MySQL 8**；生产配置校验拒绝 SQLite / PostgreSQL。凭据一律来自环境变量，勿硬编码真实密钥。研发清库见 [docs/runbooks/development-reset.md](docs/runbooks/development-reset.md)。

Compose 由一次性 `agent-migrate` 服务独占 Knex migration；`sandbox`、
`agent`、`agent-worker` 只在 migration 成功退出后启动，长期进程自身不再执行 migration。

### Redis 7（Agent-only 运行态协调）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `AGENT_REDIS_URL` / `REDIS_URL` | `redis://:…@redis:6379/0` | Agent 协调 DSN（仅 `redis://` / `rediss://`） |
| `TEST_REDIS_URL` | _(可选)_ | 集成测试用 Redis DSN |
| `REDIS_PASSWORD` | 开发占位；生产无默认 | 生产必填强 secret（fail-fast） |
| `AGENT_RUNS_QUEUE_NAME` | `agent-runs` | BullMQ Run Queue 名 |
| `AGENT_RUN_LEASE_TTL_MS` | `30000` | Worker lease TTL |
| `AGENT_RUN_LEASE_RENEW_INTERVAL_MS` | `10000` | Lease 续约间隔 |
| `AGENT_RUN_STREAM_MAXLEN` | `10000` | Run stream 近似保留长度 |
| `AGENT_CRON_SCHEDULER_INTERVAL_MS` | `30000` | Agent Worker 扫描到期 Cron Job 的间隔（最低 10 秒） |
| `AGENT_CRON_CLAIM_RETRY_MS` | `120000` | 崩溃后重新处理已认领但未创建 Run 的任务等待时间 |
| `AGENT_CRON_BATCH_SIZE` | `25` | 每个调度周期最多认领的任务数（1–200） |

Redis 只保存队列、lease、stream、取消信号等运行态；**不是** Run 事实权威。清空 Redis 不删除 MySQL 中的 Conversation/Run/审计；未发布事件经 Outbox 重试，历史可从 MySQL `run_events` 重放。Agent 依赖 Redis health；BFF / Sandbox 不持有 Redis 权威配置。生产须设置 `REDIS_PASSWORD`。

### Cron Job

`/schedules` 用于创建、启停、编辑、立即执行和查看历史。Cron 定义与执行记录存放在 Agent MySQL；`agent-worker` 扫描到期记录并以 `source=cron` 创建标准 Agent Run。浏览器只负责控制面，关闭页面不会影响任务。表达式使用五字段 Cron（最小一分钟），时区必须为 IANA 名称；每个计划时间以 `cron:{job_id}:{scheduled_at}` 幂等键去重。

### Skill

Agent **支持零 Skill 启动**（基础工具 read/write/edit/bash/…）。Skill 分三层
（详见 [skills/README.md](skills/README.md)）：

| 层 | 路径 | 内容 | 可见范围 | 可写 |
|----|------|------|----------|------|
| 系统 | `/home/sandbox/skill` | 本仓库 `./skills` 自带的 package | 所有人 | 否 |
| 草稿 | `/home/sandbox/skill-draft/<orgId>/<userId>` | 模型为当前用户编写的 package | 仅该用户本人；不进 prompt | 是 |
| 已启用 | `/home/sandbox/skill-user/<orgId>/<userId>` | 人工启用后从草稿复制的发布副本 | 仅该用户本人 | 否 |

每个 Run 只扫描系统层和调用者自己的已启用层；非空
`AgentVersion.configJson.skills` 可进一步收窄模型可见的 Skill。模型用普通
`write` / `bash` 修改草稿，用户在 Capabilities 页启用或停用；模型侧没有
`skill_install/create/edit/uninstall` 变更工具。启用时 Agent 校验并写
owner-scoped `user_skill_enablements`，exec 只读挂载发布副本。

### 其他

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_LOG_LEVEL` | `INFO` | 日志级别 |
| `MCP_SERVERS_JSON` | `[]` | Agent Runtime 管理的外部 MCP Server 列表 |

## 开发

完整干净安装与验证命令见 [docs/development.md](docs/development.md)。摘要：

```bash
# 依赖（从仓库根目录；Node 22）
uv sync --extra test          # 只为跑 tests/ 的仓库卫生检查
npm ci --prefix contract
npm ci --prefix exec
npm ci --prefix api-server
npm ci --prefix agent
npm ci --prefix frontend

# 本地进程（执行面裸跑需要 Linux：Bubblewrap 要非特权 user namespace）
npm run build --prefix contract && npm run build --prefix exec && node exec/dist/main.js
SANDBOX_BASE_URL=http://localhost:8081 npm run dev --prefix agent
SANDBOX_BASE_URL=http://localhost:8081 AGENT_BASE_URL=http://localhost:4100 \
  npm run dev --prefix api-server
npm run dev --prefix frontend

# 质量门禁（与 CI 对齐）
uv run pytest tests/ -q --tb=short
npm test --prefix exec && npx tsc --noEmit -p exec/tsconfig.json
npm test --prefix contract
npm test --prefix agent && npm --prefix agent run typecheck
node --test api-server/tests/*.test.js
npm test --prefix frontend && npm run build --prefix frontend
docker compose config -q
# 无真实 LLM key 的跨服务 smoke（fake OpenAI；禁止 production）
node scripts/smoke-cross-service.mjs
```

## 安全特性

| 层级 | 措施 |
|------|------|
| 进程 | 每次 Bash/Python/Node/process 经 Bubblewrap；只挂载当前 workspace、持久化 `/tmp` 和只读 Skills |
| 网络 | 生产 `network_mode=disabled` + Bubblewrap `--unshare-net`；Compose `backend_internal`；无 iptables/NET_ADMIN fail-open |
| 用户 | 子进程以非 root `sandbox` 用户运行 |
| 资源 | ulimit: CPU / 内存 / 进程数 / 文件大小 |
| 路径 | Agent Session 独占 opaque `workspace_id`；接受相对路径、逻辑 workspace 路径和 Session 私有 `/tmp`；物理路径不进入公共协议 |
| Skill | Sandbox 始终只读；仅 Agent 的审批型生命周期工具可原子写入用户 Skill 目录 |
| 命令 | 禁止 `sudo, su, rm -rf /, dd, mkfs, fdisk, chmod 777` |
| 输出 | stdout/stderr 上限截断 |
| 交付 | 仅 Artifact API / `submit_artifact` 向用户分享文件（`write` 不自动下载） |
| 审计 | 每次执行记录 trace_id + 全量日志 |
| API Key | 仅存服务端环境变量，浏览器零接触 |

## 文档

| 文档 | 说明 |
|------|------|
| [重构基线](docs/plan.md) | §32 最终验收的规范源 |
| [文档地图](docs/README.md) | 权威顺序、文档角色、更新纪律 |
| [验收状态 STATUS](docs/STATUS.md) | 相对 plan §32 的唯一进度板 |
| [过程日志](docs/PROCESS_LOG.md) | `codex/plan-acceptance` 过程记录（追加） |
| [架构设计](docs/architecture.md) | 进程边界、设计决策、安全模型、数据流 |
| [部署指南](docs/deployment.md) | 生产部署（MySQL 8 + Redis 7）、SSL、备份、监控 |
| [开发指南](docs/development.md) | 本地开发、零 Skill、测试、调试 |
| [API 参考](docs/api.md) | Sandbox API + MCP + SSE、workspace_id 契约 |
| [前端指南](docs/webui.md) | 前端 SPA 架构、SSE 消费、扩展 |
| [Development reset](docs/runbooks/development-reset.md) | 研发清库停机窗口（不可逆） |
| [Gate 证据](docs/evidence/) | 带日期的 live gate 记录 |
| [历史评审](docs/archive/reviews/) | 已归档的时点审计，不代表当前实现状态 |
| [非阻塞债](docs/review-deferred-items.md) | 不得隐藏 P0 验收项 |

以 `docs/plan.md`、`docs/STATUS.md`、活跃文档与代码为准；归档评审仅作历史参考。
