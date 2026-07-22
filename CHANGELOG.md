# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Run 收敛保护**: 为每个 Pi Run 增加模型回合、总工具调用和相同工具/参数调用上限；达到上限后禁止继续调用工具，并要求模型依据已有结果作答。三个上限均可通过 `AGENT_RUN_MAX_*` 配置。
- **MCP 启动发现**: Agent 启动时连接每个启用的 MCP Server 并执行 `tools/list`；发现到的工具以 `mcp__{serverId}__{toolName}` 注册，对应的连接与工具数量会出现在 readiness/diagnostics。

### Changed

- **Run 与对话投影**: Run 列表/详情补充模型、token usage、规范化生命周期时间及最新 durable event ID；对话历史保留 durable message ID、Run ID 与顺序，且只显示当前用户回合而非整个历史 prompt。
- **运行管理界面**: 按 Agent 的权威状态过滤 Run，支持 `WAITING_INPUT`，并兼容 `completed_at` 与历史 `finished_at` 字段。
- **Artifact 下载**: 对非 ASCII 文件名使用 RFC 5987 `filename*`，同时提供 ASCII fallback，避免下载响应因 HTTP header 编码失败。

## [4.0.0] — 2026-07-04

### Added

- **三容器架构 (v4)**: 前端 (Nginx + SPA) + API Server (Node.js + pi-coding-agent) + Sandbox (Python FastAPI)，前端零 Agent，LLM Key 仅存服务端

### Changed

- **文档全面重写**: README.md、docs/architecture.md、docs/deployment.md、docs/development.md、docs/api.md、docs/webui.md 全部基于实际代码重写
- **端口规范化**: 统一 host→container 端口标注格式，修正所有文档中的端口不一致问题
- **API 文档**: 补全三层 API（Frontend → API Server → Sandbox），新增 Conversations、Approvals、Traces、MCP 端点文档，补充 SSE 事件协议完整列表
- **部署文档**: 更新架构图和端口，标注 docker-compose.prod.yml 服务名不匹配问题

### Removed

- **旧设计文档移除**: 早期 system-design 草稿不再保留；以 `plan.md` 与活跃 `docs/*` 为准

## [0.2.0] — 2026-07-03

### Added

- **Frontend/Backend Separation**: Modularized monolithic `server.js` into 9 focused modules (`config.js`, `services/sandbox-client.js`, `services/conversation-manager.js`, `services/agent-factory.js`, `routes/status.js`, `routes/conversations.js`, `routes/chat.js`, `routes/static.js`)
- **WebUI Frontend Modules**: Split monolithic `app.js` into ES modules (`js/api.js`, `js/utils.js`, `js/chat.js`, `js/conversations.js`, `js/app.js`)
- **Light Theme**: Added toggleable light theme via `[data-theme="light"]` CSS
- **Code Copy Button**: One-click copy for code blocks in chat messages
- **Collapsible Tool Calls**: Tool execution indicators are now expandable to show arguments
- **Skeleton Loading**: Loading state animations for better UX during initialization
- **Comprehensive Documentation**: Added `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/` directory with architecture, API, deployment, development, and WebUI guides
- **WebUI Test Suite**: Added tests for the WebUI server API (`tests/test_webui_api.py`)
- **Configuration Tests**: Added tests for config defaults and version consistency
- **Entrypoint Tests**: Added tests for the sandbox entrypoint parameter handling

### Changed

- **README.md**: Completely rewritten with detailed architecture, quick start, configuration reference, and project roadmap
- **webui/index.html**: Updated to load ES modules, added theme-color meta tag
- **webui/style.css**: Enhanced with light theme variables, copy button styles, collapsible tool styles, skeleton animations
- **webui/server.js**: Now a thin entry point that delegates to route modules

### Fixed

- No bug fixes in this release

## [0.1.0] — 2026-06-28

### Added

- Sandbox Service with Session/Workspace/Execution management
- ToolPolicyChecker (low/medium/high risk levels)
- Path escape protection
- Non-root execution + safe_env
- stdout/stderr preview limits
- Serial execution per session
- Resource limits (timeout, output size)
- File API (read/write/list/preview/download)
- Artifact API (register/list/download)
- Audit logging
- Prometheus metrics
- Health / Readiness checks
- MCP Server Adapter
- Docker multi-stage build
- EnterpriseToolAdapter with policy pre-check
- SandboxClient SDK
- Pi Extension (TypeScript)
- Approval workflow for high-risk tools
- Trace ID middleware
- SQLite persistence (WAL mode)
- Session restore via enterprise_session_id
- Built-in Skills (document-parser, data-analysis, sql-query)
- WebUI chat interface with SSE streaming
