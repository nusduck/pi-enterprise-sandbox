# Refactor acceptance status

**Branch:** `codex/plan-acceptance`  
**Baseline commit (WIP snapshot):** `6d25783c`  
**Normative source:** root [`plan.md`](../plan.md) §32  
**Evidence index:** [`evidence/`](./evidence/)  
**Process log:** [`PROCESS_LOG.md`](./PROCESS_LOG.md)

This file is the **only** living gap board for plan acceptance.  
A green unit-test suite alone does **not** complete a row.

### Status vocabulary

| Status | Meaning |
|--------|---------|
| `done` | Implemented and evidenced (test and/or dated evidence doc) |
| `partial` | Substantial code exists; missing proof, wiring, or edge of §32 |
| `open` | Not satisfied for acceptance |
| `waived` | Explicitly out of scope with written rationale (rare) |
| `unknown` | Not yet audited against this branch; treat as open for planning |

### Update rule

Change this file in the **same commit** as the implementation or evidence that justifies the new status.

---

## A. Agent Runtime (`plan.md` §32)

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| A1 | Use Pi native Agent Loop | `done` | `agent/src/infrastructure/pi/*`, executor path; no second ReAct loop |
| A2 | Three enterprise extensions load | `done` | `sandbox-bridge`, `enterprise-policy`, `observability`; kit removed |
| A3 | MCP via `pi-mcp-adapter` | `done` | exact pin + `agent/tests/pi/mcp-adapter.integration.test.js` |
| A4 | Multi-turn Session recoverable | `done` | Offline: session-recovery + journal units + WAITING_INPUT recovery matrix. **Live 2026-07-19:** full `agent-worker-pi-restart.release-gate.test.js` **5/5 PASS** (model SIGKILL replay, durable interaction, tool boundary, sandbox UNKNOWN) on isolated MySQL/Redis/Sandbox — Pi Session checkpoint path only. Evidence: `evidence/a4-g2-restart-matrix-2026-07-19.md`, `evidence/g6-interaction-worker-restart-2026-07-19.md`. Residual non-blocking: dedicated corrupt-journal-under-kill live gate not separate. |
| A5 | Agent Version pinned | `done` | credential/version binding tests under `agent/tests/a2a/` |

## B. State

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| B1 | MySQL sole fact authority | `done` | Knex schema + repos; Sandbox SQLite stack removed |
| B2 | Redis runtime-only | `done` | architecture + compose; Outbox for durable events |
| B3 | No in-process authoritative Run Map | `partial` | Structural grep test (`no-authoritative-run-map.unit.test.js`) asserts no process-global RunManager/runs Map authority under agent/src. Residual transient Maps allowed; full residual-cache audit still light. |
| B4 | No whole-Conversation messages JSON blob | `done` | append-only `messages` rows + triggers |
| B5 | No dual Run state sources | `done` | Agent MySQL authority design |
| B6 | Run Events ordered replay | `done` | `next_event_sequence` + MySQL gate in evidence |

## C. Sandbox

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| C1 | Session ↔ Workspace 1:1 | `done` | uniques on `workspace_id` / sandbox session refs |
| C2 | Stable Agent paths | `done` | `/home/sandbox/workspace`, `/home/sandbox/skill` |
| C3 | No global mutable workspace symlink | `done` | lease/symlink model removed in refactor |
| C4 | Concurrent session isolation | `done` | live sandbox gate in `evidence/release-gate-2026-07-19.md` |
| C5 | Ordinary commands no approval | `done` | policy defaults; enterprise tools only |
| C6 | Python multi-line auto-materialize | `done` | formal execution path + tests |
| C7 | Long tasks via Process Handle | `partial` | formal process runtime present; live multi-host reclaim deferred |
| C8 | Dataset streams into Workspace | `done` | PR-09 path + live 5GiB gate evidence |

## D. Frontend

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| D1 | Refresh restores messages/tools/process/artifacts | `done` | **2026-07-19 offline matrix:** rehydrateConversation restores messages/tools/process/artifacts; WAITING_INPUT via rehydrateInProgress. Fixed durable history seq + flat platform payloads (`agentEventAdapter`, `platformEventNormalize`). FE suite 200 pass. Evidence: `evidence/p1-fe-refresh-matrix-2026-07-19.md`. Residual non-blocking: browser F5 harness absent. |
| D2 | Show Run status | `done` | run UI + SSE |
| D3 | Cancel Run | `done` | controls + API |
| D4 | Upload Dataset | `done` | upload tests + BFF proxy |
| D5 | View Process output | `done` | Process entity→console logs; owner-scoped process API client paths; ProcessConsole structural UI. Evidence: `evidence/p1-fe-refresh-matrix-2026-07-19.md`. Residual: live open-console click. |
| D6 | Enterprise approval UX | `done` | `resolveApprovalDecision` never marks on failed decide; pending remains decidable; ApprovalsPage failure banner contract. Evidence: `evidence/p1-fe-refresh-matrix-2026-07-19.md`. Residual: browser Approval Center audit. |
| D7 | View Trace | `done` | Durable MySQL span projection + `TraceQueryService.listForRun` + BFF `/trace` authority + FE TracePanel rehydrate. Evidence: `evidence/p1-trace-audit-2026-07-19.md`. Residual: full OTEL backend productization out of scope. |
| D8 | View Agent A2A config | `done` | `A2aPage` + BFF `/api/a2a` |

## E. Artifact

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| E1 | write/edit do not auto-download | `done` | design + submit_artifact only |
| E2 | Only `submit_artifact` creates Artifact | `done` | formal artifact runtime |
| E3 | Download tenant/user scoped | `done` | owner-scoped download + A2A caller-bound gate |

## F. A2A

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| F1 | Agent Card reachable | `done` | A2A surface + live gate |
| F2 | Streaming | `done` | live gate |
| F3 | Task query / cancel / resubscribe | `done` | live gate |
| F4 | A2A Task ↔ Run mapping | `done` | task service + repos |
| F5 | A2A SSE disconnect does not cancel Run | `done` | protocol design + gate notes |
| F6 | org/client/trace auditable | `done` | A2A audit append carries **org_id + client_id + trace_id** on send_message / cancel_task / artifact_download via real `A2aAuditRepository` (`a2a-audit-correlation.unit.test.js`). Evidence: `evidence/p1-trace-audit-2026-07-19.md`. |

## G. Reliability

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| G1 | Browser disconnect: Run continues | `done` | SSE relay design; worker ownership |
| G2 | Agent Worker restart recoverable | `done` | Offline classification covers lease-free replay, mid-tool UNKNOWN, WAITING_INPUT PENDING/RESOLVED/CLAIMED. **Live 2026-07-19:** full real-Pi Worker restart suite **5/5 PASS** (`agent-worker-pi-restart.release-gate.test.js`) + prior checkpoint/BullMQ gates in `evidence/release-gate-2026-07-19.md`. Evidence: `evidence/a4-g2-restart-matrix-2026-07-19.md`. Residual non-blocking: dedicated graceful SIGTERM mid-run drain gate not separate. |
| G3 | Redis blip does not lose fact events | `done` | Outbox + Redis gate evidence |
| G4 | Duplicate request no duplicate side effects | `done` | Offline concurrent begin (same/different hash) + FOR UPDATE. **Live 2026-07-19:** 20-way same-key CreateRun on `pi_gate_20260719_g4g5` → 1 run / 1 message / 1 accepted / 1 outbox / 1 idempotency. Evidence: `evidence/p1-g4-g5-idempotency-2026-07-19.md`. |
| G5 | Create Run then immediate query race-free | `done` | Offline: create txn held open until commit before return + immediate GET. **Live:** every concurrent response immediately GET-able ACCEPTED\|QUEUED. Same evidence doc. |
| G6 | Durable WAITING_INPUT / interaction resume | `done` | **Unit:** interaction HTTP respond/rehydrate, GET `pending_input`, execute-run resume, cancel races (17 pass). **Live:** `agent-worker-pi-restart.release-gate.test.js` case *continues one durable interaction after Worker restart…* PASS on isolated MySQL/Redis/Sandbox (`pi_gate_20260719_g6int`, 2026-07-19): park → SIGKILL Worker A → rehydrateWaiting+respond → Worker B SUCCEEDED / APPLIED / 2 provider calls. Evidence: `evidence/g6-interaction-worker-restart-2026-07-19.md`. |
| G7 | Hard `SIGKILL` orphan recovery in Bubblewrap | `done` | **Unit:** PID-namespace init, `--as-pid-1`, CAP_KILL, `tests/test_formal_orphan_recovery.py` + identity/bubblewrap (19 pass). **Live:** `scripts/release-gates/sandbox-live-gate.mjs` with `SANDBOX_GATE_HARD_KILL=1` + managed non-privileged Bubblewrap container PASS (`2026-07-19T08:54:17Z`): orphan survived service SIGKILL; after restart process → `lost` (OS orphan gone), claim → `UNKNOWN`/`CRASH_RECOVERY_UNKNOWN`, no auto-replay. Evidence: `evidence/g7-hard-kill-orphan-2026-07-19.md`. |

## H. Security

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| H1 | Cross-tenant blocked | `done` | live isolation gate |
| H2 | Workspace path escape blocked | `done` | path validation + bwrap |
| H3 | Skill tree not writable (exec side) | `done` | canonical RO `/home/sandbox/skill` |
| H4 | Sandbox non-privileged | `done` | compose/prod constraints + gates |
| H5 | Secrets not in model/logs/events | `partial` | Offline dual-path closed: shared `SECRET_PATTERNS` cover access/refresh/client_secret/Cookie/sk-*; durable status/outbox + Redis logs use `redactSecretText`. Evidence: `evidence/h5-h6-secrets-mcp-audit-2026-07-19.md`, `evidence/p1-h5-h6-offline-closeout-2026-07-19.md`. **Still open:** production/staging log + durable-row sampling. |
| H6 | Business DB only via controlled MCP | `partial` | Offline structural: MCP via `pi-mcp-adapter` only; sandbox-bridge non-SQL tools; no extension SQL/DSN clients. Same evidence. **Still open:** deployment MCP allowlist audit + live no-business-SQL-tool gate. |

---

## P0 program board (acceptance blockers)

Derived from open/partial rows that block “refactor complete”:

| Priority | Item | STATUS IDs | Next proof |
|----------|------|------------|------------|
| P0 | ~~Finish durable interaction end-to-end + restart/refresh evidence~~ | G6 | **done** — live worker-restart gate + evidence 2026-07-19 |
| P0 | ~~Hard SIGKILL orphan recovery in production Bubblewrap~~ | G7 | **done** — live hard-kill managed gate + evidence 2026-07-19 |
| P0 | ~~Worker/model restart matrix completeness~~ | A4, G2 | **done** — full real-Pi restart suite 5/5 live + offline matrix 2026-07-19 |
| P1 | ~~Trace tree completeness (backend + frontend)~~ | D7, F6 | **done** — durable query + A2A audit correlation 2026-07-19 |
| P1 | ~~Frontend refresh matrix sign-off~~ | D1, D5, D6 | **done** offline — durable-seq fix + rehydrate/process/approval matrix 2026-07-19 |
| P1 | ~~Idempotency / create-race live gates~~ | G4, G5 | **done** — live 20-way CreateRun concurrent 2026-07-19 |
| P1 | Secrets & MCP data-plane audit | H5, H6 | Offline dual-path redaction closed; **production sampling + deploy allowlist still open** |
| P1 | ~~Split future work into reviewable commits~~ | n/a | **done** this session — STATUS-family commits on `codex/plan-acceptance` |

Non-blocking debt remains in [`review-deferred-items.md`](./review-deferred-items.md).

---

## Checkpoint inventory (this branch)

Snapshot commit `6d25783c` brought in uncommitted follow-up from `codex/pi-enterprise-refactor`, including:

- Durable interaction domain, migrations, repository, services, unit tests
- Trace spans / run trace state migrations and query paths
- Formal Sandbox internal plane (sessions/executions/processes/artifacts/files write)
- A2A admin UI/API, authority tests on BFF
- Removal of `enterprise-agent-kit` and many legacy Sandbox public routes
- Release-gate scripts and dated evidence under `docs/evidence/`

That snapshot is **not** acceptance. It is the engineering baseline for acceptance work on `codex/plan-acceptance`.
