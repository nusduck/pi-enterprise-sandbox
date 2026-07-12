# Implement — B1

## Checklist

- [x] Schema migration for agent_sessions + agent_session_entries (+ conversation binding)
- [x] Session repository: save/load entries with sequence
- [x] JSONL materialization helper
- [x] Replace inMemory default path with open/restore
- [x] Persist entries during run (tool call/result/assistant)
- [x] session_restore_failed event + fail-closed behavior
- [x] Integration tests: multi-turn, restart, compaction, tool restore
- [x] Unit tests for materialize/open edge cases

## Validation

```bash
node --test agent/tests/*.test.js agent/tests/sdk-compat/*.test.js
uv run pytest tests/ -q --tb=short -k session
```

## Rollback

Feature-flag or config to force inMemory only if needed; never dual-write silent fallback without event.

Set `AGENT_FORCE_INMEMORY=true` on the Agent service to force `SessionManager.inMemory()` and skip DB restore (emergency only).

## Agent Run Notes

### Files changed

**Sandbox (Python)**
- `sandbox/database.py` — migration `0002_agent_sessions`; expand-safe `migrate_agent_session_schema` for `agent_sessions` / `agent_session_entries` / `conversations.agent_session_id`; initialize() applies expand after migrations
- `sandbox/models.py` — `agent_session_id` on Conversation; AgentSession* models
- `sandbox/repositories.py` — `AgentSessionRepository` (create/get/append/list/build_jsonl); Conversation bind helpers
- `sandbox/services/agent_session_manager.py` — create / resume / append orchestration
- `sandbox/routers/agent_sessions.py` — REST: create, get, resume, entries, conversation lookup
- `sandbox/routers/conversations.py` — expose/bind `agent_session_id`
- `sandbox/main.py` — register agent_sessions router

**Agent (Node)**
- `agent/services/session-persistence.js` — materialize JSONL, open/restore, map entry types, live-persist diff, fail-closed `SessionRestoreError`
- `agent/services/sandbox-client.js` — agent-session HTTP client methods
- `agent/chat-runner.js` — `resolveAgentSessionManager`; replace per-turn `inMemory()` with open/create+persist; emit `session_restore_failed`; skip last-40 text inject when SDK history restored
- `agent/config.js` — `AGENT_FORCE_INMEMORY` rollback flag

**Tests**
- `tests/test_agent_session_persistence.py` — schema, multi-turn tool/compaction JSONL, HTTP resume, fail-closed 404
- `agent/tests/session-persistence.test.js` — materialize/open, tool restore, compaction, fail-closed, same-session multi-turn
- `tests/test_database_baseline.py` — expect 0001+0002 migrations

### Verification

- `node --test agent/tests/*.test.js agent/tests/sdk-compat/*.test.js` → **138 passed**
- `uv run pytest tests/ -k session` → **66 passed**
- Related: `test_agent_events`, `test_database_baseline`, `test_multi_turn_history`, `test_persistence` green

### Remaining risks

1. **Live-persist is best-effort** on tool boundaries / end-of-turn; a hard crash mid-tool may lose the last unflushed SDK entries (header+prior entries remain). Full crash-window ledger is B4 territory.
2. **Legacy conversations** without `agent_session_id` still get one-shot last-40 text inject on first post-upgrade turn, then bind a new agent session (not silent empty overwrite of an existing bind).
3. **Temp JSONL cleanup** is best-effort after each turn; OS tmpdir TTL is the backstop.
4. **No cross-service E2E** with a live LLM in this task; restore correctness is covered by unit/integration materialize+open tests.
5. **PostgreSQL live baseline** tests only run when `TEST_POSTGRES_URL` is set (unchanged).
