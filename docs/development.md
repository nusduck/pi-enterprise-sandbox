# Development Guide

## 本地开发

### 前置要求

- **Python 3.11+** + `uv`（推荐）或 pip
- **Node.js 20+**
- **Docker**
- **Git**

### 初始化

```bash
# 1. 克隆仓库
git clone <repo-url>
cd pi-sandbox

# 2. 创建 Python 虚拟环境
uv venv
source .venv/bin/activate
uv pip install -e ".[test]"

# 3. 安装前端依赖
cd frontend && npm install && cd ..

# 4. 安装 API Server 依赖
cd api-server && npm install && cd ..
```

### 运行

```bash
# Terminal 1: 启动 Sandbox
cd sandbox && uv run uvicorn sandbox.main:app --port 8081 --reload

# Terminal 2: 启动 API Server（需要 Sandbox 运行）
cd api-server && SANDBOX_BASE_URL=http://localhost:8081 npm run dev

# Terminal 3: 启动前端（Vite 热更新，dev proxy → localhost:4000）
cd frontend && npm run dev
# 访问 http://localhost:5173

# Terminal 4: 运行测试
uv run pytest -q
```

或使用 Docker：

```bash
# 完整栈
docker compose up --build

# 仅 Sandbox（用于 API Server 本地开发）
docker compose up --build sandbox -d
# 然后本地运行 API Server：
cd api-server && SANDBOX_BASE_URL=http://localhost:8083 npm run dev
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
4. `skills/` 在容器中以只读方式挂载到 `/sandbox/skills/`
5. Agent 自动发现技能

### 修改前端

1. 编辑 `frontend/src/main.js`（唯一入口）
2. 编辑 `frontend/index.html` / `frontend/index.css`
3. Vite 热更新自动生效
4. 测试亮色和暗色主题

### 修改 API Server

1. `api-server/server.js` — 路由和 HTTP 处理
2. `api-server/agent-handler.js` — pi-coding-agent 封装
3. `api-server/sandbox-tools.js` — read/write/edit/bash 工具
4. 运行语法检查: `node --check api-server/server.js`

### 数据库操作

Sandbox 使用 SQLite WAL 模式，首次访问自动创建。

```python
# 代码中访问数据库
from sandbox.database import get_db

async with get_db() as db:
    cursor = await db.execute("SELECT * FROM sessions")
    rows = await cursor.fetchall()
```

重置数据库：
```bash
rm sandbox/data/sandbox.db  # SQLite 下次启动自动重建
```

## 测试

### 运行测试

```bash
# 快速运行全部
uv run pytest -q

# 详细模式
uv run pytest -v

# 指定文件
uv run pytest tests/test_integration.py -v

# 覆盖率
uv run pytest --cov=sandbox --cov-report=term-missing

# HTML 覆盖率报告
uv run pytest --cov=sandbox --cov-report=html
open htmlcov/index.html
```

### 测试结构

| 测试文件 | 测试内容 |
|----------|----------|
| `test_integration.py` | 端到端 API (TestClient) |
| `test_session_manager.py` | 会话 CRUD, TTL, 清理 |
| `test_execution_manager.py` | Python/命令执行 |
| `test_file_manager.py` | 文件读写/列表/预览 |
| `test_artifact_manager.py` | 产物注册/列表/下载 |
| `test_policy_checker.py` | 风险等级分类 |
| `test_tool_policy.py` | 工具策略检查 |
| `test_path_validation.py` | 路径逃逸防护 |
| `test_approval.py` | 审批工作流 |
| `test_persistence.py` | SQLite 持久化层 |
| `test_trace.py` | Trace ID 中间件 |
| `test_builtin_skills.py` | 内置技能脚本 |
| `test_container_startup.py` | Docker entrypoint, compose 配置 |
| `test_webui_api.py` | API Server 测试 |

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
| `Connection refused` 访问 Sandbox | 先确认 Sandbox 健康: `curl localhost:8083/health` |
| SSE 流中断 | 检查 API Server 和 Sandbox 日志 |
