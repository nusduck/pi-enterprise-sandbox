# Implement — B3

## Checklist

- [x] Stream deltas from bash + process managers
- [x] Persist execution log chunks
- [x] SSE sequence + Last-Event-ID resume
- [x] Paginated log API
- [x] Tests for live stream + reconnect

## Validation

```bash
node --test agent/tests/*.test.js
uv run pytest tests/ -q --tb=short -k 'stream or log or event'
```

## Agent Run Notes

### Files Modified

**Sandbox (Python)**
- `sandbox/services/execution_stream.py` — **new** ExecutionStreamHub + ExecutionEventRepository (persist, fan-out, dual-write)
- `sandbox/services/process_manager.py` — emit execution_started / stdout|stderr_delta / terminal; durable chunks; subscribe/list_events; full_log_location
- `sandbox/services/execution_manager.py` — stream short bash/python/node via on_output; logs + events APIs; optional run_id
- `sandbox/utils/resource_limits.py` — `run_with_timeout(..., on_output=)` threaded streaming path
- `sandbox/routers/processes.py` — GET events, GET events/stream (SSE + Last-Event-ID)
- `sandbox/routers/executions.py` — GET logs, events, events/stream for short executions
- `sandbox/models.py` — ProcessLogsResponse.full_log_location; ExecutionLogsResponse; ExecutionEventResponse
- `sandbox/database.py` — migration `0004_execution_events` + expand `migrate_execution_events`
- `sandbox/main.py` — lifespan migrate_execution_events
- `tests/test_execution_stream.py` — **new** live stream, sequence resume, SSE, durable logs
- `tests/test_database_baseline.py` — expect execution_events / execution_log_chunks

**Agent (Node)**
- `agent/services/sandbox-client.js` — listProcessEvents, openProcessEventStream, getExecutionLogs, listExecutionEvents

### Implementation Summary

1. **Event model (ADR §4.3):** `execution_started`, `stdout_delta`, `stderr_delta`, `execution_completed` | `execution_failed` | `execution_cancelled`.
2. **Persist → stream:** Events and log chunks stored in `execution_events` / `execution_log_chunks`; in-process hub fans out to SSE subscribers with monotonic per-source sequences.
3. **Process path:** ProcessManager readers emit live deltas; reaper emits terminal with `truncated` + `full_log_location`.
4. **Bash short path:** `run_with_timeout` uses threaded readers when `on_output` is set; ExecutionManager always streams and persists.
5. **Resume:** Pull `GET .../events?after_sequence=N` and SSE `Last-Event-ID` / `after_sequence` both supported.
6. **Agent dual-write:** When `run_id` is set on process/execution, events are best-effort appended to `agent_events` for the existing run sequence model.
7. **Out of scope (as planned):** Full tool ledger (B4), frontend console (F4).

### Verification Results

- `uv run python -m pytest tests/test_execution_stream.py tests/test_database_baseline.py tests/test_process_manager.py tests/test_execution_manager.py tests/test_agent_events.py tests/test_sse_contract.py -q` → **64 passed**, 4 skipped
- `node --test agent/tests/process-tools.test.js` → **7 passed**

### Risks / follow-ups

- Dual-write to agent_events is best-effort; missing run row does not fail the process stream.
- Durable log hard-cap (`max_durable_log_chars` ~2M) stops further chunk persistence; in-memory process buffer still applies its own ring truncate.
- SSE keepalives every 15s; clients should treat `event: end` as stream close.
- Frontend workbench live console remains F4.
