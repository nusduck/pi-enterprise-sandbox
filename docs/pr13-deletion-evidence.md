# PR-13 Deletion Evidence

Static call-graph / production-bootstrap evidence for removed compatibility paths.
**Do not re-introduce** dual Run authority, process-local SSE buffers, metadata-only READY
artifacts, or Sandbox-mounted `/agent-runs` / `/agent-sessions`.

## Production bootstrap (new path only)

| Entry | Path | Authority |
| --- | --- | --- |
| Agent HTTP | `agent/server.js` → `src/bootstrap/http-main.js` → `container.js` + `create-http-server.js` | MySQL Create/Get/Cancel + Redis SSE |
| Agent Worker | `agent/worker.js` → `src/bootstrap/worker-main.js` → `run-worker.js` | BullMQ → ExecuteRunService |
| BFF Run | `api-server/routes/runs.js` → `services/agent-client.js` | Agent MySQL only |
| BFF conversation events | `api-server/routes/conversations.js` → `agent-client.listAgentRuns/listAgentEvents` | Agent MySQL only (`format=json`) |
| Sandbox HTTP | `sandbox/main.py` FastAPI app | Session/exec/files/artifacts/datasets only — **no** agent Run/Session |

**Canonical Agent Run endpoint:** Agent service `POST/GET /internal/agent-runs` (MySQL).
**Not** Sandbox root `/agent-runs` (removed).

## Sandbox legacy routers removed (severe follow-up)

### Call graph before removal

| Surface | Production callers | Offline/test callers |
| --- | --- | --- |
| `sandbox/routers/agent_runs.py` (`/agent-runs`, `/tool-executions`) | `main.py` `include_router`; startup/cleanup `agent_run_manager.reap_expired_runs`; `execution_stream` dual-write `append_event` | `test_ownership`, `test_b6_runtime_interaction`, `test_agent_events`, tool-ledger unit tests |
| `sandbox/routers/agent_sessions.py` (`/agent-sessions`, `/conversations/{id}/agent-session`) | `main.py` `include_router` only; **no ownership checks** on handlers | `test_agent_session_persistence` |
| `agent_run_manager` / `agent_session_manager` | routers + dual-write + reaper | unit tests injecting SQLite repos |
| Agent/BFF sandbox-client `/agent-runs` methods | already removed in prior PR-13 pass | — |

**Before:** dual mutable Run authority (Agent MySQL + Sandbox SQLite `agent_runs` via public HTTP).
**Before:** `/agent-sessions` exposed Pi session JSONL state without owner gates.

### Deleted (this follow-up)

| Path | Evidence for safe delete |
| --- | --- |
| `sandbox/routers/agent_runs.py` | Unmounted; no Agent/BFF production client remains |
| `sandbox/routers/agent_sessions.py` | Unmounted; unowned HTTP surface |
| `sandbox/services/agent_run_manager.py` | Only routers, dual-write, reaper, exclusive tests |
| `sandbox/services/agent_session_manager.py` | Only agent_sessions router + exclusive tests |
| Startup/cleanup reaper of agent runs in `main.py` | Dual authority reaper |
| `execution_stream` `_dual_write` → `agent_run_manager` | Dual event authority |
| Client `/tool-executions` helpers on agent/api-server sandbox-client | Only served by deleted agent_runs router |

### Tests

| Action | Files |
| --- | --- |
| Deleted (legacy dual authority) | `test_agent_events.py`, `test_tool_ledger.py`, `test_b6_runtime_interaction.py`, `test_agent_run_usage.py`, `test_extension_runtime_projection.py`, `test_agent_session_persistence.py` |
| Rewritten / added | `test_ownership.py` (404 for legacy routes), `test_legacy_agent_routes_absent.py` (static + runtime 404 + route table) |

## Deleted modules (Agent — prior PR-13 pass)

| Module | Before-delete callers | Production bootstrap |
| --- | --- | --- |
| `agent/application/run-manager.js` | tests only | **not** imported by bootstrap |
| `agent/runtime/agent-runtime.js` + session dual-write stack | run-manager + kit-era tests | none under `agent/src` |
| `agent/infrastructure/mcp-connection-manager.js` | agent-runtime only | `pi-mcp-adapter` only |
| process-local SSE (`sdk-sse-map` / `event-bridge`) | agent-runtime | `RunEventSseService` |

Retained `agent/runtime/tool-contract.js` for kit test allowlists — not a Run path.

## Artifact compatibility removed

| Path | Evidence |
| --- | --- |
| `ArtifactManager.register` metadata-only READY | Removed; submit-only |
| `hash_file_streaming` / `resolve_download_path` | Uncalled aliases removed |
| Frontend workspace path artifact download | `getArtifactDownloadUrl` only |

## Workspace symlink

| Item | Status |
| --- | --- |
| Global presentation symlink | Removed (PR-07); `LEGACY_WORKSPACE_LINK` constant deleted |
| `/home/sandbox/workspace` | Kept as Bubblewrap logical bind — not a dual store |

## SQLite boundary (precise)

| Layer | Role after PR-13 severe follow-up |
| --- | --- |
| Production `SANDBOX_DATABASE_URL` | **MySQL only** (`validate_production_settings` rejects sqlite/postgres) |
| Offline conftest | May inject `sqlite://` for hermetic **non-Run** subsystems (sessions, executions, processes, approvals, audit, retention child tables) |
| Sandbox tables `agent_runs` / `agent_sessions` / `tool_executions` in SQLite schema | Schema + `AgentRunRepository` remain for **retention purge** of orphan historical rows only (`ttl_cleanup`). **No public API** creates or reads them as Run/Session authority. |
| Module-level legacy managers | **Deleted** — production startup no longer imports `agent_run_manager` / `agent_session_manager` |

Do **not** treat residual SQLite table DDL as dual Run authority: authority is absence of HTTP + absence of dual-write + Agent MySQL for runs.

## Intentionally deferred (see review-deferred-items.md)

- Wholesale SQLite backend removal / MySQL-only offline suite
- Deleting unused Pydantic models / `AgentSessionRepository` class bodies still in `repositories.py` (no production import of manager; hygiene only)
- Full removal of `enterprise-agent-kit` package (lockfile forbidden this PR)
- Dockerfile empty `/sandbox/workspace` dir; HTTP artifacts `/register` alias
