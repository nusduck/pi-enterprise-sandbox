# Development Guide

## 本地开发

### 前置要求

- **Python 3.11+** + `uv`（推荐）或 pip
- **Node.js 20+**
- **Docker** / Docker Compose
- **Git**

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

# 2. Node API Server
npm ci --prefix api-server
# 无 lock 或本地开发也可用：npm install --prefix api-server

# 3. Frontend
npm ci --prefix frontend
# 或：npm install --prefix frontend
```

### 权威验证命令（与 `.github/workflows/test.yml` 对齐）

```bash
# Python
uv run pytest tests/ -q --tb=short

# Node API Server
node --test api-server/tests/*.test.js
# 或：npm test --prefix api-server
find api-server -name '*.js' -type f ! -path '*/node_modules/*' -exec node --check {} \;

# Frontend
npm test --prefix frontend
npm run build --prefix frontend

# Compose 文件合法性（需要 .env；可用 .env.example 复制）
test -f .env || cp .env.example .env
docker compose config -q
```

### 运行（本地三进程）

```bash
# Terminal 1: Sandbox
uv run uvicorn sandbox.main:app --port 8081 --reload

# Terminal 2: API Server（需要 Sandbox）
# 默认 AGENT_RUNTIME=node；Python 编排试运行：AGENT_RUNTIME=python
SANDBOX_BASE_URL=http://localhost:8081 npm run dev --prefix api-server

# Terminal 3: 前端（Vite 热更新，dev proxy → localhost:4000）
npm run dev --prefix frontend
# 访问 http://localhost:5173
```

或使用 Docker：

```bash
# 完整栈
docker compose up --build

# 仅 Sandbox（用于 API Server 本地开发）
docker compose up --build sandbox -d
# 然后本地运行 API Server（注意 host 映射端口）：
SANDBOX_BASE_URL=http://localhost:8083 npm run dev --prefix api-server
```

## 开发流程

### 新增 API 端点 (Sandbox)

1. 在 `sandbox/routers/` 创建或更新 router
2. 在 `sandbox/services/` 添加业务逻辑
3. 在 `sandbox/main.py` 注册 router
4. 如需新模型，在 `sandbox/models.py` 添加 Pydantic schema
5. 编写测试 `tests/`
6. 更新 API 文档 `docs/api.md`

### 新增技能

1. 在 `skills/your-skill-name/` 创建目录
2. 添加 `SKILL.md`（YAML frontmatter + 描述）
3. 添加脚本到 `skills/your-skill-name/scripts/`
4. `skills/` 在容器中以只读方式挂载到 `/home/sandbox/skill/`（以及兼容路径 `/sandbox/skills`）
5. Agent 自动发现技能；工作区始终从空目录起步，技能不复制进 workspace

### 修改前端

1. 编辑 `frontend/src/main.js`（唯一入口）
2. 编辑 `frontend/index.html` / `frontend/index.css`
3. Vite 热更新自动生效
4. 测试亮色和暗色主题

### 修改 API Server

1. `api-server/server.js` — HTTP 入口与路由分派
2. `api-server/routes/chat.js` — SSE chat（受 `AGENT_RUNTIME` 影响）
3. `api-server/sandbox-tools.js` — read/write/edit/bash/submit_artifact
4. `api-server/config.js` — 环境变量与 `AGENT_RUNTIME` 规范化
5. 语法检查: `node --check api-server/server.js`
6. 单元测试: `npm test --prefix api-server`

### 数据库操作

Sandbox 使用 SQLite WAL 模式（可选 PostgreSQL），启动时 `database.initialize()` 建表。

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

# Node API Server（node:test）
node --test api-server/tests/*.test.js
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
| `tests/test_persistence.py` | SQLite 持久化层 |
| `tests/test_auth.py` / `test_auth_foundation.py` | 公开路由、API key / JWT |
| `tests/test_agent_*.py` | Python Agent 路由与对等 |
| `tests/test_container_startup.py` | Docker entrypoint, compose 配置 |
| `tests/test_webui_api.py` | 跨层 WebUI/API 契约 |
| `api-server/tests/*.test.js` | AGENT_RUNTIME、request-context 隔离 |
| `frontend/test/*.test.js` | SSE 解析、state、security/a11y |

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
| `port already in use` | 修改 `FRONTEND_PORT`, `API_PORT` 或 `SANDBOX_MCP_HOST_PORT` |
| `sqlite3.OperationalError: database is locked` | 等待或重启 Sandbox 容器 |
| `Connection refused` 访问 Sandbox | 先确认 liveness: `curl -f localhost:8083/health`，再确认 readiness: `curl -f localhost:8083/ready` |
| `/ready` 返回 503 | 检查 `SANDBOX_WORKSPACES_ROOT` 可写与 `SANDBOX_DATABASE_URL` 可达；日志仅有 warning，不含连接串 |
| SSE 流中断 | 检查 API Server 和 Sandbox 日志；确认客户端 abort 后执行已取消 |
