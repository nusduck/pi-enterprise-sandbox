# Implement — B6

## Checklist

- [x] Steer/follow-up APIs + session binding checks
- [x] Budget accounting + budget_exceeded terminal
- [x] Approval checkpoint/resume; remove in-tool poll
- [x] Restart recovery for waiting_approval runs
- [x] Tests: steer isolation, follow-up, approval resume, budget

## Validation

```bash
node --test agent/tests/runtime-interaction.test.js agent/tests/tool-ledger.test.js agent/tests/agent-run-api.test.js
uv run --with pytest python -m pytest tests/test_b6_runtime_interaction.py tests/test_approval.py tests/test_agent_events.py -q --tb=short
```

## Agent Run Notes

### What landed

1. **Steer / Follow-up (ADR §4.7)**  
   - Agent: `POST /internal/agent-runs/:id/steer` → `session.steer(text)`  
   - Agent: `POST /internal/agent-runs/:id/follow-up` → `session.followUp(text)`  
   - BFF: `POST /api/runs/:id/steer` and `/follow-up`  
   - Conversation-scoped: mismatched `conversation_id` → 409 cross-talk rejected  
   - Only the bound run’s live session receives the message (lookup by `runId`)

2. **Run budgets (ADR §4.9)**  
   - `agent/services/budget.js` tracks steps, tool_calls, duration, tokens, cost,
     consecutive_tool_failures, processes  
   - Defaults + per-create overrides; `null` = unlimited  
   - Near-limit (≥80%) emits `budget_warning` + steer converge hint  
   - Over limit → abort + terminal `budget_exceeded` (sandbox + in-process status)

3. **Recoverable approval (ADR §4.8)**  
   - Removed `APPROVAL_POLL_MS` / `APPROVAL_MAX_WAIT_MS` in-tool fixed polling  
   - On `pending_approval`: checkpoint session entries → mark run `waiting_approval`
     (durable pending payload) → release lease → throw `ApprovalSuspendedError`  
   - Execution resources freed (`handles = null`, temp session cleanup)  
   - Approve/reject via BFF notifies Agent `resume-approval` / local waiter  
   - Reject → terminal `rejected`; approve → restore + re-execute with pre-approved id  
   - Agent restart: `rehydrateWaitingRun` parks durable waiting runs without workers

4. **Sandbox**  
   - Statuses: `waiting_approval`, `budget_exceeded`, `rejected`  
   - Columns: `budget_json`, `pending_approval_json` (migration `0006` + expand helper)  
   - APIs: `POST .../waiting-approval`, `.../budget-exceeded`, `GET /agent-runs?status=`

### Out of scope

- Model registry (B7)  
- MCP registry (B5)

### Verification (this run)

```text
node --test agent/tests/runtime-interaction.test.js agent/tests/tool-ledger.test.js agent/tests/agent-run-api.test.js
→ 22+ passed (incl. steer isolation, follow-up cross-talk, budget, approval suspend, rehydrate)

uv run --with pytest python -m pytest tests/test_b6_runtime_interaction.py tests/test_approval.py tests/test_agent_events.py -q
→ all passed (waiting_approval release, budget_exceeded, restart list, API endpoints)
```
