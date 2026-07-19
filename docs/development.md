# Development Guide

## 本地开发

### 前置要求

- **Python 3.11**（次版本固定；`runtime-versions.json` / `.python-version`；`requires-python = ">=3.11,<3.12"`）
- **Node.js 22**（主版本固定；`runtime-versions.json` / `.node-version`；`engines.node = ">=22.19.0 <23"`，与 Pi SDK `0.80.3` 一致）
- **Pi SDK** `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` **精确** `0.80.3`（仅 `agent/`；禁止 `^`/`~`）
- **Docker** / Docker Compose
- **Git**

版本声明的权威源是仓库根目录 `runtime-versions.json`；一致性由 `tests/test_runtime_versions.py` 机器校验。升级 SDK 见 [runbooks/sdk-upgrade.md](./runbooks/sdk-upgrade.md)。

### 干净安装（CI 同款）

从仓库根目录执行。自动化环境优先 `npm ci`（需 lockfile）；本地首次可用 `npm install`。

```bash
# 0. 环境模板（勿提交真实 .env）
cp .env.example .env
# 编辑 .env：至少填入 LLMIO_BASE_URL / LLMIO_API_KEY；可选 SANDBOX_API_TOKEN
# 多用户归属（默认关闭）: SANDBOX_AUTH_ENABLED=true + AUTH_ENABLED=true + SANDBOX_JWT_SECRET
# 关闭鉴权即回退 open 单用户模式；ownership 列与 bootstrap 回填结果保留

# 1. Python（Sandbox + pytest）
uv sync --extra test

# 2. Node BFF + Agent + Frontend（Node 22）
npm ci --prefix api-server
npm ci --prefix agent
npm ci --prefix frontend
# 无 lock 或本地开发也可用：npm install --prefix <pkg>
```

### 权威验证命令（与 `.github/workflows/test.yml` 对齐）

```bash
# Python（含 runtime-versions 一致性）
uv run pytest tests/ -q --tb=short
# 仅版本钉：uv run pytest tests/test_runtime_versions.py -q

# Node BFF（含 import/listen smoke）
node --test api-server/tests/*.test.js
# 或：npm test --prefix api-server

# Node Agent（含 sdk-compat、fake OpenAI、listen smoke）
node --test agent/tests/*.test.js agent/tests/sdk-compat/*.test.js
# SDK 精确版本：npm ls --prefix agent @earendil-works/pi-coding-agent
# 升级流程：docs/runbooks/sdk-upgrade.md · ADR：docs/adr/0001-pi-coding-agent-sdk.md
# SSOT：runtime-versions.json

# Frontend
npm test --prefix frontend
npm run build --prefix frontend

# Compose 文件合法性（需要 .env；可用 .env.example 复制）
test -f .env || cp .env.example .env
docker compose config -q

# 无真实 LLM key 的四服务协议 smoke（deterministic fake OpenAI；生产禁用）
node scripts/smoke-cross-service.mjs
```

### 运行（本地四进程）

```bash
# Terminal 1: Sandbox
# Inbound allowlist defaults to loopback + private ranges; see SANDBOX_ALLOWED_CLIENT_CIDRS.
# SANDBOX_BIND_HOST only sets the listen address (0.0.0.0 ≠ allow any client).
uv run uvicorn sandbox.main:app --host 127.0.0.1 --port 8081 --reload

# Terminal 2: Agent（需要 Sandbox + LLM 配置）
SANDBOX_BASE_URL=http://localhost:8081 npm run dev --prefix agent

# Terminal 3: API Server / BFF（需要 Sandbox + Agent）
SANDBOX_BASE_URL=http://localhost:8081 AGENT_BASE_URL=http://localhost:4100 \
  npm run dev --prefix api-server

# Terminal 4: 前端（Vite 热更新，dev proxy → localhost:4000）
npm run dev --prefix frontend
# 访问 http://localhost:5173
```

或使用 Docker：

```bash
# 完整栈
docker compose up --build

# 仅 Sandbox（用于 Agent / BFF 本地开发）
docker compose up --build sandbox -d
# 然后本地运行 Agent + BFF：
SANDBOX_BASE_URL=http://localhost:8081 npm run dev --prefix agent
SANDBOX_BASE_URL=http://localhost:8081 AGENT_BASE_URL=http://localhost:4100 \
  npm run dev --prefix api-server
```

## 开发流程

### 新增 API 端点 (Sandbox)

1. 在 `sandbox/routers/` 创建或更新 router
2. 在 `sandbox/services/` 添加业务逻辑
3. 在 `sandbox/main.py` 注册 router
4. 如需新模型，在 `sandbox/models.py` 添加 Pydantic schema
5. 编写测试 `tests/`
6. 更新 API 文档 `docs/api.md`

### 新增技能（零 Skill 仍可启动）

Agent **可以在零 Skill package 下启动**并使用基础工具（read/write/edit/bash/ls/find/grep/submit_artifact 等）。仓库 `skills/` 当前可挂载共享 Skill package（如文档/办公类技能）；它们不是运行时硬依赖。

模型与运营侧的权威清单来自 **session-scoped capability registry** 与模型工具 `capabilities`（list/search/describe），而不是模型对 prompt 的记忆。`coding-agent` 默认 `sharedSkills.mode=all`，在保留 package skill allowlist（`profile.skills`）的同时暴露共享挂载上的全部合法 package。

**方式 A — 手工放置（仍建议只读挂载）**

1. 在 `skills/your-skill-name/` 创建目录
2. 添加 `SKILL.md`（YAML frontmatter：`name` + `description` 必填）
3. 添加脚本到 `skills/your-skill-name/scripts/`
4. `skills/` 默认只读挂载到 Agent / Sandbox skill 根
5. Agent 经 `dynamic-resources` + profile skill policy 发现技能；工作区始终从空目录起步，技能不复制进 workspace
6. 安装/编辑后调用 `skill_reload`（development）或新 session 以刷新 registry

**方式 B — 研发对话安装（`SKILLS_MODE=development`）**

单用户可信研发环境可通过 Agent 专用工具安装/修改共享 Skill（不建设 overlay / 审批流）：

```bash
# .env
SKILLS_MODE=development
AGENT_SKILLS_MOUNT=./skills:/home/sandbox/skill:rw
# 本地安装源白名单（容器内绝对路径，逗号分隔）
SKILLS_INSTALL_LOCAL_ALLOWLIST=/tmp/skill-src
# 可选审计文件
# SKILLS_AUDIT_LOG=/tmp/skill-audit.jsonl
```

| 工具 | 作用 |
|------|------|
| `skill_install` | 从**白名单本地目录**或 **HTTPS Git（必须指定 ref）** 安装；记录 resolved commit；临时目录 + 原子替换 |
| `skill_edit` | 写 skill 根下文件（校验路径不逃逸；`SKILL.md` 格式校验） |
| `skill_reload` | 显式 reload loader；下一回合也会重新扫描 |

**拒绝**：`git@` / SSH、URL 内嵌凭证、任意压缩包/安装脚本、npm/OCI。  
**路径策略**：通用 `write` / `edit` / `bash` **不能**写 skill 根；生产 `SKILLS_MODE=readonly` 时上述工具不注册。  
Sandbox 始终只读挂载 skill（仅执行）；写操作只发生在 Agent 侧可写卷。

### 修改前端

1. 从 `frontend/src/main.tsx` 和 `frontend/src/app/` 的 React Workbench 入口开始定位功能
2. Runtime 实体与归约逻辑在 `frontend/src/entities/`、`frontend/src/shared/state/`；API/SSE 适配在 `frontend/src/shared/`
3. 组件与页面分别位于 `frontend/src/widgets/`、`frontend/src/features/`、`frontend/src/pages/`
4. Vite 热更新自动生效；使用 `npm test --prefix frontend` 与 `npm run build --prefix frontend` 验证

### 修改 API Server（BFF）

1. `api-server/server.js` — HTTP 入口与路由分派
2. `api-server/routes/runs.js` — Run 创建、控制与序列化 SSE relay
3. `api-server/services/agent-client.js` — BFF → Agent HTTP 客户端
4. `api-server/config.js` — `AGENT_BASE_URL` / 内部令牌等
5. 语法检查: `node --check api-server/server.js`
6. 单元测试: `npm test --prefix api-server`

### 修改 Agent 服务

1. `agent/server.js` / `agent/worker.js` — HTTP 与 Worker 入口（仅装配 `src/bootstrap/*`）
2. `agent/src/bootstrap/` — ServiceContainer、HTTP factory、BullMQ worker（MySQL Create/Get/Cancel/Execute）
3. `agent/src/application/` — Run / Session recovery / Event SSE / A2A services
4. `agent/src/infrastructure/pi/` — Pi Runtime Factory + Session Adapter
5. `agent/src/extensions/` — 仅三类企业 Extension：`sandbox-bridge` / `enterprise-policy` / `observability`
6. `agent/src/infrastructure/mcp/` — `pi-mcp-adapter`（禁止自研 MCP Client 主路径）
7. `agent/infrastructure/sandbox-client.js` — Sandbox 内部 HMAC HTTP（`/internal/v1/*` 执行/文件/artifact submit；**不** dual-write Run）
8. 语法检查: `node --check agent/server.js && node --check agent/worker.js`
9. 单元测试: `npm test --prefix agent`

> PR-13 已删除进程内 `application/run-manager.js`、旧 `runtime/agent-runtime.js` Session 双写与 `mcp-connection-manager.js`。证据见 [archive/process/pr13-deletion-evidence.md](archive/process/pr13-deletion-evidence.md)。

### 数据库操作

正式拓扑为 **MySQL 8**（`AGENT_DATABASE_URL` / `SANDBOX_DATABASE_URL`）。启动时 persistence 在单事务中应用不可变 migration，并在 `schema_migrations` 记录 version/checksum。不升级或回填研发阶段的旧数据库；需要清空旧状态时遵循 [Development reset runbook](runbooks/development-reset.md)。

正式服务的事实状态在 Agent-owned MySQL 中。Sandbox 不再包含 SQLite
`database`/repository 兼容层，也不拥有 Run/Conversation；调试 durable 状态
应使用 MySQL 客户端或 Agent repository，并遵守 owner scope：

```bash
docker compose exec mysql mysql -usandbox -p"$MYSQL_PASSWORD" sandbox \
  -e 'SELECT run_id, status FROM runs ORDER BY created_at DESC LIMIT 20;'
```

Sandbox 测试不建立数据库连接；需要覆盖拒绝逻辑时，可以显式构造非 MySQL
`Settings`，但不得把它作为应用启动或服务 fixture。

重置数据库（⚠️ 删除 MySQL volume 数据）：

```bash
docker compose down -v
docker compose up -d mysql
# 或按 runbook 做 development reset
```

### Redis 操作（Agent-only 协调）

正式协调拓扑为 **Redis 7**（`redis:7.2`；`AGENT_REDIS_URL` / `REDIS_URL`；可选 `TEST_REDIS_URL`）。Agent 依赖 Redis health；BFF 不持有 Redis 权威配置。Sandbox 另起 **sandbox-replay-redis**（独立密码/volume，DB0）仅作 internal HMAC jti 防重放，**不得**复用 Agent Redis 凭据。

- 默认 AOF + `redis_dev_data` volume：容器重建后协调数据仍在。
- **清空 Redis**（`FLUSHALL` 或删 volume）只丢失 queue/lease/stream 等运行态，**不**删除 MySQL 事实。
- Redis 暂停或清空后：Outbox publisher 从 MySQL `domain_outbox` 重试；事件历史从 `run_events` 重放。

```bash
# 仅重启 Redis（保留 volume）
docker compose up -d redis

# 清空协调状态但保留 MySQL（⚠️ 运行态 job/lease 丢失）
docker compose exec redis redis-cli -a redis_dev_only FLUSHALL
# 或：docker compose stop redis && docker volume rm <project>_redis_dev_data
```

生产启动前必须设置强 `REDIS_PASSWORD`；prod overlay 在缺失时 fail-fast。

## 测试

### 运行测试

```bash
# Python — 快速全部（CI 同款）
uv run pytest tests/ -q --tb=short

# 详细 / 定向
uv run pytest -v
uv run pytest tests/test_integration.py -v

# 覆盖率（可选；非 CI 强制门禁）
uv run pytest --cov=sandbox --cov-report=term-missing
uv run pytest --cov=sandbox --cov-report=html

# Node API Server（node:test，含 sdk-compat）
node --test api-server/tests/*.test.js api-server/tests/sdk-compat/*.test.js
npm test --prefix api-server

# Frontend（node:test，见 frontend/test/*.test.js）
npm test --prefix frontend
npm run build --prefix frontend
```

### 测试结构

| 位置 | 测试内容 |
|------|----------|
| `tests/test_sandbox_mysql_import.py` | MySQL-only 启动、删除模块与公开路由回归 |
| `tests/test_formal_session_runtime.py` | 正式 Session/Workspace 运行时契约 |
| `tests/test_formal_execution_runtime.py` | 正式 Python/命令执行运行时契约 |
| `tests/test_file_manager.py` | 文件读写/列表/预览/二进制 |
| `tests/test_formal_artifact_runtime.py` | Artifact 显式提交、恢复与归属 |
| `tests/test_policy_checker.py` | 风险等级分类 |
| `tests/test_path_validation.py` | 路径逃逸防护 |
| `tests/test_internal_plane_lifecycle_batch_b.py` | 内部控制面生命周期 |
| `tests/test_sandbox_mysql_unit.py` | MySQL DSN/SQL 约束与拒绝路径 |
| `tests/test_sandbox_mysql_integration.py` | 真实 MySQL integration gate（需测试 DSN） |
| `tests/test_mysql_topology_config.py` | MySQL 拓扑/compose/config 静态校验 |
| `tests/test_redis_topology_config.py` | Redis 拓扑/compose/env 静态校验（PR-03） |
| `tests/test_builtin_skills.py` | 零 Skill 发行基线 |
| `tests/test_auth.py` / `test_internal_auth*.py` | 公开路由、API key/JWT 与内部 HMAC |
| `tests/test_python_agent_removed.py` | 确认 Python Agent Runtime 已删除 |
| `tests/test_container_startup.py` | Docker entrypoint, compose 配置 |
| `api-server/tests/*.test.js` | BFF agent-client / chat relay / listen smoke |
| `agent/tests/*.test.js` | Run API、fake OpenAI、listen smoke、SDK compat |
| `frontend/test/*.test.js` | SSE 解析、state、security/a11y |
| `scripts/smoke-cross-service.mjs` | 无真实 LLM key 的 BFF↔Agent↔Sandbox smoke |

### 编写测试

```python
from fastapi.testclient import TestClient
from sandbox.main import app

client = TestClient(app)

def test_my_endpoint():
    # Public Sandbox session creation was removed. Exercise a formal internal
    # contract with an injected fake repository/runtime instead.
    response = client.get("/health")
    assert response.status_code == 200
```

## 代码质量

### Linting

推荐 `ruff`：

```bash
pip install ruff
ruff check sandbox/ tests/
ruff format --check sandbox/ tests/
```

### Type Checking

```bash
pip install mypy
mypy sandbox/ --ignore-missing-imports
```

### 安全扫描

```bash
# 检查硬编码密钥
grep -rn "sk-[A-Za-z0-9]" --include="*.py" --include="*.js" --include="*.json"
grep -rn "api_key\s*=\s*['\"]" --include="*.py" --include="*.js" --include="*.json"
```

## Git 工作流

```bash
git checkout -b feat/your-feature
git add -A
git commit -m "feat: add your feature"
git fetch origin
git rebase origin/main
git push -u origin feat/your-feature
```

### Commit 规范 (Conventional Commits)

- `feat:` — 新功能
- `fix:` — Bug 修复
- `docs:` — 文档
- `test:` — 测试
- `refactor:` — 代码重构
- `chore:` — 构建/配置/依赖

## 调试

### Sandbox

```bash
# 查看日志
docker compose logs -f sandbox

# 交互式 shell
docker exec -it pi-enterprise-sandbox /bin/bash

# 查看 MySQL 表（compose 网络内 mysql 服务）
docker exec -it pi-enterprise-mysql \
  mysql -usandbox -psandbox_dev_only sandbox -e "SHOW TABLES;"
```

### API Server

```bash
# 查看日志
docker compose logs -f api-server

# Node.js inspector
cd api-server && node --inspect server.js
# 浏览器打开 chrome://inspect
```

### Frontend

```bash
# Dev 模式（浏览器控制台）
cd frontend && npm run dev

# 检查 build 产物
cd frontend && npm run build && ls dist/
```

### 常见问题

| 问题 | 解决方案 |
|------|----------|
| `port already in use` | 修改 `FRONTEND_PORT`, `API_PORT`、`AGENT_PORT` 或 `SANDBOX_HOST_PORT` |
| MySQL 连接失败 / `Can't connect` | 确认 `mysql` 服务 healthy；检查 `AGENT_DATABASE_URL` / `SANDBOX_DATABASE_URL` 与 `MYSQL_*` 一致；勿在日志中打印完整 DSN |
| Redis 连接失败 / `NOAUTH` | 确认 `redis` 服务 healthy 与 `REDIS_PASSWORD`；检查 `AGENT_REDIS_URL` / `REDIS_URL` 与密码一致；勿在日志中打印完整 URL |
| `Connection refused` 访问 Sandbox | 先确认 liveness: `curl -f localhost:8083/health`，再确认 readiness: `curl -f localhost:8083/ready` |
| `/ready` 返回 503 | 检查 `SANDBOX_WORKSPACES_ROOT` 可写与 MySQL（`SANDBOX_DATABASE_URL`）可达；日志仅有 warning，不含连接串 |
| SSE 流中断 | 检查 API Server 和 Sandbox 日志；确认客户端 abort 后执行已取消 |

## 安全治理（SDK Extension + Sandbox 双重强制）

开发时默认开启人审：

```bash
# 全局默认：高风险工具暂停，等待人工决定
APPROVAL_MODE=ask
```

- **Agent 层**：`agent/src/extensions` 固定装配 `sandbox-bridge`、`enterprise-policy`、`observability`；本地 Workspace 工具默认不审批，外部副作用审批由 MySQL durable ledger fail-closed。
- **Sandbox 层**：`policy_checker` 与 `/internal/v1/*` execution handlers 独立执行路径、owner、HMAC claim 和 hard-deny；普通 workspace bash/python/node 不进入审批。
- **审批模式**：`ask`（默认）创建 durable approval 并暂停；`deny` 明确拒绝
  `approval_required` 且不创建审批；`auto_approve` 仅用于明确受控的研发旁路并写
  bypass 审计，生产配置拒绝该模式。旧 `APPROVAL_ENABLED=true|false` 分别映射到
  `ask|deny`。所有模式都保留 hard_deny（如 `sudo`、`rm -rf /`）。
- **定向测试**：

```bash
cd agent && node --test tests/pi/enterprise-policy-layers.unit.test.js tests/pi/enterprise-policy-fail-closed.unit.test.js
uv run pytest tests/test_policy_checker.py tests/test_approval.py tests/test_policy_approval.py -q
```

详见 [architecture.md](./architecture.md)「双重强制」一节。
