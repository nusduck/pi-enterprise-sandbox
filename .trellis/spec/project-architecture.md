# 项目架构、构建与通用模式

## 系统定位

Pi Enterprise Sandbox 是一个三服务全栈仓库：浏览器 UI、Node.js Agent/API 编排层、Python FastAPI 安全沙箱分别运行，默认由 Docker Compose 组合。

```text
Browser
  -> frontend (Vite 构建，Nginx 静态托管与 /api 反代)
  -> api-server (Node 原生 HTTP、pi-coding-agent、SSE)
  -> sandbox (FastAPI、执行/文件/审批/产物/持久化/MCP)
  -> per-session physical workspace + SQLite/PostgreSQL
```

证据：`docker-compose.yml`、`frontend/nginx.conf`、`api-server/server.js`、`sandbox/main.py`、`docs/architecture.md`。

## 顶层目录职责

| 路径 | 当前职责 | 示例 |
|---|---|---|
| `sandbox/` | Python 3.11+ FastAPI 服务及安全执行运行时 | `sandbox/main.py`、`sandbox/routers/executions.py` |
| `api-server/` | 服务端 Agent 会话、SSE、Sandbox REST 代理 | `api-server/routes/chat.js`、`api-server/services/sandbox-client.js` |
| `frontend/` | 无框架 Vanilla JS SPA，Vite 构建，Nginx 托管 | `frontend/src/main.js`、`frontend/src/state.js` |
| `tests/` | 统一 pytest 测试，包括单元、FastAPI 集成、配置/容器契约 | `tests/test_integration.py`、`tests/test_container_startup.py` |
| `skills/` | 内置 Agent 技能及其脚本 | `skills/data-analysis/SKILL.md` |
| `config/agent/` | Agent 模型和运行时配置 JSON | `models.json`、`settings.json` |
| `nginx/` | 生产入口、TLS 与跨服务反向代理 | `nginx/conf.d/sandbox.conf` |
| `scripts/` | 运维脚本 | `backup.sh`、`restore.sh` |
| `docs/` | API、架构、开发与部署文档；`archive/` 不是当前规范 | `docs/api.md`、`docs/deployment.md` |

`CONTRIBUTING.md` 仍提到已删除的 `extensions/`、`sdk/` 和旧文件名；新增代码不得据此恢复这些目录。删除事实可由当前目录和提交 `3489846a` 交叉确认。

## 主要数据流

### 对话与工具调用

1. `frontend/src/api.js` 向 `POST /api/chat` 提交完整消息历史并消费 SSE。
2. `api-server` 根据 **`AGENT_RUNTIME`**（默认 **`node`**）选择编排：
   - `node`：`routes/chat.js` 创建/复用 conversation 与 sandbox session，初始化 `pi-coding-agent`。
   - `python`：BFF 将请求/SSE 透传到 Sandbox `POST /agent/chat`（Python `AgentRuntime`）；回滚只需改回 `node` 并重启 api-server。
3. `api-server/sandbox-tools.js`（Node 路径）将 `read/write/edit/bash/submit_artifact` 转为 Sandbox REST 调用；高风险 bash 先走审批。
4. `sandbox/routers/` 校验 HTTP 输入并调用 `sandbox/services/`；需要持久化时再进入 `sandbox/repositories.py`。
5. `token/tool_start/tool_end/file_ready/done/error` 等事件回到浏览器；`frontend/src/main.js` 更新状态并触发增量渲染。

### 文件与产物

- 会话 API 暴露稳定逻辑路径 `/home/sandbox/workspace`，真实 I/O 使用 session metadata 中的物理工作区。
- 所有用户路径必须通过 `sandbox/security/path_validation.py` 的 `resolve()` 边界校验。
- `write`/`edit` 只写私有工作区；只有显式 `submit_artifact` 注册后才作为交付物发出 `file_ready`。
- 同一 session 的执行由 `ExecutionManager._session_locks` 串行化；不同 session 使用不同物理目录。

## 跨层实现模式

### 统一边界，再下沉逻辑

- Python：Router 负责 HTTP 状态和 Pydantic 响应，Service 负责业务/安全，Repository 负责 SQL。例如 `routers/sessions.py` -> `services/session_manager.py` -> `repositories.py`。
- Node：`server.js` 只分派路径，`routes/*.js` 处理 HTTP/SSE，`services/sandbox-client.js` 集中 Sandbox fetch 与错误转换。
- Frontend：`api.js` 管协议，`state.js` 管状态，`render.js` 管 DOM，`main.js` 负责编排和事件绑定。

### 配置集中化

- Python 环境变量通过 `sandbox/config.py::Settings` 读取，前缀为 `SANDBOX_`。
- Node 环境变量集中在 `api-server/config.js`。
- 容器默认值集中在 `docker-compose.yml`；生产覆盖在 `docker-compose.prod.yml`。
- 不在路由或 UI 模块新增散落的 secret/default；安全值不进入浏览器。

### 可追踪与安全默认值

- `X-Trace-Id` 由 Node 生成/传递，FastAPI middleware 回显，并写入 execution/audit 数据。
- 子进程只接收 `sandbox/security/safe_env.py` 构造的最小环境，不继承完整 `os.environ`。
- 高风险工具默认进入审批或拒绝；未知工具在 `policy_checker.py` 中按中风险处理。

## 安装、开发、构建和验证命令

以下命令均从仓库根目录理解；子目录命令明确使用 `--prefix`，避免依赖当前 shell 目录。

```bash
# Python 依赖（CI 使用 uv）
uv sync --extra test

# Node 依赖（存在 package-lock.json，自动化优先 npm ci）
npm ci --prefix api-server
npm ci --prefix frontend

# 本地开发（三个终端）
uv run uvicorn sandbox.main:app --port 8081 --reload
SANDBOX_BASE_URL=http://localhost:8081 npm run dev --prefix api-server
npm run dev --prefix frontend

# 前端生产构建
npm run build --prefix frontend

# 完整容器栈
cp .env.example .env
docker compose up --build

# 生产 overlay
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

说明：`api-server/package.json` 没有独立 build 脚本，直接运行 ESM 源码；Python 使用 setuptools 构建元数据，但日常服务启动依赖 Uvicorn/Docker。

## 测试方式

CI 权威入口：`.github/workflows/test.yml`（四个并行 job）：

| Job | 命令摘要 |
|-----|----------|
| `python` | `uv sync --extra test` → `uv run pytest tests/ -q --tb=short` |
| `node-api` | `npm ci --prefix api-server` → `node --test api-server/tests/*.test.js` + `node --check` |
| `frontend` | `npm ci --prefix frontend` → `npm test` → `npm run build` |
| `compose` | 确保 `.env` 存在后 `docker compose config -q` |

```bash
uv sync --extra test && uv run pytest tests/ -q --tb=short
npm ci --prefix api-server && node --test api-server/tests/*.test.js
npm ci --prefix frontend && npm test --prefix frontend && npm run build --prefix frontend
test -f .env || cp .env.example .env; docker compose config -q
```

测试形态包括：

- 纯单元测试：直接实例化 Manager/Checker，如 `test_session_manager.py`、`test_policy_checker.py`。
- FastAPI 集成测试：模块级 `TestClient(app)`，如 `test_integration.py`（含 `/health` liveness 与 `/ready` readiness/503）。
- Node `node:test`：`api-server/tests/`（runtime 选择、request-context）。
- Frontend `node:test`：`frontend/test/`（SSE、state、security）。
- 临时路径隔离：`tests/conftest.py` 在导入应用前覆盖 `SANDBOX_*` 路径和数据库。
- 文件/配置契约：读取 Docker/Compose 或运行 `bash -n`，如 `test_container_startup.py`。
- 手工/环境依赖 E2E：`tests/e2e_artifact_flow.py`、`tests/mcp_full_e2e.py` 不应默认视作 CI 外部服务已就绪。

## 待确认

- **待确认：** 是否将 Ruff、Black、Mypy 和覆盖率设为强制门禁。当前 `CONTRIBUTING.md`/`docs/development.md` 仅推荐，`pyproject.toml` 和 CI 未配置对应 job。
- **已落地：** Node API 与 Frontend 均有 `test` script（`node:test`），CI 分 job 执行。
- **待确认：** 前端 `@earendil-works/pi-web-ui` 仍列为依赖，但当前 `frontend/src/*.js` 未 import；是否保留该依赖属于后续清理决策。
- **待确认：** 数据库 schema 变更的正式迁移/回滚流程；当前仓库没有 Alembic 或独立 migration 目录。
- **运行时选择：** 生产浏览器始终 `POST /api/chat`；`AGENT_RUNTIME=node|python`（默认 `node`）控制编排实现，见 `.env.example` 与 `docs/api.md`。
