# 项目架构、构建与通用模式

## 系统定位

Pi Enterprise Sandbox 是一个四服务全栈仓库：浏览器 UI、薄 Node BFF、独立 Node Agent、Python FastAPI 安全沙箱分别运行，默认由 Docker Compose 组合。

```text
Browser
  -> frontend (Vite 构建，Nginx 静态托管与 /api 反代)
  -> api-server (Node 22 BFF：auth/files/SSE relay)
  -> agent (Node 22：pi-coding-agent SDK / Run API；零内置 Skill)
  -> sandbox (FastAPI、执行/文件/审批/产物/持久化/MCP)
  -> per-session workspace_id + PostgreSQL(prod) / empty SQLite(dev·test)
```

证据：`docker-compose.yml`、`frontend/nginx.conf`、`api-server/server.js`、`agent/server.js`、`sandbox/main.py`、`docs/architecture.md`。

## 顶层目录职责

| 路径 | 当前职责 | 示例 |
|---|---|---|
| `sandbox/` | Python 3.11+ FastAPI 服务及安全执行运行时（无 Agent 主循环） | `sandbox/main.py`、`sandbox/routers/executions.py` |
| `api-server/` | 薄 BFF：认证、会话/文件边缘、chat SSE relay | `api-server/routes/chat.js`、`api-server/services/agent-client.js` |
| `agent/` | 独立 Agent Runtime：SDK、tools、extensions、内部 Run API | `agent/runtime/agent-runtime.js`、`agent/server.js` |
| `frontend/` | React + TypeScript Agent Runtime Workbench，Vite 构建，Nginx 托管 | `frontend/src/main.tsx`、`frontend/src/features/chat/ChatContext.tsx`、`frontend/src/entities/store.ts` |
| `tests/` | 统一 pytest 测试，包括单元、FastAPI 集成、配置/容器契约 | `tests/test_integration.py`、`tests/test_container_startup.py` |
| `skills/` | 空发行基线；研发环境可通过受审计 install/edit/reload 引入 Skill | 初始无 package |
| `config/agent/` | Agent 模型和运行时配置 JSON | `models.json`、`settings.json` |
| `nginx/` | 生产入口、TLS 与跨服务反向代理 | `nginx/conf.d/sandbox.conf` |
| `scripts/` | 运维脚本 | `backup.sh`、`restore.sh` |
| `docs/` | API、架构、开发与部署文档；`archive/` 不是当前规范 | `docs/api.md`、`docs/deployment.md` |

`CONTRIBUTING.md` 仍提到已删除的 `extensions/`、`sdk/` 和旧文件名；新增代码不得据此恢复这些目录。删除事实可由当前目录和提交 `3489846a` 交叉确认。

## 主要数据流

### 对话与工具调用

1. `frontend/src/shared/api/client.ts` 向 `POST /api/chat` 提交完整消息历史并消费 SSE。
2. `api-server/routes/chat.js`（BFF）创建 Agent run（`POST /internal/agent-runs`）并 relay 序列化 SSE；**不** import `pi-coding-agent`。
3. `agent/runtime/agent-runtime.js`（经 `application/run-manager.js`）创建/复用 conversation 与 sandbox session，初始化 `pi-coding-agent`。
4. `enterprise-agent-kit` 的 sandbox-tools Extension 将 `read/write/edit/bash/submit_artifact` 转为 Sandbox REST 调用；高风险 bash 先走审批。
5. `sandbox/routers/` 校验 HTTP 输入并调用 `sandbox/services/`；需要持久化时再进入 `sandbox/repositories.py`。
6. `token/tool_start/tool_end/file_ready/done/error` 等事件经 BFF 回到浏览器；legacy adapter 将其转为 RuntimeEvent，run reducer 单次归约到 EntityStore，React 通过 selector/projection 渲染。

### Agent session cwd

- Sandbox 创建/复用 session 后，Agent 将稳定逻辑 cwd `/home/sandbox/workspace` 贯穿 Pi SDK
  SessionManager、session header、SettingsManager、ResourceLoader 与 `createAgentSession`。
- 旧持久化 header 恢复时先把 materialized JSONL header cwd 规范化为当前逻辑 cwd，避免 runtime
  override 与 header 出现两个值。
- cwd 不是 `/var/sandbox/workspaces/...` 物理路径；Agent 不挂载 workspace volume，文件和命令仍只经
  Sandbox REST 相对路径工具执行。

### 文件与产物

- 公共协议使用 opaque `workspace_id`；工具/文件/Artifact 仅接受相对 Session 根路径。
- 物理工作区根只存在于 service/repository 内部，不进入 API/SSE/模型上下文。
- 所有用户路径必须通过 `sandbox/security/path_validation.py` 的 `resolve()` 边界校验。
- `write`/`edit` 只写私有工作区；只有显式 `submit_artifact` 注册后才作为交付物发出 `file_ready`。
- 同一 session 的执行由 `ExecutionManager._session_locks` 串行化；不同 session 使用不同物理目录。

## 跨层实现模式

### 统一边界，再下沉逻辑

- Python：Router 负责 HTTP 状态和 Pydantic 响应，Service 负责业务/安全，Repository 负责 SQL。例如 `routers/sessions.py` -> `services/session_manager.py` -> `repositories.py`。
- Node BFF：`server.js` 只分派路径，`routes/*.js` 处理 HTTP/SSE relay，`services/sandbox-client.js` / `agent-client.js` 集中下游 fetch。
- Node Agent：`server.js` 暴露内部 Run API；`runtime/agent-runtime.js` 承载 SDK 循环；`application/run-manager.js` 管 run 注册表。
- Frontend：`shared/api/` 管协议，`entities/` + `shared/state/runReducer.ts` 管 runtime 实体，
  `features/chat/ChatContext.tsx` 负责编排，`widgets/` / `pages/` 负责 React 展示。

### 配置集中化

- Python 环境变量通过 `sandbox/config.py::Settings` 读取，前缀为 `SANDBOX_`。
- Node BFF 环境变量集中在 `api-server/config.js`（`AGENT_BASE_URL`、`AGENT_INTERNAL_TOKEN`）。
- Node Agent 环境变量集中在 `agent/config.js`（LLM、Sandbox、内部令牌）。
- 容器默认值集中在 `docker-compose.yml`；生产覆盖在 `docker-compose.prod.yml`。
- 不在路由或 UI 模块新增散落的 secret/default；安全值不进入浏览器。

### 可追踪与安全默认值

- `X-Trace-Id` 由 BFF 生成/传递，Agent 透传，FastAPI middleware 回显，并写入 execution/audit 数据。
- 子进程只接收 `sandbox/security/safe_env.py` 构造的最小环境，不继承完整 `os.environ`。
- 高风险工具默认进入审批或拒绝；未知工具在 `policy_checker.py` 中按中风险处理。

### Skill 执行与变更边界

- 发行基线：`skills/` 无任何 Skill package；Agent 在零 Skill 下使用基础工具即可运行。
- 默认和生产模式使用 `SKILLS_MODE=readonly`，Agent/Sandbox 的 Skill 挂载保持只读。
- 通用 `write`、`edit` 和 Bash 不得修改 Skill 根；研发变更只能通过 `skill_install`、`skill_edit`、`skill_reload` 完成。
- 允许 Python/Shell 解释器直接执行 Skill 根下的单个只读脚本，但命令中出现重定向、管道、命令拼接或子命令替换时仍硬拒绝。
- 资源受限的 Sandbox pipeline 应优先使用轻量依赖；引入 pandas、NumPy、matplotlib 等原生扩展前，必须在容器内存限制下实际执行验证。

## 安装、开发、构建和验证命令

以下命令均从仓库根目录理解；子目录命令明确使用 `--prefix`，避免依赖当前 shell 目录。

```bash
# Python 依赖（CI 使用 uv）
uv sync --extra test

# Node 依赖（存在 package-lock.json，自动化优先 npm ci）
npm ci --prefix api-server
npm ci --prefix agent
npm ci --prefix frontend

# 本地开发（四个终端）
uv run uvicorn sandbox.main:app --port 8081 --reload
SANDBOX_BASE_URL=http://localhost:8081 npm run dev --prefix agent
SANDBOX_BASE_URL=http://localhost:8081 AGENT_BASE_URL=http://localhost:4100 \
  npm run dev --prefix api-server
npm run dev --prefix frontend

# 前端生产构建
npm run build --prefix frontend

# 完整容器栈
cp .env.example .env
docker compose up --build

# 生产 overlay
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d

```

说明：`api-server/` 与 `agent/` 的 `package.json` 没有独立 build 脚本，直接运行 ESM 源码；Python 使用 setuptools 构建元数据，但日常服务启动依赖 Uvicorn/Docker。

## 测试方式

CI 权威入口：`.github/workflows/test.yml`（并行 job，Node **22**）：

| Job | 命令摘要 |
|-----|----------|
| `python` | `uv sync --extra test` → `uv run pytest tests/ -q --tb=short` |
| `node-bff` | `npm ci --prefix api-server` → unit tests + syntax + listen smoke |
| `node-agent` | `npm ci --prefix agent` → unit/sdk-compat + listen + fake OpenAI tests |
| `frontend` | `npm ci --prefix frontend` → `npm test` → `npm run build` |
| `compose` | 确保 `.env` 存在后 `docker compose config -q` |
| `cross-service-smoke` | fake OpenAI + Sandbox + Agent + BFF，无真实 LLM key |

```bash
uv sync --extra test && uv run pytest tests/ -q --tb=short
npm ci --prefix api-server && node --test api-server/tests/*.test.js
npm ci --prefix agent && node --test agent/tests/*.test.js agent/tests/sdk-compat/*.test.js
npm ci --prefix frontend && npm test --prefix frontend && npm run build --prefix frontend
test -f .env || cp .env.example .env; docker compose config -q
node scripts/smoke-cross-service.mjs
```

测试形态包括：

- 纯单元测试：直接实例化 Manager/Checker，如 `test_session_manager.py`、`test_policy_checker.py`。
- FastAPI 集成测试：模块级 `TestClient(app)`，如 `test_integration.py`（含 `/health` liveness 与 `/ready` readiness/503）。
- Node BFF `node:test`：`api-server/tests/`（agent-client、auth、upload、listen smoke）。
- Node Agent `node:test`：`agent/tests/` + `agent/tests/sdk-compat/`（Run API、SDK pin、事件映射、Extension、fake provider）。
- Frontend `node:test`：`frontend/test/`（SSE、state、security）。
- 临时路径隔离：`tests/conftest.py` 在导入应用前覆盖 `SANDBOX_*` 路径和数据库。
- 文件/配置契约：读取 Docker/Compose 或运行 `bash -n`，如 `test_container_startup.py`。
- 无密钥跨服务 smoke：`scripts/smoke-cross-service.mjs`（`AGENT_ENABLE_FAKE_LLM`；production 禁止）。
- 手工/环境依赖 E2E：`tests/e2e_artifact_flow.py`、`tests/mcp_full_e2e.py` 不应默认视作 CI 外部服务已就绪。

## 待确认

- **待确认：** 是否将 Ruff、Black、Mypy 和覆盖率设为强制门禁。当前 `CONTRIBUTING.md`/`docs/development.md` 仅推荐，`pyproject.toml` 和 CI 未配置对应 job。
- **已落地：** Node BFF / Agent 与 Frontend 均有 `test` script（`node:test`），CI 分 job 执行。
- **待确认：** 前端 `@earendil-works/pi-web-ui` 是否仍需保留；当前 Workbench 主要使用仓库内 React widgets。
- **待确认：** 数据库 schema 变更的正式迁移/回滚流程；当前仓库没有 Alembic 或独立 migration 目录。
- **已落地：** 独立 Node Agent 服务；Python Agent Runtime 与 `AGENT_RUNTIME` 开关已删除。
