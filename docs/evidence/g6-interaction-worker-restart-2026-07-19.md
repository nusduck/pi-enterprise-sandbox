# G6 live evidence — Durable WAITING_INPUT after Worker restart

**Date:** 2026-07-19  
**Branch:** `codex/plan-acceptance`  
**STATUS ID:** G6  
**Verdict:** **PASS** (promotes G6 to `done`)

This file is additive. It does **not** rewrite
[`release-gate-2026-07-19.md`](./release-gate-2026-07-19.md).

## Scope

Prove the shipped durable interaction path across Worker death:

1. Worker A + real Pi + scripted provider parks on `ask_user` → Run
   `WAITING_INPUT`, one PENDING interaction, lease released;
2. Worker A is **SIGKILL**ed;
3. `InteractionResponseService.rehydrateWaiting` + `respond(...)` enqueues the
   resume job from MySQL facts;
4. Worker B completes `${runId}-interaction-${interactionId}` → Run
   `SUCCEEDED`, interaction `RESOLVED` / resume_phase `APPLIED`, snapshot
   contains the continuation answer, **exactly two** provider calls (no
   duplicate model turn).

Pi-native only: no second ReAct loop; Session/tool state via existing
`pi-coding-agent` path and MySQL interaction ledger.

## How it was run

Host: macOS + Docker/OrbStack. Isolated gate resources:

| Resource | Container | Host |
|----------|-----------|------|
| MySQL 8.0 | `pi-release-gate-mysql-g6int` | `127.0.0.1:33316`, schema `pi_gate_20260719_g6int` |
| Redis 7.2 (AOF) | `pi-release-gate-redis-g6int` | `127.0.0.1:36389` |
| Replay Redis | `pi-release-gate-replay-g6int` | internal |
| Sandbox | `pi-release-gate-sandbox-g6int` (`enterprise-sandbox:latest`) | `http://127.0.0.1:18081` |

Agent Knex migrations applied to the gate schema **before** Sandbox became ready
(Sandbox fail-closed without claim schema).

### Critical DSN note

`TEST_SANDBOX_MYSQL_URL` for this Node test must be `mysql://…` (both knex
handles use `createMysqlKnex`). `mysql+pymysql://` is rejected and aborts
`describeLive` `before`.

```sh
export RUN_AGENT_PI_RESTART_GATE=1
export TEST_MYSQL_URL='mysql://sandbox:<redacted>@127.0.0.1:<port>/pi_gate_20260719_g6int'
export TEST_SANDBOX_MYSQL_URL="$TEST_MYSQL_URL"   # mysql:// only
export TEST_REDIS_URL='redis://:<redacted>@127.0.0.1:<port>/0'
export TEST_SANDBOX_URL=http://127.0.0.1:<sandbox-port>
export TEST_SANDBOX_CONTAINER=pi-release-gate-sandbox-g6int
export TEST_REDIS_CONTAINER=pi-release-gate-redis-g6int
# + HMAC keyring / API token as required by the gate file

cd agent
node --test --test-timeout=120000 \
  --test-name-pattern='continues one durable interaction after Worker restart' \
  tests/redis/agent-worker-pi-restart.release-gate.test.js
```

## Observed result

| Run | Result |
|-----|--------|
| Isolated G6 case (subagent) | **PASS 1/1** (~2.5s) |
| Safety + model + G6 (subagent) | **PASS 3/3** |
| Parent re-run (same env) | **PASS 1/1** (~2.2s, 2026-07-19 session) |

Verified durable facts after Worker B:

- Run status `SUCCEEDED`
- Interaction `RESOLVED`, resume_phase `APPLIED`
- Snapshot contains the user continuation answer
- Provider call count **2** (park + continue), no duplicate tool ledger rows

### Out of G6 scope (same suite)

A separate case `marks an interrupted real Sandbox execution UNKNOWN…` previously
failed when OrbStack hard restart produced `CRASH_RECOVERY_UNKNOWN` instead of
`SHUTDOWN_DRAIN_TIMEOUT`. Both codes are honest UNKNOWN without auto-replay.
That assertion was tightened on this branch so either code is accepted; it does
not change G6 semantics.

## Offline unit proof (same branch)

```text
interaction-http.unit.test.js
interaction-response.unit.test.js
get-run-pending-input.unit.test.js
execute-run-interaction-resume.unit.test.js
cancel-run-interaction.unit.test.js
→ 17 passed (G6 shipped path)
```

## Subagent

Live setup + first PASS: general-purpose subagent
`019f7991-286d-7c02-acbc-e045b63e6a26` (G6 durable restart evidence). Parent
re-ran the isolated G6 case and committed this evidence.
