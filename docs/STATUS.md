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
| A4 | Multi-turn Session recoverable | `partial` | journal/snapshot/recovery services present; hard restart live proof incomplete |
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
| D1 | Refresh restores messages/tools/process/artifacts | `partial` | Conversation + WAITING_INPUT rehydrate tests extended (`conversation-rehydration.test.ts`); process/artifact event floor covered. Full browser UI matrix still open. |
| D2 | Show Run status | `done` | run UI + SSE |
| D3 | Cancel Run | `done` | controls + API |
| D4 | Upload Dataset | `done` | upload tests + BFF proxy |
| D5 | View Process output | `partial` | Process console + process routes; authority tests added |
| D6 | Enterprise approval UX | `partial` | Extracted `resolveApprovalDecision` with unit tests; ApprovalsPage surfaces failed decisions without clearing pending. End-to-end browser UX audit still open. |
| D7 | View Trace | `partial` | Trace panel + MySQL spans migrations; full distributed backend still light |
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
| F6 | org/client/trace auditable | `partial` | audit events present; trace correlation completeness TBD |

## G. Reliability

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| G1 | Browser disconnect: Run continues | `done` | SSE relay design; worker ownership |
| G2 | Agent Worker restart recoverable | `partial` | graceful/Pi recovery evidenced; full matrix open |
| G3 | Redis blip does not lose fact events | `done` | Outbox + Redis gate evidence |
| G4 | Duplicate request no duplicate side effects | `partial` | idempotency tables/claims; full live duplicate matrix TBD |
| G5 | Create Run then immediate query race-free | `partial` | create-before-return design; live race gate TBD |
| G6 | Durable WAITING_INPUT / interaction resume | `partial` | **Shipped path proven in-tree:** interaction HTTP respond/rehydrate, GET `pending_input`, execute-run resume, FE rehydrateInProgress WAITING_INPUT. **Worker-restart class test added:** `agent/tests/redis/agent-worker-pi-restart.release-gate.test.js` (`continues one durable interaction after Worker restart…`, `describeLive`). Still `partial` until that live gate is executed and dated under `docs/evidence/`. |
| G7 | Hard `SIGKILL` orphan recovery in Bubblewrap | `open` | **Unit path advanced:** PID-namespace init capture (`find_pid_namespace_init` / `read_pid_namespace_id`), durable handles use `--as-pid-1`, recovery TERMs namespace init then outer wrapper, CAP_KILL retained via setpriv + compose; formal orphan recovery tests (`tests/test_formal_orphan_recovery.py`) + bubblewrap/identity unit coverage. **Still `open`:** live hard-kill Bubblewrap gate not yet re-run with dated evidence on this branch. |

## H. Security

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| H1 | Cross-tenant blocked | `done` | live isolation gate |
| H2 | Workspace path escape blocked | `done` | path validation + bwrap |
| H3 | Skill tree not writable (exec side) | `done` | canonical RO `/home/sandbox/skill` |
| H4 | Sandbox non-privileged | `done` | compose/prod constraints + gates |
| H5 | Secrets not in model/logs/events | `partial` | MCP results/progress redacted before Pi (`pi-mcp-adapter-factory` + projector); broader URI userinfo redaction; unit tests in mcp-seam + platform-event-projector + secret-and-mcp-policy. Full log/event production audit still open. |
| H6 | Business DB only via controlled MCP | `partial` | Structural: MCP via `pi-mcp-adapter` only; secret-and-mcp-policy + mcp-seam tests assert no direct business DSN tools / sandbox-bridge SQL client. Deployment policy audit still open. |

---

## P0 program board (acceptance blockers)

Derived from open/partial rows that block “refactor complete”:

| Priority | Item | STATUS IDs | Next proof |
|----------|------|------------|------------|
| P0 | Finish durable interaction end-to-end + restart/refresh evidence | G6 | Integration/release-gate: respond → resume → worker restart |
| P0 | Hard SIGKILL orphan recovery in production Bubblewrap | G7 | Live kill during tool; no orphan; honest LOST |
| P0 | Worker/model restart matrix completeness | A4, G2 | Consolidate existing restart tests + missing hard cases |
| P1 | Trace tree completeness (backend + frontend) | D7, F6 | Trace query + UI verification |
| P1 | Frontend refresh matrix sign-off | D1, D5, D6 | Scripted refresh scenarios |
| P1 | Idempotency / create-race live gates | G4, G5 | Live MySQL concurrent create |
| P1 | Secrets & MCP data-plane audit | H5, H6 | Checklist + greps / policy docs |
| P1 | Split future work into reviewable commits | n/a | Process: no more mega-commits on this branch |

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
