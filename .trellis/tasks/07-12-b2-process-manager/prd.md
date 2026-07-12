# B2 — Process Manager

## Goal

新增受管理 Process Tool，支持长任务/后台/交互进程；禁止依赖 nohup/shell 后台符号绕过平台管理。同步 bash 保留为短命令快捷工具。

## Requirements

Tools: `process_start`, `process_status`, `process_logs`, `process_wait`, `process_write_stdin`, `process_signal`, `process_cancel`.

States: created, running, waiting_input, completed, failed, cancel_requested, cancelled, timeout, orphaned.

Cleanup: foreground end on session/run end; background policy; orphan on runner restart.

## Dependencies

- Independent start. B3 consumes process log streaming; B4 ledgers process tools.

## Acceptance Criteria

- [x] Agent can start a long-running web server
- [x] Agent can read process logs
- [x] Agent can write stdin
- [x] Agent can stop process
- [x] After Agent service restart, process state is identifiable (orphaned if needed)
- [x] Run cancel stops associated processes

## Non-Goals

Streaming event plumbing details (B3); full ledger wiring (B4).

## Infrastructure Note (2026-07-12)

**Dedicated PostgreSQL container is approved for this iteration.**

- Dev: `docker compose --profile postgres up -d postgres`
- URL (host): `postgresql://sandbox:sandbox_dev_only@localhost:5432/sandbox`
- URL (compose): `postgresql://sandbox:sandbox_dev_only@postgres:5432/sandbox`
- SQLite remains valid for unit tests / offline CI; live multi-turn session, process, ledger, and streaming integration may use the Postgres container via `SANDBOX_DATABASE_URL` / `TEST_POSTGRES_URL`.
- Weak `sandbox_dev_only` password is development-only; production still requires strong secrets via prod overlay.

