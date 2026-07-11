# 后端编码与质量规范

## Python 代码风格（当前事实）

- Python 要求 `>=3.11`；模块普遍先写 module docstring，再写 `from __future__ import annotations`。
- 公共/核心函数使用类型标注，集合使用内置泛型和 `X | None`；Pydantic model 表达 API 契约。
- 文件路径优先 `pathlib.Path`，时间使用 timezone-aware UTC，ID 使用可读前缀 + UUID 片段。
- 类承载有状态职责，模块末尾提供运行时单例：`session_manager`、`execution_manager`、`policy_checker`。
- 安全常量使用模块级 `_UPPER_SNAKE_CASE`，内部 helper 以 `_` 开头。
- 同步/异步由边界需求决定：普通 Router/Service/DB 多为同步；stream、upload、lifespan、MCP 等 I/O 边界使用 async。

真实实例：`sandbox/services/session_manager.py`、`sandbox/security/path_validation.py`、`sandbox/routers/executions.py`。

## JavaScript 服务端风格

- ESM `import/export`，相对导入带 `.js`；`const` 优先，确需重绑定才用 `let`，不使用 `var`。
- 2 空格缩进、单引号为主、分号结尾；异步流程使用 `async/await`。
- 对外 helper 用 named export；Sandbox 客户端常以 `import * as sb` 聚合调用。
- 复杂协议对象用小型纯函数转换：`extractMessageText`、`toAgentHistoryMessages`、`extractToolDetails`。
- HTTP/SSE handler 负责边界适配，底层 fetch 统一在 `sandbox-client.js`。

真实实例：`api-server/routes/chat.js`、`api-server/routes/conversations.js`、`agent/sandbox-tools.js`。

## 测试模式

- 单元测试与文件同职责命名：`test_<module>.py`；相关测试可用 `class TestXxx` 分组。
- 共享可变对象优先 fixture 新建；需要模块级 FastAPI client 时配套清理 session/workspace。
- 文件系统测试使用 `tmp_path`；全套测试路径通过 `tests/conftest.py` 在 import 之前隔离。
- API 测试断言 status 和关键 payload；安全测试同时覆盖允许与拒绝路径。
- 配置/脚本契约可通过读取文本或 `subprocess.run(..., check=False)` 断言，错误输出放入 assert message。

新增行为至少补最近一层测试；跨 Router/Service/Repository 或跨服务协议变更再补集成测试。

## 权威验证命令

与 `.github/workflows/test.yml` 对齐（Node **22**；分 job：python / node-bff / node-agent / frontend / compose / cross-service-smoke）：

```bash
# Python
uv sync --extra test
uv run pytest tests/ -q --tb=short

# 定向
uv run pytest tests/test_<area>.py -v

# Node BFF
npm ci --prefix api-server
node --test api-server/tests/*.test.js
find api-server -name '*.js' -type f ! -path '*/node_modules/*' -exec node --check {} \;

# Node Agent（含 sdk-compat + fake provider）
npm ci --prefix agent
node --test agent/tests/*.test.js agent/tests/sdk-compat/*.test.js
find agent -name '*.js' -type f ! -path '*/node_modules/*' -exec node --check {} \;

# Frontend
npm ci --prefix frontend
npm test --prefix frontend
npm run build --prefix frontend

# Compose
test -f .env || cp .env.example .env
docker compose config -q

# 无真实 LLM key 跨服务 smoke（production 禁止 AGENT_ENABLE_FAKE_LLM）
node scripts/smoke-cross-service.mjs
```

`CONTRIBUTING.md` 还建议 `ruff check .`/`black --check .`，`docs/development.md` 建议 Ruff/Mypy/coverage；当前 `pyproject.toml` 与 CI 没有相应强制 job，因此只能作为建议，不能声称强制通过。

## Review 检查

- API/SSE 向后兼容：字段、状态码、event type、download 语义。
- 安全：路径边界、最小环境、资源限制、审批、secret 脱敏。
- 并发：真实 cwd 使用物理 workspace，同一 session lock 始终释放。
- 持久化：SQLite/PostgreSQL、commit、JSON/boolean/row 映射一致。
- 生命周期：创建、复用、TTL、删除时 workspace 与 DB 状态一致。
- 文档：API/环境变量/部署行为变化时更新活跃 `docs/` 和 `.env.example`。
- E2E：跨 BFF/Agent/Sandbox 或资源限制边界的行为必须在真实 Compose 容器中至少运行一条成功路径；包级 mock 不能替代启动/import、网络、cwd、资源限制和 artifact 提交检查。

## 待确认

- **待确认：** formatter/linter/type checker 的唯一选型与版本锁定。
- **待确认：** 最低覆盖率阈值和哪些 E2E 属于合并门禁。
- **已落地：** Node API 与 Frontend 均使用 `node:test`（`api-server/tests/`、`frontend/test/`），CI 分 job 执行。
