# Refactor acceptance status

**Tracks:** `refactor/dsh-rebuild`（未合并；`main` 上的 §32 证据多数已随 Pi / Python 面删除而失效）  
**Last audited at:** `be4a077a` (2026-08-21) on `main`  
**Docs pass:** `2026-08-31` — 把活跃文档里的 `agent/runtime/`、`server.js`、Pi Extension、Wave 3 占位状态与代码对齐；**没有**把任何 §32 行标成 `done`。  
**Normative source:** [`plan.md`](./plan.md) §32
**Evidence index:** [`evidence/`](./evidence/)  
**Process log:** [`PROCESS_LOG.md`](./PROCESS_LOG.md)

> The acceptance program ran on `codex/plan-acceptance`, which merged as PR #1 on
> 2026-07-30 and was deleted. This board now tracks `main`; the dated evidence
> under `evidence/` still refers to gate runs from that program.

This file is the **only** living gap board for plan acceptance.  
A green unit-test suite alone does **not** complete a row.

> ## ⚠️ 2026-08-29 / 31：DSH 重建让本板大部分**旧证据**失效
>
> [ADR 0007](adr/0007-agent-runtime-rebuild-on-dsh.md) / [ADR 0008](adr/0008-sandbox-isolation-and-fs-seam-redesign.md)
> 删除了 Python 执行面（`sandbox/` 36k 行）与 Pi Runtime（`agent/src/infrastructure/pi/`、
> `agent/src/extensions/`）。**凡是以这两处为证据的行，证据文件已经不存在了**，
> 状态不再成立——哪怕它写着 `done`。
>
> 2026-08-29 当时的**功能性回归**（搜索 / 产物 / 数据集是占位实现）已在 Wave 7
> 按语义补齐，见 [`design/waves/gap-audit.md`](design/waves/gap-audit.md) 的
> 「已补」栏与 `exec/test/semantic-gaps.test.ts`。实现补上不等于验收完成：
> C8 / E2 / E3 现为 `partial`，等 compose 里真实 bwrap + 现有 LLMIO 网关下的重新取证。
>
> 2026-08-30 做过逐行重审（见文末）。**在重新取证完成前，不要引用旧的 `done`
> 作为「已达成」**；以本板当前行状态为准。

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
| A1 | Use Pi native Agent Loop | `unknown` | **证据已删除**：`agent/src/infrastructure/pi/*` 不复存在。Pi 换成 DSH（ADR 0007），本行需按 `agent/src/runtime/` 重新表述与取证 |
| A2 | Required enterprise policy layers load | `unknown` | Four required: `sandbox-bridge`, `enterprise-policy`, `observability`, `user-interaction` (the `ask_user` split, 2026-08). Three optional first-party extensions: `skill-lifecycle`, `subagent-spawn` (durable child Runs) and `task-state` (session todo list + owner-scoped notes); each only builds when its durable port/store is injected. enterprise-agent-kit removed; the 12 legacy package names stay refused. |
| A3 | MCP 接入 | `partial` | **2026-08-31（ADR 0009 D9 / 计划 H7）：`pi-mcp-adapter@2.11.0` 已退役**，连同 `agent/src/infrastructure/mcp/pi-mcp-adapter-factory.ts`（1266 行）一起删除。MCP 改为出厂 `@deepseek-ai/dsh-mcp-client`，overlay 里**一台服务器一个插件实例**，条目由 `MCP_SERVERS_JSON` 经 `npm run gen:patch` 生成，密钥只以 `process.env` 占位符出现。`/ready` 的就绪度改为投影 DSH 工具注册表（`readMcpReadiness()`），不再是自建 adapter 的探测快照。单测见 `tests/runtime/mcp-entries.test.ts`。**仍是 `partial`**：还差对着真实 MCP 服务器的端到端取证（H7.8/H7.9 留到 compose）。对外的 MCP facade 是另一回事（见 `docs/sandbox-mcp.md`，已端到端验证）|
| A4 | Multi-turn Session recoverable | `unknown` | Offline: session-recovery + journal units + WAITING_INPUT recovery matrix. **Live 2026-07-19:** full `agent-worker-pi-restart.release-gate.test.js` **5/5 PASS** (model SIGKILL replay, durable interaction, tool boundary, sandbox UNKNOWN) on isolated MySQL/Redis/Sandbox — Pi Session checkpoint path only. Evidence: `evidence/a4-g2-restart-matrix-2026-07-19.md`, `evidence/g6-interaction-worker-restart-2026-07-19.md`. Residual non-blocking: dedicated corrupt-journal-under-kill live gate not separate. |
| A5 | Agent Version pinned | `done` | credential/version binding tests under `agent/tests/a2a/` |

## B. State

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| B1 | MySQL sole fact authority | `done` | Knex schema + repos; Sandbox SQLite stack removed |
| B2 | Redis runtime-only | `done` | architecture + compose; Outbox for durable events |
| B3 | No in-process authoritative Run Map | `partial` | 门禁仍在（已移到 `agent/tests/bootstrap/no-authoritative-run-map.unit.test.js`）且通过；DSH 重建后 `new Map(` 清单未重新盘点。Structural walk of `agent/src`: no RunManager / process-global runs Map; **18 residual `new Map(` inventoried** as instance/local/literal transient-only (dedupe, steer, owner-scoped presentation batching, run-budget, MCP registry, codec, trace materialize, HMAC, model registry). Fail-closed whitelist. Obsolete approval-waiter code has been removed. Evidence: `evidence/partial-b3-run-map-audit-2026-07-19.md`. |
| B4 | No whole-Conversation messages JSON blob | `done` | append-only `messages` rows + triggers |
| B5 | No dual Run state sources | `done` | Agent MySQL authority design |
| B6 | Run Events ordered replay | `done` | `next_event_sequence` + MySQL gate in evidence |

## C. Sandbox

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| C1 | Session ↔ Workspace 1:1 | `partial` | 约束在 agent 侧 MySQL 仍成立；exec 侧改为 `exec_*` 自有表，未重新取证 |
| C2 | Stable Agent paths | `done` | `/home/sandbox/workspace`, `/home/sandbox/skill` |
| C3 | No global mutable workspace symlink | `done` | lease/symlink model removed in refactor |
| C4 | Concurrent session isolation | `unknown` | **证据针对已删除的 Python 执行面**。exec 侧有离线用例（`exec/test/isolation-*.test.ts`），live gate 未重跑 |
| C5 | Ordinary commands no approval | `done` | policy defaults; enterprise tools only |
| C6 | Python multi-line auto-materialize | `partial` | 逻辑已移植（`exec/src/shell/python-materialize.ts`，含单测）。镜像里的 `python3` 与运行库在 2026-08-30 前是缺失的，现已修复并有 plan 断言；**compose 内真实 bwrap 待跑**（Mac Docker 可以，见下） |
| C7 | Long tasks via Process Handle | `unknown` | **证据已删除**：`tests/test_formal_process_handle.py` 随 Python 面移除。TS 侧有 `exec/test/shell-job-registry.test.ts`，但 orphan/identity/bwrap 的等价用例与 live gate 未重建 |
| C8 | Dataset streams into Workspace | `partial` | Wave 7 已改成三段式流式（`beginUpload` → `writeChunk` → `finishUpload`），控制面暂存后再发布到工作区。离线语义用例在 `exec/test/semantic-gaps.test.ts`。**5GiB live 未重跑**，不能标 `done` |

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
| E1 | write/edit do not auto-download | `unknown` | 设计不变（产物走 `submit_artifact` + 控制面快照）。占位实现已在 Wave 7 替换，live 未重跑 |
| E2 | Only `submit_artifact` creates Artifact | `partial` | Wave 7：submit 写真实 sha256 与控制面快照，download 走同一份字节。离线语义用例已钉。**live 未重跑** |
| E3 | Download tenant/user scoped | `partial` | Wave 7：公共面 download 已接服务，owner scope 在仓储层。**跨租户 live 404 未重跑** |

## F. A2A

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| F1 | Agent Card reachable | `done` | A2A surface + live gate |
| F2 | Streaming | `partial` | A2A 已换 `@a2a-js/sdk`（ADR 0007 D8），词汇棘轮仍在并通过；live gate 未重跑。历史记录：**2026-08-26:** the live gate never checked the terminal frame — `message/stream` / `tasks/resubscribe` ended after `working` with no `status-update(final=true)` because the A2A projector's run-status vocabulary (`run.succeeded`) did not match what the Run services emit (`run.status.changed` / `run.completed`, per plan.md §event vocabulary). Fixed, plus a ratchet that fails when a `run.*` eventType in `src/application` is not projectable: `agent/tests/a2a/a2a-terminal-event-vocabulary.unit.test.js`. |
| F3 | Task query / cancel / resubscribe | `done` | live gate |
| F4 | A2A Task ↔ Run mapping | `done` | task service + repos |
| F5 | A2A SSE disconnect does not cancel Run | `done` | protocol design + gate notes |
| F6 | org/client/trace auditable | `done` | A2A audit append carries **org_id + client_id + trace_id** on send_message / cancel_task / artifact_download via real `A2aAuditRepository` (`a2a-audit-correlation.unit.test.js`). Evidence: `evidence/p1-trace-audit-2026-07-19.md`. |

## G. Reliability

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| G1 | Browser disconnect: Run continues | `done` | SSE relay design; worker ownership |
| G2 | Agent Worker restart recoverable | `unknown` | Offline classification covers lease-free replay, mid-tool UNKNOWN, WAITING_INPUT PENDING/RESOLVED/CLAIMED. **Live 2026-07-19:** full real-Pi Worker restart suite **5/5 PASS** (`agent-worker-pi-restart.release-gate.test.js`) + prior checkpoint/BullMQ gates in `evidence/release-gate-2026-07-19.md`. Evidence: `evidence/a4-g2-restart-matrix-2026-07-19.md`. Residual non-blocking: dedicated graceful SIGTERM mid-run drain gate not separate. |
| G3 | Redis blip does not lose fact events | `done` | Outbox + Redis gate evidence |
| G4 | Duplicate request no duplicate side effects | `done` | Offline concurrent begin (same/different hash) + FOR UPDATE. **Live 2026-07-19:** 20-way same-key CreateRun on `pi_gate_20260719_g4g5` → 1 run / 1 message / 1 accepted / 1 outbox / 1 idempotency. Evidence: `evidence/p1-g4-g5-idempotency-2026-07-19.md`. |
| G5 | Create Run then immediate query race-free | `done` | Offline: create txn held open until commit before return + immediate GET. **Live:** every concurrent response immediately GET-able ACCEPTED\|QUEUED. Same evidence doc. |
| G6 | Durable WAITING_INPUT / interaction resume | `done` | **Unit:** interaction HTTP respond/rehydrate, GET `pending_input`, execute-run resume, cancel races (17 pass). **Live:** `agent-worker-pi-restart.release-gate.test.js` case *continues one durable interaction after Worker restart…* PASS on isolated MySQL/Redis/Sandbox (`pi_gate_20260719_g6int`, 2026-07-19): park → SIGKILL Worker A → rehydrateWaiting+respond → Worker B SUCCEEDED / APPLIED / 2 provider calls. Evidence: `evidence/g6-interaction-worker-restart-2026-07-19.md`. |
| G7 | Hard `SIGKILL` orphan recovery in Bubblewrap | `unknown` | **Unit:** PID-namespace init, `--as-pid-1`, CAP_KILL, `tests/test_formal_orphan_recovery.py` + identity/bubblewrap (19 pass). **Live:** `scripts/release-gates/sandbox-live-gate.mjs` with `SANDBOX_GATE_HARD_KILL=1` + managed non-privileged Bubblewrap container PASS (`2026-07-19T08:54:17Z`): orphan survived service SIGKILL; after restart process → `lost` (OS orphan gone), claim → `UNKNOWN`/`CRASH_RECOVERY_UNKNOWN`, no auto-replay. Evidence: `evidence/g7-hard-kill-orphan-2026-07-19.md`. |

## H. Security

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| H1 | Cross-tenant blocked | `done` | live isolation gate |
| H2 | Workspace path escape blocked | `partial` | 性质已移植且有离线用例（`exec/test/fs-path-policy.test.ts`、`isolation-*`、`search-service.test.ts` 的符号链接越界）；live gate 未重跑 |
| H3 | Skill tree not writable (exec side) | `partial` | `exec/test/isolation-build.test.ts` 断言 skill 层全为 `ro_bind`；live gate 未重跑 |
| H4 | Sandbox non-privileged | `partial` | 镜像以 uid 10001 运行（已在容器内实测）；`setpriv` 剥离 capabilities 为 fail-closed。compose/prod 约束未随新镜像重审 |
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

Non-blocking debt remains in [`review-deferred-items.md`](./review-deferred-items.md).

> **2026-08-30 重审后，这段 P0 板已经过时。** 上面的表格记录的是 2026-07 那一轮
> 验收；DSH 重建之后，`unknown` / `partial` 的行不再是 H5/H6 两条。当前真正的
> 阻塞项是下面这张表。

---

## 2026-08-30 重审：DSH 重建后的阻塞项

逐行核对了每条 `done` 引用的证据文件是否还存在。结论：

| 行 | 新状态 | 为什么 |
|---|---|---|
| A1, A2, A3, A4 | `unknown` | 证据指向已删除的 `agent/src/infrastructure/pi/*`、`agent/src/extensions/`、`agent/tests/pi/mcp-adapter.integration.test.js`，以及针对真实 Pi 的 restart release gate |
| C1, C6 | `partial` | 逻辑已移植且有离线用例，但取证对象换了（`exec_*` 表 / TS 实现），未重新取证 |
| C4, C7 | `unknown` | 证据是 Python 执行面的 live gate 与已删除的 `tests/test_formal_process_handle.py` |
| C8, E2, E3 | `partial` | Wave 7 已补齐实现（流式数据集、控制面产物快照、owner-scoped download）；待 Linux / 网关重新取证，不是还在占位 |
| F2 | `partial` | A2A 换 `@a2a-js/sdk`，词汇棘轮仍通过，live gate 未重跑 |
| G2, G7 | `unknown` | 证据是针对 Pi / Python 执行面的 live gate |
| H2, H3, H4 | `partial` | 安全性质已随 `exec/` 移植并有离线用例；live gate 未重跑 |
| B, D, F1/F3–F6, G1/G3–G6, H1 | 维持 | agent/BFF/frontend 侧代码未被重建影响，或证据仍成立 |

**重新取证需要的两件事**，都在本机 Docker + 现有 LLMIO 上可做：

1. **compose 里的真实 bwrap** —— Mac 的 Docker Desktop 里是 Linux VM，和 main
   上起 sandbox 是同一条路。`No permissions to create new namespace` 不是
   「Docker Desktop 不支持」：compose 必须带
   `seccomp=./exec/seccomp-bubblewrap.json`，进容器验 bwrap 必须
   `--user 10001:10001`（root + `cap_drop: ALL` 会失败）。涉及隔离执行的行
   （C4/C6/C7/G7/H2/H3/H4）卡的是「还没在这条分支上重跑」，不是宿主机。
2. **现有 LLMIO 网关** —— A 组与 G2 需要真实 Run，用 `LLMIO_BASE_URL` /
   `LLMIO_API_KEY`。不要另开一套生产网关冒烟当阻塞项。

已经完成的：MCP 全链路在 compose 上端到端验证（工具列表、文件往返、连续产物
提交、签名下载的字节与 sha256 一致、篡改 token 404）。

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
