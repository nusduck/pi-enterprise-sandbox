# P1 G4 / G5 — Idempotency + create-race (2026-07-19)

**Branch:** `codex/plan-acceptance`  
**STATUS IDs:** G4, G5  
**Verdict:** **PASS live concurrent** on dedicated MySQL (promotes both to `done`).

## Live gate

- Ephemeral `mysql:8.0`, schema `pi_gate_20260719_g4g5`
- **20 concurrent** same-key `CreateRunService.execute` → **1** run, **1** message, **1** accepted event, **1** outbox, **1** idempotency row
- Every response immediately GET-able as ACCEPTED|QUEUED

## Offline strengthening

- `idempotency-repository.unit.test.js`: concurrent first-begin same/different hash + FOR UPDATE
- `create-get-cancel.unit.test.js`: G5 holds create txn open; no return before commit; immediate GET after

Production already had FOR UPDATE reload + `jsonStrings=true` + create-before-return — **no production code change**.

## Subagent

`019f79b3-0d44-7931-970c-40ea8cca7ed3` (P1 G4/G5 idempotency race).
