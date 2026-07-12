# Design — B2 Process Manager

## API (ADR §10)

- POST /processes, GET /processes/{id}, GET logs, POST stdin/signal/cancel

## process_start

Returns `{ process_id, status, started_at }`.

## process_logs

`{ stdout, stderr, next_offset, completed, truncated }`.

## Storage

`process_executions` table (ADR §6). Sandbox owns OS processes; Agent/BFF expose control APIs.

## Integration

Sandbox ExecutionManager / new ProcessManager service; tool registration in agent sandbox-tools.
