# B3 — Streaming Execution Events

## Goal

命令执行过程中持续产生 execution_started / stdout_delta / stderr_delta / execution_completed|failed|cancelled；实时给 Agent 与前端；持久化；offset/sequence 分页；断线续传。

## Dependencies

- Prefer after B2 process path exists; also stream existing bash short commands.

## Acceptance Criteria

- [ ] Long command emits live stdout/stderr events
- [ ] Logs persisted and pageable
- [ ] SSE supports sequence resume
- [ ] truncated flag + full log location when truncated

## Infrastructure Note (2026-07-12)

**Dedicated PostgreSQL container is approved for this iteration.**

- Dev: `docker compose --profile postgres up -d postgres`
- URL (host): `postgresql://sandbox:sandbox_dev_only@localhost:5432/sandbox`
- URL (compose): `postgresql://sandbox:sandbox_dev_only@postgres:5432/sandbox`
- SQLite remains valid for unit tests / offline CI; live multi-turn session, process, ledger, and streaming integration may use the Postgres container via `SANDBOX_DATABASE_URL` / `TEST_POSTGRES_URL`.
- Weak `sandbox_dev_only` password is development-only; production still requires strong secrets via prod overlay.

