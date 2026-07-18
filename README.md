# Pi Enterprise Sandbox

> 四服务安全沙箱 + AI 编程助手 · v4.0

四服务架构：前端 SPA + 薄 BFF API Server + 独立 Node Agent + 安全沙箱执行环境。Agent 运行在独立服务中，浏览器零接触 LLM API Key 和工具执行细节。

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
  Browser → Frontend → API Server → Agent Host → Pi Extension ─┬→ Sandbox API
                                                               └→ MCP Server
```

| 组件 | 技术栈 | host→容器端口 |
|------|--------|---------------|
| **Frontend** | Vite + React → Nginx | `3000→80` |
| **API Server (BFF)** | Node.js 22 — auth / files / SSE relay | `4000→4000` |
| **Agent** | Node.js 22 + pi-coding-agent SDK `0.80.3` | `4100→4100` |
| **Sandbox API** | Python 3.11 + FastAPI | `8083→8081` |

运行时版本钉（Node 22 / Python 3.11 / Pi SDK 0.80.3）见根目录 `runtime-versions.json`，由 `tests/test_runtime_versions.py` 校验。

## 目录结构

```
pi-sandbox/
├── frontend/             ← SPA 前端（Vite + React；纯 UI，零 Agent SDK）
│   ├── src/main.tsx      ← 前端入口
│   ├── Dockerfile        ← Nginx 静态服务
│   └── nginx.conf        ← /api/* 反向代理到 api-server
├── api-server/           ← 薄 BFF（auth / files / SSE relay）
│   ├── server.js         ← HTTP 入口（Run API、SSE、health）
│   ├── routes/           ← runs, files, status, conversations, capabilities...
│   ├── services/         ← sandbox-client + agent-client
│   └── Dockerfile
├── agent/                ← 独立 Agent（@earendil-works/pi-coding-agent 0.80.3）
│   ├── server.js         ← 内部 Run API / health
│   ├── application/      ← run 注册表、profile、治理
│   ├── runtime/          ← 会话循环、bootstrap、event bridge、消息/路径 helpers
│   ├── infrastructure/   ← Sandbox client + MCP Connection Manager
│   ├── services/         ← budget、waiters、model registry、session persistence
│   ├── packages/         ← @company/pi-enterprise-agent-kit
│   └── Dockerfile
├── sandbox/              ← 安全沙箱（Python FastAPI + 多层防护，无 Agent 主循环）
│   ├── main.py           ← FastAPI 入口
│   ├── routers/          ← sessions, executions, files, artifacts, traces...
│   ├── services/         ← 会话/执行/文件/审计/审批策略
│   └── Dockerfile
├── skills/               ← 可选共享 Skill 挂载（非硬依赖；profile + capability registry 控制可见性）
├── tests/                ← pytest 测试套件
├── scripts/              ← 备份/恢复、development reset、跨服务 smoke
├── nginx/                ← 生产 Nginx + SSL
├── docs/                 ← 活跃文档（archive/ 与历史 PLAN 不作现行规范）
├── workspaces/           ← 会话工作区（运行时，按 workspace_id 隔离）
├── tmp-workspaces/       ← Conversation 持久化 /tmp（按 tmp_{workspace_id} 隔离）
├── docker-compose.yml           ← 开发编排（Frontend + BFF + Agent + Sandbox + MySQL 8 + Redis 7）
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

### 执行限制

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_EXECUTION_TIMEOUT_SECONDS` | `120` | 单次命令超时 |
| `SANDBOX_MAX_OUTPUT_CHARS` | `50000` | stdout/stderr 上限 |
| `SANDBOX_MAX_PROCESS_COUNT` | `20` | 最大子进程数 |
| `SANDBOX_MAX_CPU_TIME_SECONDS` | `300` | CPU 时间上限 |
| `SANDBOX_MAX_MEMORY_MB` | `512` | 内存上限 |
| `SANDBOX_MAX_FILE_SIZE_MB` | `50` | 单文件大小上限 |
| `SANDBOX_WORKSPACE_QUOTA_MB` | `500` | 工作区总空间上限 |
| `SANDBOX_TEMP_QUOTA_MB` | `500` | Conversation 持久化 `/tmp` 空间上限 |
| `SANDBOX_SHARED_ENV_KEYS` | _(空)_ | 逗号分隔；从 sandbox 进程 env 注入到每次 bash/python/node/process 子进程 |
| `SANDBOX_EXEC_ENV_<NAME>` | — | 显式 opt-in：子进程得到 `NAME=value`（推荐） |

共享执行 env 不会继承全部服务环境；`SANDBOX_API_TOKEN` / DB 密码等硬拒绝。单次 `env_overrides` 优先。

### 会话管理

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_SESSION_TTL_MINUTES` | `30` | 会话空闲自动清理时间 |
| `SANDBOX_CLEANUP_INTERVAL_MINUTES` | `5` | 清理任务运行间隔 |

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
| `MYSQL_PASSWORD` | 开发占位；生产无默认 | 生产必填强 secret |
| `MYSQL_ROOT_PASSWORD` | 开发占位；生产无默认 | 生产必填强 secret |

**dev/prod 唯一正式拓扑为 MySQL 8**；生产配置校验拒绝 SQLite / PostgreSQL。凭据一律来自环境变量，勿硬编码真实密钥。研发清库见 [docs/runbooks/development-reset.md](docs/runbooks/development-reset.md)。

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

Redis 只保存队列、lease、stream、取消信号等运行态；**不是** Run 事实权威。清空 Redis 不删除 MySQL 中的 Conversation/Run/审计；未发布事件经 Outbox 重试，历史可从 MySQL `run_events` 重放。Agent 依赖 Redis health；BFF / Sandbox 不持有 Redis 权威配置。生产须设置 `REDIS_PASSWORD`。

### Skill

Agent **支持零 Skill 启动**（基础工具 read/write/edit/bash/…）。共享 `skills/` 与 kit package skills 由 Agent Profile（`profile.skills` + `sharedSkills`）与 session capability registry 控制；模型侧权威清单为 `capabilities` 工具。研发可用 `SKILLS_MODE=development` 的 install/edit/reload；生产默认 `readonly`。

### 其他

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_LOG_LEVEL` | `INFO` | 日志级别 |
| `MCP_SERVERS_JSON` | `[]` | Agent Runtime 管理的外部 MCP Server 列表 |
| `SANDBOX_UVICORN_WORKERS` | `1` | Uvicorn worker 数 |

## 开发

完整干净安装与验证命令见 [docs/development.md](docs/development.md)。摘要：

```bash
# 依赖（从仓库根目录；Node 22）
uv sync --extra test
npm ci --prefix api-server
npm ci --prefix agent
npm ci --prefix frontend

# 本地四进程
uv run uvicorn sandbox.main:app --port 8081 --reload
SANDBOX_BASE_URL=http://localhost:8081 npm run dev --prefix agent
SANDBOX_BASE_URL=http://localhost:8081 AGENT_BASE_URL=http://localhost:4100 \
  npm run dev --prefix api-server
npm run dev --prefix frontend

# 质量门禁（与 CI 对齐）
uv run pytest tests/ -q --tb=short
node --test api-server/tests/*.test.js
node --test agent/tests/*.test.js agent/tests/sdk-compat/*.test.js
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
| 路径 | Conversation 工作区按 opaque `workspace_id` 隔离；接受相对路径、逻辑 workspace 路径和 `/tmp`；物理路径不进入公共协议 |
| Skill | 发行零内置 package；默认只读；`SKILLS_MODE=development` 时仅专用 skill 工具可写 |
| 命令 | 禁止 `sudo, su, rm -rf /, dd, mkfs, fdisk, chmod 777` |
| 输出 | stdout/stderr 上限截断 |
| 交付 | 仅 Artifact API / `submit_artifact` 向用户分享文件（`write` 不自动下载） |
| 审计 | 每次执行记录 trace_id + 全量日志 |
| API Key | 仅存服务端环境变量，浏览器零接触 |

## 文档

| 文档 | 说明 |
|------|------|
| [架构设计](docs/architecture.md) | 四服务架构、设计决策、安全模型、数据流 |
| [部署指南](docs/deployment.md) | 生产部署（MySQL 8 + Redis 7）、SSL、备份、监控 |
| [开发指南](docs/development.md) | 本地开发、零 Skill、测试、调试 |
| [API 参考](docs/api.md) | Sandbox API + MCP + SSE、workspace_id 契约 |
| [前端指南](docs/webui.md) | 前端 SPA 架构、SSE 消费、扩展 |
| [Development reset](docs/runbooks/development-reset.md) | 研发清库停机窗口（不可逆） |

历史资料（`docs/archive/PLAN.md`、`docs/archive/IMPROVEMENT_PLAN.md`、`docs/archive/*`、部分 field-issues 表述）已 **superseded**，不作现行实现规范；以根目录 `plan.md`、本 README、代码和 `docs/*` 活跃页为准。后续未完成项见 `docs/refactor-follow-up.md`。
