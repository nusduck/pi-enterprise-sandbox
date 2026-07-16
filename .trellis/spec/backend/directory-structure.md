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
├── isolation/             # bubblewrap / direct 执行隔离
├── security/              # 路径校验与子进程安全环境
└── utils/                 # 资源限制和子进程公共能力
```

> `sandbox/agent/`（Python Agent Runtime）与空壳 `sandbox/mcp/` 已删除；Agent 编排在独立 Node `agent/` 服务，外部 MCP 在 Agent 侧连接。

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

## Node API Server (BFF)

```text
api-server/
├── server.js                    # 原生 HTTP 入口、公共 header、路径分派
├── config.js                    # 环境变量与 Sandbox / Agent auth
├── application/                 # 会话、timeline、approval decision 等应用服务
├── http/                        # body / cookies / errors / response 小工具
├── routes/                      # /api handlers（runs SSE relay、files、auth…）
└── services/                    # sandbox-client.js + agent-client.js
```

- 新 `/api` 路由：在 `routes/` 导出 `handleXxx`，由 `server.js` 做 method/path 分派。
- 新 Sandbox / Agent 调用：先加入 `services/*-client.js`，由 route 复用，不在多个 handler 复制 fetch 细节。
- **BFF 不 import `pi-coding-agent`**；Agent 工具定义在 `agent/packages/enterprise-agent-kit`。
- 所有文件使用 ESM 和显式 `.js` 相对导入；`package.json` 已设置 `"type": "module"`。

## Node Agent

```text
agent/
├── server.js                    # 内部 Run API / health / ready
├── config.js                    # LLM、Sandbox、内部令牌、技能模式
├── application/                 # run-manager、profile、governance、diagnostics
├── runtime/                     # agent-runtime、session-bootstrap、event-bridge、helpers
├── infrastructure/              # sandbox-client、mcp-connection-manager
├── services/                    # budget、waiters、model-registry、session-persistence、sse-map
├── packages/enterprise-agent-kit/  # customTools + Extension 包
├── skills/                      # skill manager（install/edit/reload 支撑）
├── testing/                     # fake OpenAI provider
└── tests/                       # unit + sdk-compat
```

- 入口只留 `server.js` + `config.js`；不要在 agent 根目录再堆 facade（已删除 `chat-runner.js` / `sandbox-tools.js`）。
- SDK 会话循环只在 `runtime/`；企业工具只经 kit Extension / customTools。

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

