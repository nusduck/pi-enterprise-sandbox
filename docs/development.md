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

1. 编辑 `frontend/src/main.js`（唯一入口）
2. 编辑 `frontend/index.html` / `frontend/index.css`
3. Vite 热更新自动生效
4. 测试亮色和暗色主题

### 修改 API Server（BFF）

1. `api-server/server.js` — HTTP 入口与路由分派
2. `api-server/routes/runs.js` — Run 创建、控制与序列化 SSE relay
3. `api-server/services/agent-client.js` — BFF → Agent HTTP 客户端
4. `api-server/config.js` — `AGENT_BASE_URL` / 内部令牌等
5. 语法检查: `node --check api-server/server.js`
6. 单元测试: `npm test --prefix api-server`

### 修改 Agent 服务

1. `agent/server.js` — 内部 Run API / health
2. `agent/application/run-manager.js` — 进程内 run 注册表、SSE 订阅、steer/resume
3. `agent/runtime/agent-runtime.js` — Pi Session Host 与单轮运行编排
4. `agent/runtime/session-bootstrap.js` — conversation / sandbox / Pi session 解析
5. `agent/packages/enterprise-agent-kit/extensions/sandbox-tools/` — read/write/edit/bash/process/artifact 工具 Extension
6. `agent/packages/enterprise-agent-kit/extensions/skill-management/` — SKILLS_MODE 下的 install/edit/reload Extension
7. `agent/packages/enterprise-agent-kit/extensions/policy/` — 企业策略 Extension（含 Skill 根硬拒绝）
8. `agent/infrastructure/mcp-connection-manager.js` — Sandbox 之外的 MCP 连接、鉴权与 Schema 校验
9. 语法检查: `node --check agent/server.js && node --check agent/runtime/agent-runtime.js`
10. 单元测试: `npm test --prefix agent`

### 数据库操作

Sandbox 在开发/测试中使用空库 SQLite；生产强制 PostgreSQL。启动时 `database.initialize()` 在单事务中应用不可变 migration，并在 `schema_migrations` 记录 version/checksum。它不升级或回填研发阶段的旧数据库；需要清空旧状态时遵循 [Development reset runbook](runbooks/development-reset.md)。

```python
from sandbox.database import database

with database.connect() as conn:
    cur = conn.execute("SELECT session_id FROM sessions")
    rows = cur.fetchall()
```

重置数据库（本地默认路径因环境而异；容器内为 `/sandbox/data/sandbox.db`）：

```bash
# 容器
docker exec pi-enterprise-sandbox rm -f /sandbox/data/sandbox.db
# 下次启动自动重建
```

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
| `tests/test_integration.py` | Sandbox 端到端 API (TestClient)，含 `/health` `/ready` |
| `tests/test_session_manager.py` | 会话 CRUD, TTL, 清理 |
| `tests/test_execution_manager.py` | Python/命令执行、取消 |
| `tests/test_file_manager.py` | 文件读写/列表/预览/二进制 |
| `tests/test_artifact_manager.py` | 产物注册/列表/下载 |
| `tests/test_policy_checker.py` | 风险等级分类 |
| `tests/test_path_validation.py` | 路径逃逸防护 |
| `tests/test_approval.py` | 审批工作流 |
| `tests/test_persistence.py` | 空库持久化层（SQLite 开发/测试） |
| `tests/test_database_baseline.py` | 空库 migration 幂等 / checksum / 回滚（SQLite CI；可选 PostgreSQL） |
| `tests/test_builtin_skills.py` | 零 Skill 发行基线 |
| `tests/test_auth.py` / `test_auth_foundation.py` | 公开路由、API key / JWT |
| `tests/test_python_agent_removed.py` | 确认 Python Agent Runtime 已删除 |
| `tests/test_container_startup.py` | Docker entrypoint, compose 配置 |
| `tests/test_webui_api.py` | 跨层 WebUI/API 契约 |
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
    session = client.post("/sessions", json={"caller_id": "test"}).json()
    sid = session["session_id"]

    resp = client.get(f"/sessions/{sid}/my-new-endpoint")
    assert resp.status_code == 200
    assert resp.json()["key"] == "expected_value"
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

# 查看数据库
docker exec pi-enterprise-sandbox sqlite3 /sandbox/data/sandbox.db ".tables"
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
| `sqlite3.OperationalError: database is locked` | 等待或重启 Sandbox 容器 |
| `Connection refused` 访问 Sandbox | 先确认 liveness: `curl -f localhost:8083/health`，再确认 readiness: `curl -f localhost:8083/ready` |
| `/ready` 返回 503 | 检查 `SANDBOX_WORKSPACES_ROOT` 可写与 `SANDBOX_DATABASE_URL` 可达；日志仅有 warning，不含连接串 |
| SSE 流中断 | 检查 API Server 和 Sandbox 日志；确认客户端 abort 后执行已取消 |

## 安全治理（SDK Extension + Sandbox 双重强制）

开发时默认开启人审：

```bash
# 全局默认：高风险工具暂停，等待人工决定
APPROVAL_MODE=ask
```

- **Agent 层**：`@company/pi-enterprise-agent-kit` 的 Policy 与 Sandbox Tools Extension 在 `bindExtensions()` 后生效；写工具互斥与审批保持 fail-closed。
- **Sandbox 层**：`policy_checker` 三层决策；`POST .../approval-check` 与 `POST .../executions/command` 独立 hard_deny。
- **审批模式**：`ask`（默认）创建 durable approval 并暂停；`deny` 明确拒绝
  `approval_required` 且不创建审批；`auto_approve` 仅用于明确受控的研发旁路并写
  bypass 审计，生产配置拒绝该模式。旧 `APPROVAL_ENABLED=true|false` 分别映射到
  `ask|deny`。所有模式都保留 hard_deny（如 `sudo`、`rm -rf /`）。
- **定向测试**：

```bash
cd agent && node --test tests/sandbox-security.test.js
uv run pytest tests/test_policy_checker.py tests/test_approval.py tests/test_policy_approval.py -q
```

详见 [architecture.md](./architecture.md)「双重强制」一节。
