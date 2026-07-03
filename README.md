# Pi Enterprise Sandbox Runtime

> Enterprise-grade secure execution sandbox with AI agent integration, approval workflows, and a WebUI chat interface.

[![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-blue)]()
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115%2B-009688)]()
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)]()

## Features

- **🔒 Secure Sandbox** — Isolated execution environment with iptables network isolation, ulimit resource limits, and non-root process execution
- **💬 WebUI Chat** — ChatGPT-style interface with SSE streaming, tool visualization, dark/light themes
- **🛡️ Approval Workflow** — High-risk commands require manual approval; configurable timeout auto-rejects
- **🔗 Trace ID** — End-to-end tracing across sessions, executions, and audit logs via `X-Trace-Id`
- **💾 SQLite Persistence** — WAL mode database for session, execution, artifact, and audit log storage
- **📁 File Management** — Read, write, list, preview, and download files within session workspaces
- **🎨 Artifact Management** — Register, list, and download execution outputs
- **📊 Prometheus Metrics** — `/metrics` endpoint for monitoring
- **🔌 MCP Server** — External Protocol adapter for Dify/Hi-Agent integration (port 8091)
- **🧩 Built-in Skills** — Document parsing, data analysis, SQL query skills
- **🐳 Docker Support** — Multi-stage Docker build, docker compose orchestration

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     WebUI (port 3000)                     │
│    Server: routes/ + services/   Client: js/ ES modules   │
├──────────────────────────────────────────────────────────┤
│                    Sandbox Service (port 8081)            │
│    Session · Workspace · Execution · File · Artifact      │
│    Audit Logging · Approval Workflow · Resource Limits    │
│    SQLite Persistence (WAL) · Trace ID Middleware         │
├──────────────────────────────────────────────────────────┤
│              MCP Adapter (port 8091) — Optional           │
│         External protocol for low-code platforms          │
├──────────────────────────────────────────────────────────┤
│              Docker Container (sandbox)                   │
│    iptables DROP · ulimit · non-root · path security      │
└──────────────────────────────────────────────────────────┘
```

**[Full Architecture Documentation →](docs/architecture.md)**

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Git

### One-Command Start

```bash
git clone <repo-url>
cd pi-sandbox
cp .env.example .env
# Edit .env with your LLMIO_API_KEY
docker compose up --build
```

Open **http://localhost:3000** in your browser.

### Verify

```bash
# Sandbox health
curl http://localhost:8083/health

# WebUI status
curl http://localhost:3000/api/status
```

## Project Structure

```
pi-sandbox/
├── sandbox/              # FastAPI Sandbox Service
│   ├── main.py           # App entry, middleware, routers
│   ├── config.py         # Settings (env-based)
│   ├── models.py         # Pydantic request/response models
│   ├── database.py       # SQLite persistence (WAL)
│   ├── repositories.py   # Data access layer
│   ├── trace.py          # Trace ID context
│   ├── routers/          # API route handlers
│   │   ├── sessions.py   # Session CRUD
│   │   ├── executions.py # Code/command execution
│   │   ├── files.py      # File operations
│   │   ├── artifacts.py  # Artifact management
│   │   ├── approvals.py  # Approval workflow
│   │   ├── traces.py     # Trace query
│   │   ├── health.py     # Health/readiness/metrics
│   │   └── mcp_router.py # MCP adapter
│   ├── services/         # Business logic
│   │   ├── session_manager.py
│   │   ├── execution_manager.py
│   │   ├── file_manager.py
│   │   ├── artifact_manager.py
│   │   ├── workspace_manager.py
│   │   ├── audit_logger.py
│   │   ├── policy_checker.py
│   │   └── approval_manager.py
│   ├── security/         # Path validation, safe env
│   ├── mcp/              # MCP server adapter
│   └── utils/            # Resource limits
├── webui/                # WebUI (Node.js)
│   ├── server.js         # Entry point (thin HTTP router)
│   ├── config.js         # Configuration
│   ├── services/         # Backend services
│   │   ├── sandbox-client.js
│   │   ├── conversation-manager.js
│   │   └── agent-factory.js
│   ├── routes/           # Route handlers
│   │   ├── status.js
│   │   ├── conversations.js
│   │   ├── chat.js
│   │   └── static.js
│   ├── js/               # Frontend ES modules
│   │   ├── app.js        # Main entry
│   │   ├── api.js        # API client
│   │   ├── chat.js       # Chat UI
│   │   ├── conversations.js # Conversation list
│   │   └── utils.js      # Utilities
│   ├── index.html        # Main page
│   └── style.css         # Dark/light theme
├── agent/                # Agent SDK + Pi Extension
│   ├── sandbox_client.py
│   ├── tool_adapter.py
│   ├── tool_policy.py
│   └── enterprise-sandbox-ext/
├── skills/               # Built-in skills
│   ├── document-parser/
│   ├── data-analysis/
│   └── sql-query/
├── tests/                # Test suite (14 test files)
├── docs/                 # Documentation
│   ├── architecture.md
│   ├── api.md
│   ├── deployment.md
│   ├── development.md
│   └── webui.md
├── config/               # Runtime config
├── Dockerfile
├── docker-compose.yml
└── pyproject.toml
```

## API Overview

### Sandbox Service (port 8081)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/sessions` | Create sandbox session |
| `GET` | `/sessions/{id}` | Get session details |
| `DELETE` | `/sessions/{id}` | Close session |
| `POST` | `/sessions/{id}/executions/python` | Run Python code |
| `POST` | `/sessions/{id}/executions/command` | Run shell command |
| `POST` | `/sessions/{id}/executions/approval-check` | Check tool risk |
| `POST` | `/approve` | Approve/reject execution |
| `POST` | `/sessions/{id}/files/write` | Write file |
| `GET` | `/sessions/{id}/files/read` | Read file |
| `GET` | `/sessions/{id}/files` | List files |
| `POST` | `/sessions/{id}/artifacts/register` | Register artifact |
| `GET` | `/sessions/{id}/artifacts` | List artifacts |
| `GET` | `/traces/{trace_id}` | Get trace chain |
| `GET` | `/health` | Health check |
| `GET` | `/metrics` | Prometheus metrics |

### WebUI API (port 3000)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/conversations` | List conversations |
| `POST` | `/api/conversations` | Create conversation |
| `DELETE` | `/api/conversations/{id}` | Delete conversation |
| `PATCH` | `/api/conversations/{id}` | Rename conversation |
| `GET` | `/api/conversations/{id}/messages` | Get message history |
| `POST` | `/api/conversations/{id}/chat` | Send message (SSE stream) |
| `GET` | `/api/status` | Server + sandbox status |

**[Full API Reference →](docs/api.md)**

## Configuration

All configuration is via environment variables. See [deployment guide](docs/deployment.md#environment-variables-reference) for the complete reference.

Key variables:

| Variable | Default | Description |
|---|---|---|
| `LLMIO_API_KEY` | — | **Required** — API key for the LLM |
| `LLMIO_BASE_URL` | — | LLM API base URL |
| `PI_MODEL` | `deepseek-v4-flash` | Model to use |
| `SANDBOX_PORT` | `8081` | Sandbox service port |
| `SANDBOX_HOST_PORT` | `8083` | Host port for sandbox |
| `SANDBOX_LOG_LEVEL` | `INFO` | Log level |
| `SANDBOX_DATABASE_URL` | `sqlite:////sandbox/data/sandbox.db` | DB URL |
| `SANDBOX_SESSION_TTL_MINUTES` | `30` | Session idle timeout |

## Testing

```bash
# Run all tests
uv run pytest -q

# With coverage
uv run pytest --cov=sandbox --cov-report=term-missing

# Specific test areas
uv run pytest tests/test_integration.py -v  # End-to-end API tests
uv run pytest tests/test_webui_api.py -v    # WebUI API tests
uv run pytest tests/test_approval.py -v     # Approval workflow
uv run pytest tests/test_persistence.py -v  # Database persistence
```

## Documentation Index

| Document | Description |
|---|---|
| [Architecture](docs/architecture.md) | Design decisions, data flows, security model |
| [API Reference](docs/api.md) | Full API documentation with examples |
| [Deployment Guide](docs/deployment.md) | Docker, production config, troubleshooting |
| [Development Guide](docs/development.md) | Local setup, workflows, testing, coding standards |
| [WebUI Guide](docs/webui.md) | Frontend architecture, SSE events, theming, extending |
| [Contributing](CONTRIBUTING.md) | How to contribute, code style, PR checklist |
| [Changelog](CHANGELOG.md) | Version history and release notes |

## Roadmap

- [x] Sandbox Service with session/workspace/execution management
- [x] Security: path validation, non-root, iptables, command blocking
- [x] Resource limits: timeout, output size, memory, CPU, process count
- [x] File API: read, write, list, preview, download
- [x] Artifact management
- [x] Audit logging with trace IDs
- [x] Prometheus metrics
- [x] Health/readiness checks
- [x] MCP server adapter
- [x] SQLite persistence (WAL mode)
- [x] Approval workflow for high-risk tools
- [x] WebUI chat interface with SSE streaming
- [x] Frontend/backend separation with modular architecture
- [x] Light/dark theme support
- [x] Built-in skills (document parser, data analysis, SQL query)
- [x] Comprehensive documentation
- [x] WebUI API test suite
- [ ] Authentication/authorization (JWT or OAuth2)
- [ ] User management and multi-tenancy
- [ ] PostgreSQL support for high-availability deployments
- [ ] Rate limiting per session
- [ ] File upload through WebUI
- [ ] Real-time workspace file browser in WebUI
