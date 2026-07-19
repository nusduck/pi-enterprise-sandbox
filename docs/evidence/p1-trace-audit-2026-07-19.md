# P1 Trace + A2A audit — D7 / F6 (2026-07-19)

**Branch:** `codex/plan-acceptance`  
**STATUS IDs:** D7, F6  
**Verdict:** **PASS offline durable path** (promotes to `done`). Full OTEL productization out of scope.

## Proven path

### D7 View Trace

| Layer | Entry | Test |
|-------|--------|------|
| Projection | `TraceSpanRepository.materializeRunFacts` / `listByRun` | `trace-span.unit.test.js` |
| Query | `TraceQueryService.listForRun` | **new** `trace-query.unit.test.js` |
| BFF | `handleGetRunTrace` after Run auth | `run-trace-authority.test.js` |
| FE | `rehydrateTraceSpans` + `TracePanel` | extended `trace-panel.test.ts` |

### F6 org/client/trace auditable

Real `A2aAuditRepository.append` via `A2aTaskService` — rows carry **org_id + client_id + trace_id** on `a2a.send_message`, `a2a.cancel_task`, `a2a.artifact_download` (**new** `a2a-audit-correlation.unit.test.js`).

## Tests

Parent re-run: trace-query + a2a-audit-correlation + trace-span units green; FE full suite 200 pass.

## Subagent

`019f79b3-0d44-7931-970c-40d6e2a049ad` (P1 D7/F6 trace audit).
