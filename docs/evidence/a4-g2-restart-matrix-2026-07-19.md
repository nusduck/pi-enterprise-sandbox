# A4 / G2 restart matrix — offline + live (2026-07-19)

**Branch:** `codex/plan-acceptance`  
**STATUS IDs:** A4 (multi-turn Session recoverable), G2 (Agent Worker restart)  
**Verdict:** **PASS** for acceptance (promotes A4 + G2 to `done`). Residual
edges (dedicated graceful SIGTERM drain, dedicated corrupt-journal-under-kill)
are non-blocking notes, not open acceptance blockers.

This file is additive. It does **not** rewrite
[`release-gate-2026-07-19.md`](./release-gate-2026-07-19.md).

## Matrix cells

| Cell | Offline unit | Live release-gate (this session) |
|------|--------------|----------------------------------|
| Graceful stop / drain | worker-main shutdown DI only | residual: no dedicated mid-run SIGTERM gate |
| SIGKILL mid-run (pre-tool) | `execute-run.unit` lease-free replay | **PASS** — model call after Worker SIGKILL |
| SIGKILL mid-tool | UNKNOWN → manual; tool-governance restart | **PASS** — durable tool boundary no replay |
| Mid-waiting-input (PENDING) | `run-recovery-waiting-input.unit.test.js` | **PASS** — G6 interaction park + kill |
| Mid-waiting-input (RESOLVED/CLAIMED) | same unit file | **PASS** — Worker B APPLIED continuation |
| Session rehydrate (snapshot) | `session-recovery.unit` | **PASS** — checkpoint assertions in Pi suite |
| Journal replay | session-recovery + journal units | residual: no dedicated kill+journal live gate |
| Sandbox interrupt UNKNOWN | n/a | **PASS** — Docker restart → UNKNOWN, no retry |
| BullMQ stalled (infra) | n/a | prior evidence in `release-gate-2026-07-19.md` |

## Live full suite (parent re-run)

```text
agent/tests/redis/agent-worker-pi-restart.release-gate.test.js
RUN_AGENT_PI_RESTART_GATE=1 + isolated MySQL/Redis/Sandbox
ℹ tests 5
ℹ pass 5
ℹ fail 0
duration_ms ~76359
```

Cases:

1. safety: opt-in + isolated resources  
2. replays a real Pi model call after Worker SIGKILL with no side-effect ledger  
3. continues one durable interaction after Worker restart and checkpoints the answer  
4. does not replay a real Pi tool after its durable dispatch boundary  
5. marks an interrupted real Sandbox execution UNKNOWN and never retries it  

Sandbox UNKNOWN assertion accepts `SHUTDOWN_DRAIN_TIMEOUT` or
`CRASH_RECOVERY_UNKNOWN` (both honest no-replay paths under OrbStack hard restart).

## Offline work this session

- Added `agent/tests/run-services/run-recovery-waiting-input.unit.test.js`
  (PENDING skip, RESOLVED enqueue, missing interaction reconciliation, CLAIMED
  continuation re-enqueue).
- Re-ran recovery-related offline suite (subagent 110 pass; parent G6 + WAITING_INPUT + B3).
- Dual-runtime grep: no second ReAct loop, no process-global RunManager under
  `agent/src`; B3 structural test green.

## Subagent

Matrix audit + unit file: general-purpose subagent
`019f7991-286d-7c02-acbc-e0543771a9f8` (A4/G2 restart matrix audit).  
Parent re-ran full Pi restart live suite and promoted A4/G2.

## STATUS

- **A4:** `done` — multi-turn Session recovery via Pi checkpoint path proven live across model/tool/interaction cells.
- **G2:** `done` — Agent Worker SIGKILL recovery proven live 5/5 + prior Redis/BullMQ evidence.
