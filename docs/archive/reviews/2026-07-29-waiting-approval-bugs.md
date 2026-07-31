# Bug: WAITING_APPROVAL cancel deadlocks + chat false error / Approve no-op

**Date:** 2026-07-29  
**Status:** Fixed (2026-07-29) — see implementation notes below  
**Severity:** High (user cannot cancel parked approval runs; approve/resume can deadlock; chat misleads)  
**Surfaces:** Agent worker, CancelRunService, ExecuteRunService, Recovery, BFF run detail, Frontend chat composer / entity store

---

## Summary

When a Run parks on MCP (or other high-risk) tool approval (`WAITING_APPROVAL`):

1. **Cancel is ineffective** — only writes cancel intent; state machine has no legal edge to CANCELLING.
2. **Approve after cancel deadlocks** — resume job sees cancel intent, cannot terminalize, BullMQ fails out; recovery skips `WAITING_APPROVAL`.
3. **Chat shows a fake failure** — parked `status_reason: "approval pending"` is mapped to `run.error` and rendered as `[Error: approval pending]` while the UI still says waiting for approval.
4. **Chat Approve can no-op** — banner is driven by run status alone; the button requires a pending approval entity in the local store. If the entity was never rehydrated, click silently does nothing. Approval Center (MySQL list API) still works.

---

## Repro evidence (live 2026-07-29)

### Incident A — cancel + approve deadlock (cleaned)

| Field | Value |
| --- | --- |
| run_id | `01KYPDQBJHHYZ57070V5QDP4NT` |
| conversation_id | `01KYPDQBHDQGBDKK03WM4VH2Q6` |
| source | cron |
| tool | `mcp__exa__web_search_exa` (`platform:mcp-high`) |

Timeline:

1. Run parked `WAITING_APPROVAL`, `status_reason=approval pending`.
2. User cancelled → `cancel_requested_at` set; **status stayed** `WAITING_APPROVAL`.
3. User approved in Approval Center → approval row `APPROVED`.
4. Resume job enqueued: `bull:agent-runs:{runId}-approval-{approvalId}`.
5. Worker failed 8× with:

   ```text
   NeedsReconciliationError:
   cancel intent recorded; awaiting legal CANCELLING edge
   (status=WAITING_APPROVAL)
   ```

6. Recovery skipped `WAITING_APPROVAL` (`not enqueue-recovered by T3`).
7. **Ops cleanup:** run/tool forced `CANCELLED`, events 24–27 + outbox published, Redis cancel signal + failed job deleted. Approval left `APPROVED` as historical fact.

### Incident B — UI false error + Approve no-op (same day, new cron)

| Field | Value |
| --- | --- |
| run_id | `01KYPEX8QSEJYJHENZW8TZQKCY` |
| conversation_id | `01KYPEX8Q3Y8J18A87GDGA1RR5` |
| agent_session_id | `01KYPEX8QEQP45K56NF73AZMJZ` |
| approval_id | `01KYPEXET3R28E1ZS8DCR2NDMY` |
| source | cron |

Backend was healthy:

- Run `WAITING_APPROVAL`, no cancel intent.
- Approval `PENDING`.
- Tool `WAITING_APPROVAL`, no error_code.

UI showed both:

- Top/bottom: Waiting approval / “Agent is waiting for approval”.
- Message bubble: **`[Error: approval pending]`**.
- Runtime activity: tool `waiting_approval · mcp`, **no Approval card** (store likely missing approval entity → Approve silent no-op).

---

## Root causes

### A. Parked cancel missing for WAITING_APPROVAL

State machine (`agent/src/domain/run/run-status.js`):

```text
WAITING_APPROVAL → RUNNING only
WAITING_INPUT    → RUNNING only
```

`CancelRunService` has **parked terminalization only for `WAITING_INPUT`** (close interaction/tool, then RUNNING → CANCELLING → CANCELLED).  
For `WAITING_APPROVAL` it only:

1. Writes MySQL cancel intent.
2. Sets Redis cancel signal.
3. Does **not** transition status (illegal edge).

There is no active worker to observe the signal while parked.

### B. Resume vs cancel race in ExecuteRunService

On re-entry (`WAITING_APPROVAL` + resolved approval):

1. Job is enqueued after decide.
2. Worker hits `#isCancelRequested` early → `#cancelBeforeRuntime`.
3. Still stuck at `WAITING_APPROVAL` → `#finishCancelled` returns:

   ```text
   needsReconciliation: true
   error: 'cancel intent recorded; awaiting legal CANCELLING edge'
   ```

4. BullMQ marks failed after attempts; recovery **skips** `WAITING_APPROVAL`.

### C. BFF/FE treat parked status_reason as run.error

| Layer | Behavior |
| --- | --- |
| Agent | `statusReason: 'approval pending'` on WAITING_APPROVAL outcome (`pi-run-executor.js`) |
| BFF | `body.error ??= status_reason` for **all** statuses (`api-server/src/routes/runs.js`) |
| FE rehydrate | stores `detail.error` on run |
| FE project messages | appends ``[Error: ${run.error}]`` whenever `run.error` is set (`entityBridge.ts`) |

Non-terminal parked reasons must not be rendered as failures.

### D. Chat Approve depends on entity store, banner does not

| UI element | Source of truth |
| --- | --- |
| Banner mode `waiting_approval` | `run.status` **or** any pending approval |
| Approve / Reject click | `approvalsById` pending row for `activeRunId` |

If approval entity missing (event replay gap, refresh path, cron conversation open):

```ts
// Composer / approvePending — no id → early return, no toast
```

Approval Center uses `GET /api/approvals` + decide API → works independently.

---

## Deadlock diagram (Incident A)

```text
WAITING_APPROVAL
      │
      ├─ Cancel ──► cancel_intent=true, status unchanged
      │
      ├─ Approve ──► approval=APPROVED, enqueue resume job
      │                    │
      │                    ▼
      │              worker: sees cancel_intent
      │                    │
      │                    ▼
      │              no legal CANCELLING edge
      │                    │
      │                    ▼
      │              NeedsReconciliation × N → BullMQ failed
      │
      ▼
Stuck forever (recovery skips WAITING_APPROVAL)
```

---

## Fix plan — implemented 2026-07-29

### P0 — Backend ✅

1. **`CancelRunService`** + shared `parked-approval-cancel.js`: parked cancel for `WAITING_APPROVAL` (mirror `WAITING_INPUT`):
   - Terminalize PENDING/APPROVED-but-unexecuted tool → CANCELLED.
   - Close pending approval if still PENDING → `CANCELLED`.
   - Same-txn: `WAITING_APPROVAL → RUNNING → CANCELLING → CANCELLED` with events (no tool side effects).
2. **`ExecuteRunService`**: on cancel intent + `WAITING_APPROVAL`, **parked-cancel** instead of `NeedsReconciliation` forever.
3. **`RunRecoveryService`**: when `cancel_requested_at` is set, terminalize parked wait; when approval is terminal, enqueue resume job.

### P1 — BFF / Frontend ✅

1. BFF `presentRunDetail`: map `error` from `status_reason` **only for terminal failed-like outcomes**.
2. `entityBridge.projectRunMessages`: only emit `[Error: …]` for terminal failed-like statuses.
3. Rehydrate pending approvals for waiting runs via `GET /api/approvals?status=pending`.
4. Approve/Reject with missing id: toast + best-effort `reconcileRun` (never silent no-op).
5. Banner copy for “Approved — resuming…” left as follow-up polish (not required for deadlock/false-error).

### P2 — Tests ✅

- Unit: `cancel-run-approval.unit.test.js` — cancel + PENDING, cancel after APPROVED, recovery with cancel intent.
- BFF: parked `WAITING_APPROVAL` does not set `error` from `approval pending`.

---

## Workarounds (until fixed)

| Situation | Action |
| --- | --- |
| Need to approve | Prefer **Approval Center** over chat banner |
| Stuck after cancel+approve | Ops: terminalize run/tool, publish cancel events, delete Redis cancel key + failed BullMQ job (see Incident A cleanup) |
| Avoid new deadlocks | Do **not** cancel then approve the same parked run |

---

## Related code pointers

| Area | Path |
| --- | --- |
| Run SM | `agent/src/domain/run/run-status.js` |
| Cancel parked INPUT only | `agent/src/application/cancel-run-service.js` |
| Approval decide + enqueue | `agent/src/application/approval-decision-service.js` |
| Resume / cancel before runtime | `agent/src/application/execute-run-service.js` |
| Recovery skip WAITING_APPROVAL | `agent/src/application/run-recovery-service.js` |
| statusReason on park | `agent/src/application/pi-run-executor.js` (`approval pending`) |
| BFF error mapping | `api-server/src/routes/runs.js` |
| False `[Error: …]` | `frontend/src/features/chat/entityBridge.ts` |
| Composer banner / approve | `frontend/src/widgets/composer/Composer.tsx`, `composerMode.ts` |
| Approval decision helper | `frontend/src/features/chat/approvalDecision.ts` |

---

## Ops note

Incident A was manually terminalized on 2026-07-29 (~08:04Z).  
Do not re-open that run; treat as cancelled. New cron runs will still hit the same bugs until code lands.
