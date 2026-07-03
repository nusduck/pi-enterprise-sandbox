# API Reference

## Sandbox Service API

Base URL: `http://<host>:8081`

### Convention

- All requests/responses are JSON
- Errors return `{"detail": "message"}`
- Trace ID is passed via `X-Trace-Id` header and echoed back
- Auth token is passed via `X-Auth-Token` header (if configured)

---

### Sessions

#### `POST /sessions` — Create a new sandbox session

```json
// Request
{
  "caller_id": "pi-agent",
  "agent_session_id": "optional_agent_id",
  "enterprise_session_id": "optional_enterprise_id",
  "user_id": "optional_user_id",
  "metadata": {"key": "value"}
}

// Response (201)
{
  "session_id": "sandbox_abc123",
  "status": "RUNNING",
  "workspace_path": "/sandbox/workspaces/sandbox_abc123",
  "agent_session_id": "optional_agent_id",
  "enterprise_session_id": "optional_enterprise_id",
  "user_id": "optional_user_id",
  "created_at": "2026-07-03T10:00:00Z",
  "expires_at": "2026-07-03T10:30:00Z"
}
```

#### `GET /sessions/{session_id}` — Get session details

#### `DELETE /sessions/{session_id}` — Close session and cleanup workspace

#### `GET /sessions/by-agent/{agent_session_id}` — Look up by agent ID

#### `GET /sessions/by-enterprise/{enterprise_session_id}` — Look up by enterprise ID

#### `GET /sessions` — List all active sessions

---

### Executions

#### `POST /sessions/{session_id}/executions/python` — Run Python code

```json
// Request
{
  "code": "print('hello world')",
  "timeout": 120
}

// Response (201)
{
  "execution_id": "exec_abc123",
  "status": "SUCCESS",
  "stdout_preview": "hello world\n",
  "stderr_preview": "",
  "exit_code": 0,
  "duration_ms": 45,
  "truncated": false
}
```

#### `POST /sessions/{session_id}/executions/command` — Run a shell command

```json
{
  "command": "ls -la",
  "timeout": 120,
  "description": "optional audit description"
}
```

#### `POST /sessions/{session_id}/executions/approval-check` — Pre-check tool risk

```json
// Request
{
  "tool_name": "bash",
  "command": "rm -rf /tmp/test"
}

// Response (200 — allowed)
{
  "status": "approved",
  "risk_level": "medium"
}

// Response (202 — pending approval)
{
  "status": "pending_approval",
  "approval_id": "approval_abc123",
  "risk_level": "high",
  "message": "This command requires approval. Call POST /approve to approve or reject.",
  "expires_at": "2026-07-03T10:05:00Z"
}
```

#### `POST /approve` — Approve or reject a pending execution

```json
// Request
{
  "approval_id": "approval_abc123",
  "decision": "approve"  // or "reject"
}

// Response (200)
{
  "status": "approved",
  "approval_id": "approval_abc123",
  "execution_id": "exec_abc123",
  "timestamp": "2026-07-03T10:02:00Z"
}
```

#### `GET /sessions/{session_id}/executions` — List execution history

---

### Files

#### `POST /sessions/{session_id}/files/write` — Write a file

```json
// Request
{
  "path": "test.txt",
  "content": "file contents here"
}

// Response (201)
{
  "path": "test.txt",
  "size": 18,
  "session_id": "sandbox_abc123"
}
```

#### `GET /sessions/{session_id}/files/read?path=test.txt` — Read a file

Supports `offset` and `limit` params for pagination (line-based).

#### `GET /sessions/{session_id}/files` — List files in workspace

#### `GET /sessions/{session_id}/files/preview?path=test.txt` — First 20 lines preview

---

### Artifacts

#### `POST /sessions/{session_id}/artifacts/register` — Register an artifact

```json
{
  "name": "report.txt",
  "path": "output/report.txt",
  "mime_type": "text/plain",
  "description": "optional description"
}
```

#### `GET /sessions/{session_id}/artifacts` — List artifacts

#### `GET /sessions/{session_id}/artifacts/{artifact_id}/download` — Download artifact

---

### Traces

#### `GET /traces/{trace_id}` — Get full trace chain

Returns all executions, file operations, and audit logs associated with a trace ID.

---

### Health

#### `GET /health` — Health check

```json
{
  "status": "ok",
  "version": "0.1.0",
  "sessions_active": 0,
  "executions_total": 42,
  "workspace_available": true,
  "runtimes": {
    "python": true,
    "bash": true,
    "node": true
  }
}
```

#### `GET /ready` — Readiness check

#### `GET /metrics` — Prometheus metrics

---

## WebUI API

The WebUI server exposes its own API for the frontend. This is consumed by the browser and is separate from the Sandbox Service API.

Base URL: `http://<host>:3000`

### Conversations

#### `GET /api/conversations` — List conversations

#### `POST /api/conversations` — Create new conversation (creates sandbox session)

#### `DELETE /api/conversations/{id}` — Delete conversation (destroys sandbox session)

#### `PATCH /api/conversations/{id}` — Rename conversation

```json
{ "title": "New title" }
```

### Messages

#### `GET /api/conversations/{id}/messages` — Get message history

#### `POST /api/conversations/{id}/chat` — Send message (SSE stream)

Request: `{ "message": "user text" }`

Response is a Server-Sent Events stream:

```
data: {"type": "turn_start", "trace_id": "trace_abc"}
data: {"type": "token", "text": "Hello"}
data: {"type": "tool_start", "toolName": "bash", "args": {...}}
data: {"type": "tool_end", "toolName": "bash", "isError": false}
data: {"type": "done"}
```

### Status

#### `GET /api/status` — Server and sandbox health

```json
{
  "status": "ok",
  "conversations": 3,
  "sandbox": {
    "status": "ok",
    "sessions_active": 3
  }
}
```
