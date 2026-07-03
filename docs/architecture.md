# Architecture

## Overview

The Pi Enterprise Sandbox is designed with a **layered security architecture** where the Sandbox Service acts as the secure execution plane, isolated from the Agent runtime.

```
┌──────────────────────────────────────────────────┐
│                  WebUI (Node.js)                  │
│    Server: routes, SSE streaming, conversation   │
│    Client: chat UI, tool visualization           │
├──────────────────────────────────────────────────┤
│              Pi Agent Runtime                     │
│    Tool Adapter → Policy Check → SandboxClient   │
├──────────────────────────────────────────────────┤
│           Sandbox Service (FastAPI)               │
│    Session/Workspace/Execution/File/Artifact     │
│    Audit Logging · Resource Limits · MCP Export  │
│    SQLite Persistence (WAL mode)                 │
├──────────────────────────────────────────────────┤
│          Isolated Workspace (container)           │
│    iptables · ulimit · non-root · path security  │
└──────────────────────────────────────────────────┘
```

## Key Design Decisions

### 1. HTTP API (not MCP) for Agent↔Sandbox

| Why | Details |
|---|---|
| **Simplicity** | HTTP is easier to debug, log, and instrument |
| **Universal** | Every language has an HTTP client |
| **Maturity** | Load balancers, rate limiters, auth proxies all speak HTTP |
| **MCP** | Still available as an **external-facing adapter** on port 8091 |

The Sandbox exposes a RESTful JSON API. The agent (or WebUI) calls it directly. MCP is an additional protocol adapter for external low-code platforms.

### 2. Session-Per-Conversation Isolation

Each conversation gets its own:
- **Sandbox Session** — unique workspace directory
- **Execution Queue** — serial execution (one command at a time)
- **File System** — workspace is a dedicated directory under `/sandbox/workspaces/`
- **Lifecycle** — session destroyed when conversation is deleted

This prevents cross-conversation interference and simplifies cleanup.

### 3. Serial Execution per Session

All commands within a session execute **sequentially**, not in parallel. This:
- Prevents race conditions in workspace files
- Makes audit logs easier to follow
- Simplifies state management
- Each command waits for the previous one to finish

### 4. SQLite with WAL Mode

For persistence, we use SQLite with WAL (Write-Ahead Logging) mode:

- **WAL** allows concurrent reads while writing
- **No external DB** required — zero configuration
- **ACID compliant** — guaranteed transaction integrity
- **Portable** — single file, easy to backup and restore
- **Fast** — sufficient for single-instance deployments

### 5. Approval Workflow for High-Risk Tools

Tools are classified by risk level:
- **Low** (`read`, `write` text) — always allowed
- **Medium** (`write` binary, `edit`) — logged, auto-allowed
- **High** (`bash`, `raw_bash`) — requires explicit approval or auto-rejects after timeout

The approval flow:
1. Tool call arrives at Sandbox
2. Policy Checker evaluates risk level
3. High-risk → Status `PENDING_APPROVAL`, returns `approval_id`
4. External system calls `/approve` with `approval_id` + decision
5. Expired approvals auto-reject (configurable timeout)

### 6. Trace ID Throughout

Every request carries an `X-Trace-Id` header that:

- Is echoed back in response headers
- Gets logged in audit records
- Links executions, artifacts, and sessions together
- Can be queried via `GET /traces/{trace_id}`

### 7. Non-Root Execution

All subprocesses run as an unprivileged user (`sandbox`), not `root`. This:
- Prevents container escape via command injection
- Limits damage from compromised commands
- Works with `ulimit` for resource control

### Main data flows

```
Session Lifecycle:
  POST /sessions → create workspace → return session_id
  GET  /sessions/{id} → get session status
  DELETE /sessions/{id} → cleanup workspace → expire session

Execution Flow:
  1. POST /sessions/{id}/executions/python|command
  2. Policy check (risk level evaluation)
  3. [High risk] → PENDING_APPROVAL → wait for /approve
  4. Execute subprocess in workspace
  5. Capture stdout/stderr (truncated at limit)
  6. Register execution record + audit log
  7. Return result with trace_id

File Operations:
  POST /sessions/{id}/files/write → path validation → write to workspace
  GET  /sessions/{id}/files/read?path= → path validation → read from workspace
  GET  /sessions/{id}/files → list workspace contents
  GET  /sessions/{id}/files/preview?path= → first N lines

Artifact Management:
  POST /sessions/{id}/artifacts/register → register output file as artifact
  GET  /sessions/{id}/artifacts → list artifacts
  GET  /sessions/{id}/artifacts/{aid}/download → download artifact

WebUI Chat:
  1. POST /api/conversations → create conversation + sandbox session
  2. POST /api/conversations/{id}/chat (SSE) → stream tokens, tool events
  3. Agent receives system prompt + user message
  4. Agent calls tools → proxied through Sandbox API
  5. Tool events streamed to client as SSE events
  6. Final response streamed token-by-token
```

## Security Model

| Layer | Protection |
|---|---|
| **Docker** | Container isolation, read-only root FS |
| **iptables** | Default DROP policy, no outbound network |
| **non-root** | subprocess runs as `sandbox` user |
| **ulimit** | CPU time, memory, process count limits |
| **Path validation** | `resolve()` + `is_relative_to()` — prevents escape |
| **Command blocking** | `sudo`, `su`, `rm -rf /`, `dd`, `mkfs`, `fdisk` blocked |
| **Output limits** | stdout/stderr capped at configurable char limit |
| **Audit logging** | All executions logged with trace_id |
| **Approval** | High-risk commands require external approval |

## Technology Stack

| Component | Technology |
|---|---|
| Sandbox API | Python 3.11+ / FastAPI |
| Persistence | SQLite (WAL mode) via aiosqlite |
| WebUI Server | Node.js / HTTP |
| WebUI Frontend | Vanilla JS (ES modules) |
| Agent SDK | Pi Agent Core + TypeScript Extension |
| MCP Adapter | Python `mcp` library |
| Container | Docker, docker compose |
| Testing | pytest, pytest-asyncio, TestClient |
