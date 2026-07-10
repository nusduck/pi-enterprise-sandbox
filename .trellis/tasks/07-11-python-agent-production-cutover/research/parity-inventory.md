# Node `handleChat` vs Python `sandbox/agent` parity inventory

Date: 2026-07-11  
Sources: `api-server/routes/chat.js`, `api-server/sandbox-tools.js`, `sandbox/agent/agent_runtime.py`, `sandbox/routers/agent_router.py`, `frontend/src/main.js`.

## SSE event contract

| Event | Node | Python (pre-cutover) | Gap / action |
|-------|------|----------------------|--------------|
| `trace` | Yes (early + on session) | Only via `session.trace_id` | Emit explicit `trace` from Python + BFF proxy |
| `session` | `session_id`, `workspace_path`, `conversation_id`, `session_reused`, `trace_id` | `session_id`, `trace_id` only | Add conversation/workspace/reused fields |
| `token` | Yes (deltas) | Yes (full content chunk per LLM call) | Acceptable; same event type |
| `tool_start` / `tool_end` | Yes | Yes | Align fields (`id`, `name`, `args` / `result`, `isError`) |
| `file_ready` | On `submit_artifact` only | Same | Keep explicit-submit only |
| `approval_required` | Yes (bash gate) | Missing | Wire approval-check + poll + SSE |
| `error` | Yes | Yes | Keep |
| `done` | Yes (success path) | Yes (success path) | Keep |
| `session_closed` | Yes (finally) | Missing | Emit from agent router |

Frontend consumers (`frontend/src/main.js`): `trace`, `session`, `token`, `tool_start`, `tool_end`, `file_ready`, `approval_required`, `error`, `done`, `session_closed`.

## Multi-turn history

| Surface | Node | Python | Gap / action |
|---------|------|--------|--------------|
| Restore prior turns | `toAgentHistoryMessages(prior)` then `session.prompt(last)` | `MessageManager.to_agent_history` | **Bug**: `agent_router` double-restored full history including last user message before pop | Fix single restore of `prior` only |
| Window | Last 40 messages | Last 40 | OK |
| Persist to conversation DB | Yes after turn | Yes (`persist_turn_messages` after clean stream) | Closed in cutover check |

## Tools

| Tool | Node | Python | Gap / action |
|------|------|--------|--------------|
| `read` | Sandbox files (+ local skill paths) | Sandbox files only | Skill local-read deferred; workspace read OK |
| `write` | Yes | Yes | OK |
| `edit` | Yes (read→replace→write) | **Missing from tool defs / exec** | Add `edit` |
| `bash` | Approval gate then execute | Execute only | Add approval gate |
| `submit_artifact` | Yes → `file_ready` | Yes → `file_ready` | OK |

## Approval

| Surface | Node | Python | Gap / action |
|---------|------|--------|--------------|
| Pre-check | `POST .../approval-check` | None | Call same endpoint |
| UI event | `approval_required` SSE | None | Emit compatible payload |
| Wait | Poll `GET /approvals/{id}` up to 5m | None | Same poll loop |
| Fail-safe | Bash fails closed on check error | N/A | Match Node fail-closed for bash |

## Trace

| Surface | Node | Python | Gap / action |
|---------|------|--------|--------------|
| Generate | UUID per chat turn | `trace_{uuid}` on session create | Accept inbound `X-Trace-Id` from BFF |
| Propagate | All sandbox-client calls | Headers when `_trace_id` set | Ensure all tool HTTP calls include it |

## Artifacts

| Surface | Node | Python | Status |
|---------|------|--------|--------|
| Explicit submit only | Yes | Yes | OK |
| No auto `file_ready` on write/edit | Yes | Yes | OK |

## Cancel / abort

| Surface | Node | Python | Gap / action |
|---------|------|--------|--------------|
| Client disconnect | `cancelActiveExecution(session)` | `execution_manager.cancel_active(sid)` on disconnect | Keep; proxy must abort upstream fetch so FastAPI sees disconnect |
| Explicit cancel API | Via executions | Same sandbox API | OK |

## Conversation / session reuse

| Surface | Node | Python | Gap / action |
|---------|------|--------|--------------|
| Create/reuse conversation | Yes | Body fields only | Resolve conversation + RUNNING sandbox session in Python runtime |
| Bind `sandbox_session_id` | Yes | Partial | Bind after create |

## Cutover control

| Surface | Plan |
|---------|------|
| Config | `AGENT_RUNTIME=node\|python` on api-server (default **`node`**) |
| Python path | BFF proxies `POST /api/chat` → sandbox `POST /agent/chat` SSE pass-through |
| Rollback | Set `AGENT_RUNTIME=node` and restart api-server; no frontend redeploy |
| Health | `/api/status` reports `agent_runtime` |

## Deferred (explicit)

- Node local skill-file read shortcuts (`/home/sandbox/skill/...` from api-server FS) — Python reads via sandbox/skills mount instead.
- Streaming token deltas vs whole LLM content chunks (contract type-compatible).
- Full multi-user ownership (out of scope for this task).
- Default flip to `python` production — only after parity evidence; **not** done in this change.
