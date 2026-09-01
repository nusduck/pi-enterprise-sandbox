# Refactor acceptance status

**Tracks:** `refactor/dsh-rebuild`（未合并；`main` 上的 §32 证据多数已随 Pi / Python 面删除而失效）  
**Last audited at:** `refactor/dsh-rebuild` working tree after `83a026b7` (2026-09-01)
**Docs pass:** `2026-09-01` — 对齐 ADR 0009、Agent 浏览器认证权威、DSH 多轮 journal、原生 session resume、Worker 重启后模型上下文、exec 长进程账本与真机收口证据。
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
| A2 | Required enterprise policy layers load | `done` | 七个旧 Extension 已删除；当前取证对象是五个 per-Run 策略挂载点与 `ENTERPRISE_DEFAULT_TOOLS` 精确工具面。离线 boot/policy 用例覆盖真实插件树，2026-08-31 compose 已验证真实 bwrap、审批停泊/续跑和 Skill 草稿/发布；2026-09-01 补齐 Capabilities 启用 HTTP/BFF/UI、MySQL 启用账本、exec owner-scoped 挂载与并行 ToolExecution 收尾，并由真实 LLM 完成前台及后台 `bash` ToolExecution。Evidence: [`evidence/2026-09-01-dsh-process-closure-live-chain.md`](evidence/2026-09-01-dsh-process-closure-live-chain.md)。 |
| A3 | MCP 接入 | `done` | `pi-mcp-adapter` 已退役；`@deepseek-ai/dsh-mcp-client` 按 `MCP_SERVERS_JSON` 一 server 一插件实例，密钥只用 env 引用，`/ready` 投影 DSH 注册表。`tests/runtime/mcp-live.test.ts` 用官方 SDK 真 stdio server 验证连接 → `tools/list` 注册 → 实际调用回包；`mcp-entries.test.ts` 覆盖配置与密钥 fail-closed。对外 `sandbox-mcp` facade 是独立入口。 |
| A4 | Multi-turn Session recoverable | `done` | DSH offline recovery/journal 用例覆盖 header 保留与空 checkpoint 单根连接。2026-09-01 compose：同一 Agent Session 原生 `create` → MySQL 落盘 → `resume`；Worker `SIGKILL` 换新 PID 后 follow-up 仍 `resume`，模型原样复述上一轮一次性口令。Evidence: [`evidence/2026-09-01-dsh-worker-restart-model-context.md`](evidence/2026-09-01-dsh-worker-restart-model-context.md)、[`evidence/2026-09-01-dsh-native-session-resume.md`](evidence/2026-09-01-dsh-native-session-resume.md)。 |
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
| C1 | Session ↔ Workspace 1:1 | `partial` | Agent 侧唯一约束仍成立；2026-09-01 真机证明 BFF 经 Agent 授权把 Sandbox Session 映射到同一 Workspace，并能查询 exec-owned 进程。尚未重跑并发创建/冲突约束 gate。 |
| C2 | Stable Agent paths | `done` | `/home/sandbox/workspace`, `/home/sandbox/skill` |
| C3 | No global mutable workspace symlink | `done` | lease/symlink model removed in refactor |
| C4 | Concurrent session isolation | `unknown` | **证据针对已删除的 Python 执行面**。exec 侧有离线用例（`exec/test/isolation-*.test.ts`），live gate 未重跑 |
| C5 | Ordinary commands no approval | `done` | policy defaults; enterprise tools only |
| C6 | Python multi-line auto-materialize | `partial` | 逻辑已移植（`exec/src/shell/python-materialize.ts`，含单测）。镜像里的 `python3` 与运行库在 2026-08-30 前是缺失的，现已修复并有 plan 断言；**compose 内真实 bwrap 待跑**（Mac Docker 可以，见下） |
| C7 | Long tasks via Process Handle | `partial` | exec 以 `exec_jobs` 持久化进程事实；2026-09-01 模型后台 `bash` → exec 登记 → BFF list/log/signal/cancel → 跨租户 404 真机通过。剩余缺口：模型侧同步 `job_list`/`job_output` 尚未取得异步 exec 结果；日志缓冲与活句柄不能跨 exec 重启恢复；hard-kill/orphan gate 未跑。Evidence: [`evidence/2026-09-01-dsh-process-closure-live-chain.md`](evidence/2026-09-01-dsh-process-closure-live-chain.md)。 |
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
| G7 | Hard `SIGKILL` orphan recovery in Bubblewrap | `unknown` | 当前 exec 有启动期 `recoverOrphans()` 与离线 registry 用例，但旧证据针对已删除的 Python 执行面。本轮只验证正常 SIGTERM 收敛，没有硬杀 exec 服务，因此不能复用 2026-07-19 结论。 |

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

### 2026-09-01 当前重审增量

| 行 | 当前状态 | 新证据 / 剩余缺口 |
|---|---|---|
| A2 | `done` | 真实 LLM 模型驱动前台/后台工具 Run 已完成；策略、账本与 exec 链均生效 |
| A4 | `partial` | 同 Session 连续 Run 已通过；仍缺原生 DSH persistence resume 与 Worker 重启上下文 gate |
| C7 | `partial` | start/list/log/signal/cancel 与跨租户 404 已通过；仍缺模型侧 job 查询和 exec 重启恢复 |
| G7 | `unknown` | 未执行 exec hard-SIGKILL/orphan gate |

Evidence: [`evidence/2026-09-01-dsh-process-closure-live-chain.md`](evidence/2026-09-01-dsh-process-closure-live-chain.md)。

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

这段合并记录之后又发生了 DSH / TypeScript exec 重建；当前阻塞项以本板顶部行状态和
“2026-09-01 当前重审增量”为准，不能再把 H5/H6 写成唯一缺口。
