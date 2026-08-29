# Refactor acceptance status

**Tracks:** `main`  
**Last audited at:** `be4a077a` (2026-08-21)  
**Docs pass:** `0a73cf64` (2026-08-23) — reviewed commits #13–#21 for documentation impact; no §32 row status changed. #21 (internal plane fail-closed, non-root containers, bounded BFF outbound, sandbox auth fail-closed) strengthens existing rows and does not close H5/H6 ops sampling.  
**Normative source:** [`plan.md`](./plan.md) §32
**Evidence index:** [`evidence/`](./evidence/)  
**Process log:** [`PROCESS_LOG.md`](./PROCESS_LOG.md)

> The acceptance program ran on `codex/plan-acceptance`, which merged as PR #1 on
> 2026-07-30 and was deleted. This board now tracks `main`; the dated evidence
> under `evidence/` still refers to gate runs from that program.

This file is the **only** living gap board for plan acceptance.  
A green unit-test suite alone does **not** complete a row.

> ## ⚠️ 2026-08-29：DSH 重建让本板大部分证据失效
>
> [ADR 0007](adr/0007-agent-runtime-rebuild-on-dsh.md) / [ADR 0008](adr/0008-sandbox-isolation-and-fs-seam-redesign.md)
> 删除了 Python 执行面（`sandbox/` 36k 行）与 Pi Runtime（`agent/src/infrastructure/pi/`、
> `agent/src/extensions/`）。**凡是以这两处为证据的行，证据文件已经不存在了**，
> 状态不再成立——哪怕它写着 `done`。
>
> 已知**功能性回归**（不是"证据过期"，是功能真的没了），逐函数对照见
> [`design/waves/gap-audit.md`](design/waves/gap-audit.md)，红色用例在
> `exec/test/semantic-gaps.test.ts`：
>
> - **搜索**：`exec/` 无 search 模块，find/grep 是 `listDir` 假实现
> - **产物**：公共面四条路由全是占位（submit 编造 `sha256: '0'×64`，download 恒 404）
> - **数据集**：上传不落盘；`DatasetService` 签名收整块 `Uint8Array`，撑不住 C8 的 5GiB
>
> 本板的逐行重审尚未做。**在重审完成前，把每一行都当 `unknown` 对待**，
> 不要引用它作为"已达成"的依据。

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
| A1 | Use Pi native Agent Loop | `unknown` | **证据已删除**：`agent/src/infrastructure/pi/*` 不复存在。Pi 换成 DSH（ADR 0007），本行需按 `agent/runtime/` 重新表述与取证 |
| A2 | Required enterprise extensions load | `done` | Four required: `sandbox-bridge`, `enterprise-policy`, `observability`, `user-interaction` (the `ask_user` split, 2026-08). Three optional first-party extensions: `skill-lifecycle`, `subagent-spawn` (durable child Runs) and `task-state` (session todo list + owner-scoped notes); each only builds when its durable port/store is injected. enterprise-agent-kit removed; the 12 legacy package names stay refused. |
| A3 | MCP via `pi-mcp-adapter` | `done` | exact pin + 启动期 `tools/list` 发现/ready fail-closed（`agent/tests/pi/mcp-adapter.integration.test.js`） |
| A4 | Multi-turn Session recoverable | `done` | Offline: session-recovery + journal units + WAITING_INPUT recovery matrix. **Live 2026-07-19:** full `agent-worker-pi-restart.release-gate.test.js` **5/5 PASS** (model SIGKILL replay, durable interaction, tool boundary, sandbox UNKNOWN) on isolated MySQL/Redis/Sandbox — Pi Session checkpoint path only. Evidence: `evidence/a4-g2-restart-matrix-2026-07-19.md`, `evidence/g6-interaction-worker-restart-2026-07-19.md`. Residual non-blocking: dedicated corrupt-journal-under-kill live gate not separate. |
| A5 | Agent Version pinned | `done` | credential/version binding tests under `agent/tests/a2a/` |

## B. State

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| B1 | MySQL sole fact authority | `done` | Knex schema + repos; Sandbox SQLite stack removed |
| B2 | Redis runtime-only | `done` | architecture + compose; Outbox for durable events |
| B3 | No in-process authoritative Run Map | `done` | Structural walk of `agent/src` (`no-authoritative-run-map.unit.test.js`): no RunManager / process-global runs Map; **18 residual `new Map(` inventoried** as instance/local/literal transient-only (dedupe, steer, owner-scoped presentation batching, run-budget, MCP registry, codec, trace materialize, HMAC, model registry). Fail-closed whitelist. Obsolete approval-waiter code has been removed. Evidence: `evidence/partial-b3-run-map-audit-2026-07-19.md`. |
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
| C7 | Long tasks via Process Handle | `done` | Single-instance formal path: ProcessManager start/status/read/kill + dual-write + durable `die_with_parent=False`/`as_pid_1=True` (`tests/test_formal_process_handle.py` + orphan/identity/bwrap). Evidence: `evidence/partial-c7-process-handle-2026-07-19.md`. **Residual (non-blocking):** multi-host reclaim review-deferred — honest LOST on this host only. |
| C8 | Dataset streams into Workspace | `open` | **回归**：`exec/src/dataset/service.ts` 的 `create(content: Uint8Array)` 整块进内存，5GiB 会打死进程；公共面上传不落盘。见 [gap-audit](design/waves/gap-audit.md#二数据集) |

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
| E1 | write/edit do not auto-download | `unknown` | 设计不变，但产物面已是占位实现，未重新取证 |
| E2 | Only `submit_artifact` creates Artifact | `open` | **回归**：`public/artifacts.ts` 的 submit 编造记录不落盘，download 恒 404。见 [gap-audit](design/waves/gap-audit.md#三产物) |
| E3 | Download tenant/user scoped | `open` | **回归**：`ArtifactService` 只按 workspaceId 比对，缺 org/user/conversation 维度；且公共面 download 未接服务 |

## F. A2A

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| F1 | Agent Card reachable | `done` | A2A surface + live gate |
| F2 | Streaming | `done` | live gate. **2026-08-26:** the live gate never checked the terminal frame — `message/stream` / `tasks/resubscribe` ended after `working` with no `status-update(final=true)` because the A2A projector's run-status vocabulary (`run.succeeded`) did not match what the Run services emit (`run.status.changed` / `run.completed`, per plan.md §event vocabulary). Fixed, plus a ratchet that fails when a `run.*` eventType in `src/application` is not projectable: `agent/tests/a2a/a2a-terminal-event-vocabulary.unit.test.js`. |
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
| H5 | Secrets not in model/logs/events | `partial` | Offline dual-path closed (redaction + suite green). Ops residual checklist: `evidence/partial-h5-h6-ops-checklist-2026-07-19.md` (+ prior h5-h6 evidence). **Still open:** production/staging log + durable-row sampling under secret-bearing MCP load — no invented samples. |
| H6 | Business DB only via controlled MCP | `partial` | Offline structural closed: MCP-only module set; enterprise tools = sandbox-bridge 10 + ask_user; tightened secret-and-mcp-policy. Same ops checklist. **Still open:** deployment `MCP_SERVERS_JSON` allowlist audit + live no-business-SQL-tool snapshot. |

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
| P1 | Secrets & MCP data-plane audit | H5, H6 | Offline closed; ops checklist `evidence/partial-h5-h6-ops-checklist-2026-07-19.md`; **production sampling + deploy allowlist still open** |
| P1 | ~~Split future work into reviewable commits~~ | n/a | **done** this session — STATUS-family commits on `codex/plan-acceptance` |
| residual | ~~B3 residual Run Map audit~~ | B3 | **done** — fail-closed Map whitelist 2026-07-19 |
| residual | ~~C7 single-instance Process Handle~~ | C7 | **done** — formal handle lifecycle offline; multi-host deferred |

Non-blocking debt remains in [`review-deferred-items.md`](./review-deferred-items.md). Remaining STATUS `partial`: **H5, H6** only (ops sampling).

---

## Work merged after the acceptance program (2026-08-01 → 2026-08-21)

`main` moved on after the §32 board was last audited. None of it reopened a
`done` row, but the rows it touches are worth naming so the next audit knows
where to look:

| Merged | Change | Rows it touches |
|--------|--------|-----------------|
| `0454f730` | Hermes-style tool paging and output budgets for sandbox tools | C5, C6 |
| `6f991674` `0f58c3af` | Model selection, vision input, thinking UI | D2 |
| `0db540c1` (#6) | Session restore + Run lifecycle synchronisation in the web UI | D1, D3 |
| `752fd8ed` | `sandbox-mcp` bridge errors, non-ASCII artifact downloads | E3 |
| `15e5aaf2` `90eb0ff7` (#7) `192a2520` | A2A v0.3 surface, SDK-valid streaming status, official task-lifecycle streams | F1–F5 |
| `862b9f5e` (#8) | User Skill installation lifecycle redesign — `skill-lifecycle` extension | A2, H3 |
| `266af012` (#9) | User Skill paths allowed in sandbox reads and binds | C2, H3 |
| `b2fe388e` | Sandbox dev egress; production overlay strips it | H4 |
| `7fae4dbd` | MCP discovered schemas projected to the model | A3 |
| `be4a077a` (#10) | Agent service ↔ Pi SDK gap closure | A1, A4 |

The H5/H6 ops sampling is still the only thing between this board and
"refactor complete", and it still needs a real deployment — no offline substitute.
