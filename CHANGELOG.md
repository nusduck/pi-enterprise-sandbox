# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
