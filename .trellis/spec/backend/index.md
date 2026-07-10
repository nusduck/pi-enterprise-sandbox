# 后端开发规范

本层同时覆盖两个服务端边界：

- `sandbox/`：Python 3.11+、FastAPI、Pydantic、SQLite/PostgreSQL。
- `api-server/`：Node.js ESM、原生 `node:http`、`pi-coding-agent`、SSE。

## 开发前检查

- 先确认变更属于 Router、Service、Repository、Node route/client 还是跨层协议。
- 涉及文件、命令、环境变量或产物时，先读安全边界：`path_validation.py`、`safe_env.py`、`policy_checker.py`。
- 涉及跨服务字段时，同时检查 Pydantic model、Sandbox route、Node client/route、Frontend consumer 和 `docs/api.md`。
- 数据库变更先确认 SQLite 与 PostgreSQL 两套 schema/参数占位兼容性。

## 详细规范

- [directory-structure.md](directory-structure.md)
- [database-guidelines.md](database-guidelines.md)
- [error-handling.md](error-handling.md)
- [logging-guidelines.md](logging-guidelines.md)
- [quality-guidelines.md](quality-guidelines.md)
- 跨服务架构与命令见 [../project-architecture.md](../project-architecture.md)

## 质量检查

- HTTP 状态码、响应字段和 SSE 事件是否保持兼容。
- 是否仍以物理 session workspace 做真实 I/O，且路径经过统一校验。
- secret 是否仅存在服务端，日志是否脱敏，trace 是否贯穿。
- 是否为新行为补充同层单元测试及必要的 `TestClient` 集成测试。
- 至少运行受影响测试；前端/Node 变更同时运行 `node --check`，前端变更运行 Vite build。

