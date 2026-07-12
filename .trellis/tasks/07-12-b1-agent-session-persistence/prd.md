# B1 — Agent Session Persistence

## Goal

同一个 Conversation 后续回合恢复同一个逻辑 Pi SDK Session，完整保存/恢复 messages、tool call/result、branch、compaction、model/thinking/system prompt 与 tool/skill/extension 版本；不再每轮 `SessionManager.inMemory()` 空会话。

## Background (confirmed)

- Current code: `agent/chat-runner.js` uses `SessionManager.inMemory()` per turn.
- Conversation already binds sandbox session + workspace; logical Pi session is missing.
- Related archived work: `07-11-agent-session-persistence` (partial enterprise persistence goals); this task completes Pi SDK session continuity per ADR 0002 §4.1 / §7 / Phase 1.

## Requirements

1. Tables: `agent_sessions`, `agent_session_entries` (and wire `agent_runs` as needed).
2. Conversation binds `agent_session_id`.
3. Persist full Pi SDK session entries; materialize temporary JSONL; `SessionManager.open(session_file)`.
4. Live-persist new SDK entries during run.
5. Restore failure → `session_restore_failed`; never silent empty session.
6. Stop default per-turn independent empty in-memory sessions.

## Dependencies

- None for start. Coordinates with B4 for tool result re-use after restore.

## Acceptance Criteria

- [ ] Same Conversation 3 turns → one logical Pi SDK Session
- [ ] Turn 2 restores turn 1 tool call + tool result
- [ ] Agent service restart continues Conversation
- [ ] Compaction then restart still restores
- [ ] Restore failure does not create silent new session
- [ ] No longer only last-40 plain-text history injection

## Non-Goals

Process tools, MCP, steer, model registry (other children).

## Infrastructure Note (2026-07-12)

**Dedicated PostgreSQL container is approved for this iteration.**

- Dev: `docker compose --profile postgres up -d postgres`
- URL (host): `postgresql://sandbox:sandbox_dev_only@localhost:5432/sandbox`
- URL (compose): `postgresql://sandbox:sandbox_dev_only@postgres:5432/sandbox`
- SQLite remains valid for unit tests / offline CI; live multi-turn session, process, ledger, and streaming integration may use the Postgres container via `SANDBOX_DATABASE_URL` / `TEST_POSTGRES_URL`.
- Weak `sandbox_dev_only` password is development-only; production still requires strong secrets via prod overlay.

