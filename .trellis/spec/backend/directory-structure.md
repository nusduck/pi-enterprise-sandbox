# 后端目录与模块职责

## Python Sandbox

```text
sandbox/
├── main.py                # FastAPI app、lifespan、middleware、router 注册
├── config.py              # SANDBOX_* Settings 单例
├── models.py              # API 请求/响应、枚举和共享 Pydantic model
├── database.py            # SQLite/PostgreSQL backend、schema 与连接兼容层
├── repositories.py        # 按实体组织的同步 SQL 数据访问
├── routers/               # HTTP 边界：解析输入、状态码、调用 service
├── services/              # session/execution/file/approval/artifact/audit/workspace 逻辑
├── security/              # 路径校验与子进程安全环境
├── agent/                 # 可选 Python Agent runtime/cutover 路径
├── mcp/                   # MCP REST/FastMCP 适配
└── utils/                 # 资源限制和子进程公共能力
```

新 REST 资源的现有落点顺序：

1. 请求/响应契约放 `sandbox/models.py`（局部实验性 body 也有放在 router 的先例，如 `auth_router.py`、`agent_router.py`）。
2. HTTP 边界放 `sandbox/routers/<resource>.py`，定义一个模块级 `router = APIRouter(...)`。
3. 业务与安全逻辑放 `sandbox/services/<resource>_manager.py` 或明确命名的 service。
4. 持久化放 `sandbox/repositories.py` 中对应 Repository；不要让普通 Router 散写 SQL。
5. 在 `sandbox/main.py` 注册 Router，并在 `tests/` 补充单元/集成覆盖。

实例：

- Session：`routers/sessions.py` -> `services/session_manager.py` -> `SessionRepository`。
- Execution：`routers/executions.py` -> `services/execution_manager.py` -> `ExecutionRepository`。
- Artifact：`routers/artifacts.py` -> `services/artifact_manager.py` -> `ArtifactRepository`。

`routers/conversations.py` 目前直接持有 `ConversationRepository`，这是当前例外，不应据此把所有新业务逻辑堆进 Router。

## Node API Server

```text
api-server/
├── server.js                    # 原生 HTTP 入口、公共 header、路径分派
├── config.js                    # 环境变量与 Sandbox auth header
├── sandbox-tools.js             # Agent 工具定义、审批等待、结果适配
├── routes/                      # /api 的 handler；chat.js 负责 SSE/Agent 编排
└── services/sandbox-client.js   # Sandbox REST client、trace、SandboxError
```

- 新 `/api` 路由：在 `routes/` 导出 `handleXxx`，由 `server.js` 做 method/path 分派。
- 新 Sandbox 调用：先加入 `services/sandbox-client.js`，由 route/tool 复用，不在多个 handler 复制 fetch 细节。
- 所有文件使用 ESM 和显式 `.js` 相对导入；`package.json` 已设置 `"type": "module"`。
- Agent 工具定义集中在 `sandbox-tools.js`，工具名还必须加入 `createAgentSession` 的 allowlist（文件内已有明确注释）。

## 命名

- Python 模块、函数、变量：`snake_case`；类/Pydantic model：`PascalCase`；模块级单例：小写名，如 `session_manager`。
- Python Router 文件多用资源复数名；Manager/Repository 使用资源单数类名。
- JavaScript 文件使用 `kebab-case.js`（如 `sandbox-client.js`），函数/变量用 `camelCase`，常量用 `UPPER_SNAKE_CASE`。
- REST JSON 和持久化字段以 `snake_case` 为主；前端本地 state 使用 `camelCase`，边界处显式映射。

## 不要做

- 不把服务端 Agent/LLM key 或工具逻辑移入浏览器。
- 不用 `/home/sandbox/workspace` 的全局展示 symlink 作为并发执行的真实 cwd。
- 不在 `server.js` 重建单体业务 switch；现有注释明确要求模块化 route。
- 不根据 `CONTRIBUTING.md` 的过期结构重建 `extensions/`、`sdk/` 或 `agent-handler.js`。

