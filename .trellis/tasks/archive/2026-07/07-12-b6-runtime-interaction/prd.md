# B6 — Runtime Interaction, Budget, Recoverable Approval

## Goal

POST /runs/{id}/steer 与 follow-up；Run budgets (steps/tools/duration/tokens/cost/failures/processes) → budget_exceeded；approval 为 checkpoint+resume，不在 tool 内固定轮询；Agent 重启后仍可处理审批。

## Dependencies

B1 session checkpoint, B4 ledger/approval states.

## Acceptance Criteria

- [x] Steer during run changes direction, scoped to correct conversation
- [x] Follow-up queues after current run work
- [x] Waiting approval releases execution resources
- [x] Agent restart can continue waiting/resume approval
- [x] Budget exceeded terminates with budget_exceeded

## Infrastructure Note (2026-07-12)

Dedicated PostgreSQL container is available:
`docker compose --profile postgres up -d postgres`
URL: `postgresql://sandbox:sandbox_dev_only@localhost:5432/sandbox`

