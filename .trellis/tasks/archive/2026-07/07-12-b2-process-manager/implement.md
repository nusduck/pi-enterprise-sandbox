# Implement — B2

## Checklist

- [x] ProcessManager in sandbox (spawn, track PID, TTL hooks)
- [x] process_* tools registered for agent
- [x] Persistence of process_executions
- [x] HTTP control APIs
- [x] Orphan detection on restart
- [x] Cancel cascade from run cancel
- [x] Keep sync bash for short commands
- [x] Tests: start/logs/stdin/stop/orphan/cancel

## Validation

```bash
uv run pytest tests/ -q --tb=short -k process
node --test agent/tests/*.test.js
```

## Agent Run Notes

### Files changed

**Sandbox (Python)**
- `sandbox/services/process_manager.py` — ProcessManager: start/status/logs/wait/stdin/signal/cancel, log buffer, orphan scan, session/run cascade
- `sandbox/routers/processes.py` — REST: POST/GET /processes, logs, stdin, signal, cancel, wait, session cancel
- `sandbox/routers/executions.py` — cancel-active also stops managed processes
- `sandbox/models.py` — ProcessStatus + request/response models
- `sandbox/repositories.py` — ProcessRepository
- `sandbox/database.py` — migration `0002_process_executions` + expand `migrate_process`
- `sandbox/main.py` — register router; lifespan orphan re-scan
- `sandbox/config.py` — `max_managed_processes`
- `tests/test_process_manager.py` — unit + HTTP coverage
- `tests/test_database_baseline.py` — expect full MIGRATIONS list

**Agent (Node)**
- `agent/sandbox-tools.js` — process_start/status/logs/wait/write_stdin/signal/cancel tools
- `agent/services/sandbox-client.js` — process HTTP client methods
- `agent/chat-runner.js` — BASE_TOOL_NAMES + prompt guidance (bash short; process_* long)
- `agent/extensions/sandbox-security.js` — side-effect classes; process_start command policy; process timeout exemption
- `agent/run-manager.js` — cancel cascade via cancelActiveExecution + cancelSessionProcesses
- `agent/tests/process-tools.test.js` — tool registration + client wiring
- `agent/tests/sdk-compat/tool-overrides.test.js` — allowlist updated

### Summary

1. Sandbox owns OS processes via ProcessManager (Popen + process groups + reader threads).
2. `process_executions` persists lifecycle; runner restart marks non-terminal rows **orphaned**.
3. HTTP Process Control APIs per ADR §10; session cancel endpoint + cancel-active cascade.
4. Agent tools registered and allowlisted; sync `bash` retained for short commands.
5. Run cancel stops managed processes (all non-terminal for the session).

### Verification

- `uv run python -m pytest tests/ -q -k "process or execution_manager or database_baseline"` → **35 passed**, 3 skipped
- `node --test agent/tests/process-tools.test.js agent/tests/sdk-compat/tool-overrides.test.js agent/tests/sandbox-security.test.js` → **32 passed**

### Risks

- **waiting_input** is modeled but not auto-detected (no PTY); reserved for interactive heuristics later.
- Log buffer is in-memory with ring truncation; B3 will add streaming SSE deltas / durable log pages.
- Migration id `0002_process_executions` may collide if parallel B1 lands a different `0002_*` — renumber on merge if needed.
- Background process TTL / quota enforcement is minimal (`max_managed_processes` only); full TTL policy is stretch.
- process_signal classified high-risk (approval when APPROVAL_ENABLED); process_cancel is normal write-class.
