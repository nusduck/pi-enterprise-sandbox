# Pi Enterprise Sandbox Runtime

> **Pi 负责 Agent 内核，Sandbox 负责企业级安全执行数据面，Enterprise Tool Adapter 负责将 Pi 的高风险工具调用路由到 Sandbox。**

## Architecture

```
┌──────────────────────────────┐
│  Pi Agent Runtime            │
│  - Agent Loop / Tool Calling │
│  - Skill Progressive Display │
├──────────────────────────────┤
│  Enterprise Tool Adapter     │  ← replaces Pi tool executors
│  - Policy Check              │
│  - SandboxClient             │
├──────────────────────────────┤
│  Sandbox Service (FastAPI)   │  ← HTTP API (port 8081)
│  - Session/Workspace/Exec    │
│  - File/Artifact Management  │
│  - Resource/Network Policy   │
│  - Audit Logging / Metrics   │
├──────────────────────────────┤
│  Sandbox MCP Server          │  ← MCP (port 8091)
│  - Dify / Hi-Agent / Ext.    │
└──────────────────────────────┘
```

**Key design decisions (per final design doc):**

| Decision | Choice |
|---|---|
| Pi→Sandbox protocol | **HTTP API** (not MCP) |
| External exposure | **MCP Server** (for Dify/Hi-Agent) |
| Skill mechanism | Standard Pi progressive disclosure |
| File access | Always via Sandbox API (no direct mount) |
| Security boundary | Sandbox Service, not Pi |
| Session isolation | One execution at a time per session |

## Quick Start

### Prerequisites

- Python 3.11+
- Docker & Docker Compose (for containerised deployment)

### Local Development

```bash
# Install
pip install -e .

# Start Sandbox Service
uvicorn sandbox.main:app --port 8081 --reload
```

### Docker Deployment

```bash
docker compose up --build
```

This starts:
- **sandbox** (port 8081 HTTP, 8091 MCP) — execution plane
- **pi-agent** (no exposed ports) — agent with EnterpriseToolAdapter

## API Overview

### Sessions

```bash
curl -X POST http://localhost:8081/sessions \
  -H 'Content-Type: application/json' \
  -d '{"caller_id": "pi-agent"}'
```

### Execution

```bash
# Python
curl -X POST http://localhost:8081/sessions/{id}/executions/python \
  -H 'Content-Type: application/json' \
  -d '{"code": "print(\"hello sandbox\")"}'

# Command
curl -X POST http://localhost:8081/sessions/{id}/executions/command \
  -H 'Content-Type: application/json' \
  -d '{"command": "ls -la"}'
```

### Files

```bash
# Write
curl -X POST http://localhost:8081/sessions/{id}/files/write \
  -H 'Content-Type: application/json' \
  -d '{"path": "test.txt", "content": "hello"}'

# Read
curl "http://localhost:8081/sessions/{id}/files/read?path=test.txt"
```

### Health

```bash
curl http://localhost:8081/health
curl http://localhost:8081/ready
curl http://localhost:8081/metrics
```

## MCP Tools

Exposed on port 8091 for external low-code platforms:

- `create_session` / `close_session`
- `run_python` / `run_command_limited`
- `read_file` / `write_file` / `preview_file` / `download_file`
- `list_files` / `get_artifacts`

Authentication via `X-Caller-Id` + `X-Auth-Token` headers.

## Project Structure

```
pi-sandbox/
├── sandbox/          # Sandbox Service (FastAPI)
│   ├── main.py       # App entry, routers registration
│   ├── config.py     # Settings (env-based)
│   ├── models.py     # Pydantic models
│   ├── routers/      # API routers
│   ├── services/     # Business logic
│   ├── security/     # Path validation, safe_env
│   ├── utils/        # Resource limits
│   └── mcp/          # MCP Server Adapter
├── agent/            # Agent-side SDK
│   ├── sandbox_client.py  # HTTP client
│   ├── tool_adapter.py    # Pi Tool Adapter
│   ├── tool_policy.py     # Policy checker
│   └── main.py            # Entry point
├── skills/           # Read-only skills
├── tests/            # Test suite
├── Dockerfile        # Multi-stage build
├── docker-compose.yml
└── pyproject.toml
```

## V1 Scope (Implemented)

- [x] Sandbox Service with Session/Workspace/Execution management
- [x] ToolPolicyChecker (low/medium/high risk levels)
- [x] Path escape protection (resolve + is_relative_to)
- [x] Non-root execution + safe_env
- [x] stdout/stderr preview limits
- [x] Serial execution per session
- [x] Resource limits (timeout, output size)
- [x] File API (read/write/list/preview/download)
- [x] Artifact API (register/list/download)
- [x] Audit logging
- [x] Prometheus metrics (/metrics)
- [x] Health / Readiness checks
- [x] MCP Server Adapter
- [x] Docker multi-stage build
- [x] EnterpriseToolAdapter with policy pre-check
- [x] SandboxClient SDK
