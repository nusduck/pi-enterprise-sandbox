# B4 — Tool Ledger Completion

## Goal

所有有副作用/需审计的 Tool 经统一执行台账；状态 prepared → awaiting_approval → executing → succeeded|failed|cancelled|unknown；idempotency；edit 多匹配拒绝 + apply_patch + diff/hash。

## Coverage

read, write, edit, apply_patch, bash, process, Skill, MCP, Artifact, Approval, external HTTP tools.

## Acceptance Criteria

- [x] Every tool call has unique tool_call_id and full ledger row
- [x] Lost HTTP response does not double side-effects (idempotency)
- [x] Tool results reusable after session restore
- [x] edit multi-match rejects silent edit
- [x] File edits return unified diff + before/after hash

## Infrastructure Note (2026-07-12)

**Dedicated PostgreSQL container is approved for this iteration.**

- Dev: `docker compose --profile postgres up -d postgres`
- URL (host): `postgresql://sandbox:sandbox_dev_only@localhost:5432/sandbox`
- URL (compose): `postgresql://sandbox:sandbox_dev_only@postgres:5432/sandbox`
- SQLite remains valid for unit tests / offline CI; live multi-turn session, process, ledger, and streaming integration may use the Postgres container via `SANDBOX_DATABASE_URL` / `TEST_POSTGRES_URL`.
- Weak `sandbox_dev_only` password is development-only; production still requires strong secrets via prod overlay.

