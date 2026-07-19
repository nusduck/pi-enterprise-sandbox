# P1 FE refresh matrix — D1 / D5 / D6 (2026-07-19)

**Branch:** `codex/plan-acceptance`  
**STATUS IDs:** D1, D5, D6  
**Verdict:** **PASS offline** (promotes to `done`). Browser E2E harness absent — residual non-blocking.

Additive evidence; does not rewrite prior files.

## Production fixes

1. **`frontend/src/shared/sse/agentEventAdapter.ts`** — honor durable `sequence` / `persisted_sequence` and durable event ids on history replay so mixed platform + legacy tool events do not synthesize duplicate seq and drop process/artifact gaps.
2. **`frontend/src/shared/state/platformEventNormalize.ts`** — promote flat non-envelope root fields (`processId`, `artifactId`, …) into payload so history shapes without nested `data` still apply.

## Offline matrix

| Cell | Proof |
|------|--------|
| D1 messages / tools / process / artifacts | `conversation-rehydration.test.ts` drives `rehydrateConversation` with durable seq |
| D1 WAITING_INPUT | `rehydrateRun` + `rehydrateInProgress` (no `status=running` filter) |
| D5 process output | entity → `buildLogLines`; real process API client URL assertions; ProcessConsole structure |
| D6 approval failure | `resolveApprovalDecision` leaves store pending; ApprovalsPage banner contract |

## Tests

```text
cd frontend && npm test
→ 200 pass / 0 fail
```

Browser: no playwright/puppeteer; headless Chrome only loads `about:blank` — see session scratch `p1-fe-live-failure.log`. Offline shipped-path is the acceptance bar.

## Subagent

`019f79b3-0d3f-7e61-b219-d5d4536f2156` (P1 FE D1/D5/D6 matrix).
