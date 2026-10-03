# Refactor acceptance status

**Tracks:** `main`（DSH 重建已合并；旧 Pi / Python 面的 §32 证据已随删除而失效，以各行为准）  
**Last audited at:** `main` @ `bb810344`（2026-10-03；本次仅核对 #82–#111 对相关行的影响，并接入[开发栈链路证据](evidence/2026-10-03-fixes-cleanup-live-chain.md)；2026-10-02 对 A2 / A3 / C4 / E1–E3 / F2 / H2 / H3 的清库重建取证仍见各行。**非全表、非目标环境重新验收**；C8、H5/H6 未执行其剩余 gate。）

**Docs pass:** `2026-10-03` — #103 核对并修正文档与代码漂移；不代表本板所有历史备注已重新验收。

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
> 当时 C8 / E2 / E3 均为 `partial`；E2 / E3 已在 2026-10-02 补证，当前状态以各行状态列为准。C8 的 5 GiB gate 仍未重跑。
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
| A2 | Required enterprise policy layers load | `done` | 插件树、基础策略与 exec 工具链已有[既往取证](evidence/2026-09-01-dsh-process-closure-live-chain.md)。2026-09-06：AgentVersion 显式 deny、MCP 精确引用、风险跨具体性取更严已在**真实插件树 + `tools.execute`** 验证（含正向对照：被授权工具体执行一次），见[接入证据 §2](evidence/2026-09-06-agent-version-runtime-integration.md)。2026-09-06 P5：重建容器后以 admin 走完真机链——deny 版本使工具从模型侧消失且无 `tool_executions` 行、无 deny 对照版本工具执行成功（[证据 §5](evidence/2026-09-06-agent-version-runtime-integration.md)，开发栈）。2026-09-06 当时尚未补审批停泊→批准→放行一次的浏览器专项。2026-10-02 真机（开发栈）：需审批的工具调用停在 `WAITING_APPROVAL`、批准前无执行、他人 404、批准后放行**恰好一次**（重复批准 `changed:false`），账本 1 行终态；`bash`+`require_approval` 同样通过。证据: [`evidence/2026-10-02-acceptance-gates-a2-a3-c4-h2-h3-f2.md`](evidence/2026-10-02-acceptance-gates-a2-a3-c4-h2-h3-f2.md)。审批中心的浏览器操作未做（本次 API 驱动）。 |
| A3 | MCP 接入 | `done` | `@deepseek-ai/dsh-mcp-client` 连接、发现与调用已有真实 stdio 测试，外部 facade 仍为独立入口。2026-09-06：AgentVersion 引用现在**限制执行权限**——未引用 server/tool 一律拒、空引用零 MCP 权限、被引用工具经真实管线放行一次，见[接入证据 §2](evidence/2026-09-06-agent-version-runtime-integration.md)。目录不可读（`unknown`）与空目录已在校验面区分。2026-09-06 真机链证 config/options 的 `mcpReadiness=ready` 且不泄漏连接材料（[证据 §5.1](evidence/2026-09-06-agent-version-runtime-integration.md)）。2026-09-06 当时尚未补合法引用调用一次的容器内工具链。2026-10-02 真机：智能体版本只授权 `exa/web_search_exa`，模型调用经审批后成功执行一次（真实 MCP 服务，非替身）。证据: [`evidence/2026-10-02-acceptance-gates-a2-a3-c4-h2-h3-f2.md`](evidence/2026-10-02-acceptance-gates-a2-a3-c4-h2-h3-f2.md)。 |
| A4 | Multi-turn Session recoverable | `done` | DSH offline recovery/journal 用例覆盖 header 保留与空 checkpoint 单根连接。2026-09-01 compose：同一 Agent Session 原生 `create` → MySQL 落盘 → `resume`；Worker `SIGKILL` 换新 PID 后 follow-up 仍 `resume`，模型原样复述上一轮一次性口令。Evidence: [`evidence/2026-09-01-dsh-worker-restart-model-context.md`](evidence/2026-09-01-dsh-worker-restart-model-context.md)、[`evidence/2026-09-01-dsh-native-session-resume.md`](evidence/2026-09-01-dsh-native-session-resume.md)。 |
| A5 | Agent Version pinned | `partial` | 版本 ID 与会话绑定已有实现和 `agent/tests/a2a/` 回归。2026-09-06：模型生成参数（maxTokens/effort）、persona 字面量与企业 section、逻辑路径的实际消费面已在**真实 wire request** 验证，配置契约（v1/legacy、字段校验、乐观并发激活）与配置面接口已落地并有单元/HTTP/BFF/前端回归，见[接入证据](evidence/2026-09-06-agent-version-runtime-integration.md)。2026-09-06 真机链证：旧会话追加轮次钉在其绑定版本（active 指针已后移仍不受影响）、新会话用当前 active 版本、激活乐观并发 409 回传当前指针（[证据 §5.2/§5.3](evidence/2026-09-06-agent-version-runtime-integration.md)，开发栈）；未改写历史 JSON/hash。 2026-09-30：平台任务约定、工具指导随 schema 过滤与文件交付指导已落地；真实模型两轮请求 header、产物快照、进程控制和跨组织 404 已验证，见[证据](evidence/prompt-assembly-contract-2026-09-30.md)。本行保持 partial。 2026-10-03：无 `schemaVersion` 的旧配置升级路径已删除（#106），此类配置现按 `CONFIG_SCHEMA_VERSION_MISSING` 明确拒绝；开发库全部版本已带 schemaVersion。 |

## B. State

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| B1 | MySQL sole fact authority | `done` | Knex schema + repos; Sandbox SQLite stack removed |
| B2 | Redis runtime-only | `done` | architecture + compose; Outbox for durable events |
| B3 | No in-process authoritative Run Map | `partial` | 门禁仍在（已移到 `agent/tests/bootstrap/no-authoritative-run-map.unit.test.js`）且通过；DSH 重建后 `new Map(` 清单未重新盘点。Structural walk of `agent/src`: no RunManager / process-global runs Map; **53 residual `new Map(` inventoried** (gate-pinned count; 31 on 2026-09-14, 34 with ADR 0012 queue handles, 36 on 2026-09-25 with the per-Run approved-replay call-id alias and the remote A2A agent-card cache, 39 on 2026-09-26 with MCP host-argument declarations and the per-Run host-argument shadow indexes, 38 on 2026-09-29 after the conversation transcript stopped serving assistant rows and dropped its journal-thinking lookup, 41 on 2026-09-30 with the ADR 0015 skillPolicy indexes — skill-policy org-version lookup, per-Run effective-skill winners, and the Agent Card system-skill name index, 43 on 2026-09-30 with the org-tier ledger listing indexes — current-pointer lookup and name grouping in OrgSkillRepository, 45 on 2026-09-30 with the AgentVersion skill-ref ledger (name -> referenced digests) and the org-tier GC current-pointer index, 47 on 2026-09-30 with the skill-usage tier merge — (agent_version, scope) -> names index and (name, tier) -> call-count accumulator in AdminRunReadRepository.skillUsage, 51 on 2026-10-01 after review indexes, 53 on 2026-10-03 with C7 instance-local output cursor and one-call job-list merge index) as instance/local/literal transient-only (dedupe, steer, owner-scoped presentation batching, run-budget, MCP registry, codec, trace materialize, model registry, config validation, per-Run published-skill provider indexes, depth-layered queue handles, approved-replay alias, A2A card cache, MCP host-argument declarations and per-Run shadow indexes). Known gate gap: the scan regex skips `new Map<…>` whose type argument contains `{`, `;` or `}`. Fail-closed whitelist. Obsolete approval-waiter code has been removed. Evidence: `evidence/partial-b3-run-map-audit-2026-07-19.md`. |
| B4 | No whole-Conversation messages JSON blob | `done` | append-only `messages` rows + triggers |
| B5 | No dual Run state sources | `done` | Agent MySQL authority design |
| B6 | Run Events ordered replay | `done` | `next_event_sequence` + MySQL gate in evidence |

## C. Sandbox

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| C1 | Session ↔ Workspace 1:1 | `partial` | Agent 侧唯一约束仍成立；2026-09-01 真机证明 BFF 经 Agent 授权把 Sandbox Session 映射到同一 Workspace，并能查询 exec-owned 进程。尚未重跑并发创建/冲突约束 gate。 **2026-10-03**：删除/归档会话时按 `workspace_id` 回收工作区与配对 temp（#107，此前 exec 无该路由且 agent 传错 id，工作区从未回收），真机确认目录消失、后台作业 `killed`，他人删除 404 且工作区保留（[证据](evidence/2026-10-03-fixes-cleanup-live-chain.md) phase7）。并发创建/冲突约束 gate 仍未重跑，本行保持 partial。 |
| C2 | Stable Agent paths | `done` | `/home/sandbox/workspace`, `/home/sandbox/skill` |
| C3 | No global mutable workspace symlink | `done` | lease/symlink model removed in refactor |
| C4 | Concurrent session isolation | `done` | 早期证据针对已删除的 Python 执行面；exec 侧另有离线用例（`exec/test/isolation-*.test.ts`），2026-10-02 已补当前执行面的真机 gate。**2026-09-16 修了一个此前不成立的前提**：`SANDBOX_MAX_PROCESS_COUNT` 等资源限额与 `ChildWorkspaceQuotaWatch` 子进程配额监控在 `exec/src` 里没有任何消费者，「每工作区资源约束」只是声明（审查 R1）。现在装配层读限额、逐条落到命名空间内部 `ulimit`，shell 路由做 spawn 前配额准入 + 执行中采样，生产启动调 `assertProductionQuotaBackend()`。离线回归：`exec/test/internal-shell-wiring.test.ts`、`exec/test/isolation-render.test.ts`。**同日复核 F1**：外部 MCP 的 `/internal/mcp/v1/shell/execute`、`python/execute` 当时仍是裸执行器，已改为与内部路由共用 `shell/guarded-execution.ts`（回归 `exec/test/internal-mcp-limits.test.ts`）。2026-09-16 当时尚未跑低阈值超限、另一 owner 正对照与重启后额度一致 gate。**2026-10-02 真机复核**（证据: [`evidence/2026-10-02-acceptance-gates-a2-a3-c4-h2-h3-f2.md`](evidence/2026-10-02-acceptance-gates-a2-a3-c4-h2-h3-f2.md)）：namespace 内 rlimit 与 compose 渲染值逐项一致；nproc 上限使 60 个子进程只起来 37 个（额度内 5/5 对照成功）；两个 owner 并发各 3 秒、互相看不到对方文件；低阈值 exec（2 MB 配额）下超限写入在执行中被终止、越线后新命令被拒且未 spawn、另一 owner 不受影响、**重启 exec 后额度状态与落盘字节一致**。边界：配额一项用的是另起的低阈值 exec 容器（同镜像、同安全配置），不是对开发栈填盘。 |
| C5 | Ordinary commands no approval | `done` | policy defaults; enterprise tools only |
| C6 | Python multi-line auto-materialize | `partial` | 逻辑已移植（`exec/src/shell/python-materialize.ts`，含单测）。镜像里的 `python3` 与运行库在 2026-08-30 前是缺失的，现已修复并有 plan 断言；**compose 内真实 bwrap 待跑**（Mac Docker 可以，见下） |
| C7 | Long tasks via Process Handle | `partial` | exec 以 `exec_jobs` 持久化进程事实；2026-09-01 模型后台 `bash` → exec 登记 → BFF list/log/signal/cancel → 跨租户 404 真机通过。当时缺口：模型侧同步 `job_list`/`job_output` 对非本进程作业不能返回 exec 权威结果；日志缓冲与活句柄不能跨 exec 重启恢复。exec 启动期孤儿回收的 G7 gate 已于 2026-09-04 通过，两者不能混同。Evidence: [`evidence/2026-09-01-dsh-process-closure-live-chain.md`](evidence/2026-09-01-dsh-process-closure-live-chain.md)。**2026-09-16 修了三条跨服务接线**（审查 R2/R4/R6）：前台 RPC 的传输截止改为「执行预算 + 有界回传余量」并与取消融合（此前 15 秒固定超时让客户端放弃、沙箱继续执行）；`workdir`/`stdin`/`env`/`stdoutMaxBytes` 不再被路由静默丢弃；Agent 侧后台输出缓冲有界。离线回归：`agent/tests/runtime/shell-deadline-buffer.test.ts`、`exec/test/internal-shell-wiring.test.ts`、`contract/test/shell-payload.test.ts`。20 秒任务在 120 秒预算内成功、短预算超时停止写入、取消/断连后无残留写入这三项已用真实 bwrap 验证：2026-09-16 于 `99ef6b02`（[证据 §一](evidence/exec-resource-limits-and-shell-contract-2026-09-16.md)），2026-09-17 在执行编排收进 `guarded-execution.ts` 之后的 `1e1fc604` 上复验 5/5（含写入正对照，[证据 §三](evidence/worker-restart-gate-layered-and-c7-recheck-2026-09-17.md)）。**当时本条仍是 `partial`**：上面所列的模型侧 job 查询与 exec 重启后恢复未完成；本行末尾记录了后续修复。**2026-10-03**：`kill` 默认 SIGKILL（#84）、`signal` 按信号种类区分且终态不再被 `stopping` 覆盖（#95，真机仅覆盖 SIGKILL 路径）、进程控制台自动加载与轮询（#98），phase1/phase6b 通过（[证据](evidence/2026-10-03-fixes-cleanup-live-chain.md)）。2026-10-03 本地 K8s 双 Worker 先用模型侧 `job_list`/`job_output` 真链路复现跨副本空结果，并由另一 Pod 直接查 exec 取得正确状态和输出（[红灯证据](evidence/2026-10-03-c7-cross-worker-model-jobs-repro.md)）。随后修复：exec 增加 owner 作用域 `jobs/list`；模型侧三个 job 工具等待 exec 响应，移除远端作业占位快照；重建 Agent/exec 后跨 Worker `job_list`/`job_output`/`job_kill` 场景 5/5 通过（kill 前删除原 Worker Pod）（[绿灯证据](evidence/2026-10-03-c7-cross-worker-model-jobs-fix.md)）。**本行仍为 `partial`**：exec 自身重启后内存日志缓冲与活句柄仍不恢复；该恢复边界尚未在本轮重新验收。 **2026-10-03 输出落盘**：exec 把作业输出落到控制根 `job-output/`（运行中约每秒、结束时强制），无 live 条目时从文件按游标续读，读不到时返回 `outputUnavailable`；Compose 真机：模型起后台作业后不读，重启 exec，BFF 日志 8/8 读到重启前输出、跨用户 404；模型 `job_output` 6/8 读到，2/8 拿到空增量（请求携带了越过文件末尾的游标，来源未定位，未能在抓包下复现）（[证据](evidence/2026-10-03-c7-job-output-persist.md)）。**本行仍为 `partial`**：上述模型侧空读未定位。活句柄不跨 exec 重启已由 [ADR 0017](adr/0017-process-handles-do-not-survive-exec-restart.md) 定为设计边界（产品 2026-10-03 确认），不再算缺口；剩余唯一缺口是模型侧空读。 |
| C8 | Dataset streams into Workspace | `partial` | Wave 7 已改成三段式流式（`beginUpload` → `writeChunk` → `finishUpload`），控制面暂存后再发布到工作区。离线语义用例在 `exec/test/semantic-gaps.test.ts`。**5GiB live 未重跑**，不能标 `done` |

## D. Frontend

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| D1 | Refresh restores messages/tools/process/artifacts | `done` | **2026-07-19 offline matrix:** rehydrateConversation restores messages/tools/process/artifacts; WAITING_INPUT via rehydrateInProgress. Fixed durable history seq + flat platform payloads (`platformEventNormalize`; the legacy `agentEventAdapter` was removed 2026-09-30). FE suite 200 pass. Evidence: `evidence/p1-fe-refresh-matrix-2026-07-19.md`. Residual non-blocking: browser F5 harness absent. |
| D2 | Show Run status | `done` | run UI + SSE |
| D3 | Cancel Run | `done` | controls + API；2026-10-03：无活 Worker 时取消 Run 收尾工具账本（#82），Worker 重启后取消真机通过（[证据](evidence/2026-10-03-fixes-cleanup-live-chain.md) phase3b） |
| D4 | Upload Dataset | `done` | upload tests + BFF proxy |
| D5 | View Process output | `done` | Process entity→console logs; owner-scoped process API client paths; ProcessConsole structural UI. Evidence: `evidence/p1-fe-refresh-matrix-2026-07-19.md`. 2026-10-03 浏览器真机：打开控制台即加载日志、运行中轮询、取消后显示终态（#98，[证据](evidence/2026-10-03-fixes-cleanup-live-chain.md) phase6b）。 |
| D6 | Enterprise approval UX | `done` | `resolveApprovalDecision` never marks on failed decide; pending remains decidable; ApprovalsPage failure banner contract. Evidence: `evidence/p1-fe-refresh-matrix-2026-07-19.md`. Residual: browser Approval Center audit. |
| D7 | View Trace | `done` | Durable MySQL span projection + `TraceQueryService.listForRun` + BFF `/trace` authority + FE TracePanel rehydrate. Evidence: `evidence/p1-trace-audit-2026-07-19.md`. Residual: full OTEL backend productization out of scope. |
| D8 | View Agent A2A config | `done` | `A2aPage` + BFF `/api/a2a` |

## E. Artifact

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| E1 | write/edit do not auto-download | `done` | 2026-10-02 清库重建后的真机 Run：`write` 了 `hello.py` 后，该会话产物列表仍只有 `submit_artifact` 提交的那一个。证据：[`evidence/2026-10-02-clean-rebuild-live-chain.md`](evidence/2026-10-02-clean-rebuild-live-chain.md)（开发栈） |
| E2 | Only `submit_artifact` creates Artifact | `done` | 同上：真实 Run 中 `submit_artifact` 产出产物，账本 sha256 `74a9483f…` 与经 BFF 下载所得字节的 sha256 一致。证据同 E1 |
| E3 | Download tenant/user scoped | `done` | 2026-10-02 真机：同组织另一账号下载同一产物 404、未登录 401、owner 200（[证据](evidence/2026-10-02-clean-rebuild-live-chain.md)）。只验证了跨用户，未构造跨组织；当前部署只有一个组织，跨组织用例按用户 2026-10-02 的范围决定不再验收。 |

## F. A2A

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| F1 | Agent Card reachable | `done` | A2A surface + live gate |
| F2 | Streaming | `done` | SSE 帧编码走 `@a2a-js/sdk` 的 `formatSSEEvent`；协议面经实测评估确认保留自建（[ADR 0010](adr/0010-retain-custom-a2a-server-layer.md) 撤销 ADR 0007 D8，工单 `design/a2a-sdk-server.md` 闭环并设完整性反向棘轮 `agent/tests/a2a/a2a-custom-protocol-integrity.unit.test.ts`）。词汇与完整性棘轮全通过；live gate 待重跑。历史记录：**2026-08-26:** the live gate never checked the terminal frame — `message/stream` / `tasks/resubscribe` ended after `working` with no `status-update(final=true)` because the A2A projector's run-status vocabulary (`run.succeeded`) did not match what the Run services emit (`run.status.changed` / `run.completed`, per plan.md §event vocabulary). Fixed, plus a ratchet that fails when a `run.*` eventType in `src/application` is not projectable: `agent/tests/a2a/a2a-terminal-event-vocabulary.unit.test.js`. 2026-10-02 真机：`message/stream` 以 `status-update completed final=True` 收尾（5 帧），未带凭据 401，吊销后同 token 401。证据: [`evidence/2026-10-02-acceptance-gates-a2-a3-c4-h2-h3-f2.md`](evidence/2026-10-02-acceptance-gates-a2-a3-c4-h2-h3-f2.md)。 |
| F3 | Task query / cancel / resubscribe | `done` | live gate |
| F4 | A2A Task ↔ Run mapping | `done` | task service + repos |
| F5 | A2A SSE disconnect does not cancel Run | `done` | protocol design + gate notes |
| F6 | org/client/trace auditable | `done` | A2A audit append carries **org_id + client_id + trace_id** on send_message / cancel_task / artifact_download via real `A2aAuditRepository` (`a2a-audit-correlation.unit.test.js`). Evidence: `evidence/p1-trace-audit-2026-07-19.md`. |

## G. Reliability

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| G1 | Browser disconnect: Run continues | `done` | SSE relay design; worker ownership |
| G2 | Agent Worker restart recoverable | `done` | **DSH 下真机取证（2026-09-17）**：`scripts/dev/release-gate-dsh-restart.sh`（专用库 + 专用 Redis + 独立 sandbox 与独立数据根，生产 Worker 组合 + 真实 DSH 运行时 + 假模型）5/5——模型调用中 SIGKILL 只重放一次；`ask_user_question` 停泊后 Worker 重启续跑成功；派发边界 SIGKILL 时账本已是 RUNNING 并绑定 `request_hash` 与会话 fence，恢复转人工、无重放、工作区无副作用（含正对照，变异验证成立）；命令执行中重启 sandbox 时工具记 `UNKNOWN/TOOL_OUTCOME_UNKNOWN`、模型收到「可能已生效、重试前先检查」、命令不重跑。同日修复了此前两处偏差（派发时账本停 PROPOSED 未绑定、执行面断连记 FAILED）。分层队列下检查点重放 / 未决副作用 / 深度 1 子 Run 重放 4/4（`scripts/dev/release-gates.sh`）。Evidence: [`evidence/tool-dispatch-boundary-and-outcome-unknown-2026-09-17.md`](evidence/tool-dispatch-boundary-and-outcome-unknown-2026-09-17.md)、[`evidence/dsh-restart-gate-rewrite-2026-09-17.md`](evidence/dsh-restart-gate-rewrite-2026-09-17.md)、[`evidence/worker-restart-gate-layered-and-c7-recheck-2026-09-17.md`](evidence/worker-restart-gate-layered-and-c7-recheck-2026-09-17.md)。Residual non-blocking：审批续跑派发只有离线用例；执行面 SIGKILL / 网络分区未测；多 Worker 副本 2026-09-18 已在本地 OrbStack K8s 演练（同时消费只执行一次、每副本并发上限、SIGKILL 接管、冻结后旧 Worker 不派发、跨副本取消、滚动重启排空，见[证据](evidence/k8s-sim-multi-replica-2026-09-18.md)），目标环境未测；目标环境验收按 design/updrdb-dbpm-deployment.md §12 跟踪。 |
| G3 | Redis blip does not lose fact events | `done` | Outbox + Redis gate evidence |
| G4 | Duplicate request no duplicate side effects | `done` | Offline concurrent begin (same/different hash) + FOR UPDATE. **Live 2026-07-19:** 20-way same-key CreateRun on `pi_gate_20260719_g4g5` → 1 run / 1 message / 1 accepted / 1 outbox / 1 idempotency. Evidence: `evidence/p1-g4-g5-idempotency-2026-07-19.md`. |
| G5 | Create Run then immediate query race-free | `done` | Offline: create txn held open until commit before return + immediate GET. **Live:** every concurrent response immediately GET-able ACCEPTED\|QUEUED. Same evidence doc. |
| G6 | Durable WAITING_INPUT / interaction resume | `done` | **Unit:** interaction HTTP respond/rehydrate, GET `pending_input`, execute-run resume, cancel races (17 pass). **Live:** `agent-worker-pi-restart.release-gate.test.js` case *continues one durable interaction after Worker restart…* PASS on isolated MySQL/Redis/Sandbox (`pi_gate_20260719_g6int`, 2026-07-19): park → SIGKILL Worker A → rehydrateWaiting+respond → Worker B SUCCEEDED / APPLIED / 2 provider calls. Evidence: `evidence/g6-interaction-worker-restart-2026-07-19.md`. |
| G7 | Hard `SIGKILL` orphan recovery in Bubblewrap | `done` | **2026-09-04：先修了根因，再重写了门禁。** 根因是 `MySqlJobRegistry.recoverOrphans()` 自写出来就没有任何调用点——exec 每重启一次，上一轮 `running`/`stopping` 的行就永远留在那个状态（开发栈上实测到 6 条僵尸行，最老的两天前，容器里一个对应进程都没有），而 `countActiveForOwner` 把它们算进每 owner 的并发上限。现在 `exec/src/main.ts` 在 listen 之前 await 回收，失败即拒绝启动。旧门禁 `sandbox-live-gate.mjs`（932 行）是 Python 执行面时代的产物（靠 `grep uvicorn sandbox.main:app` 找 PID、依赖三个已删除的 agent internal transport），已删除，换成照当前接缝写的 `scripts/release-gates/exec-orphan-recovery-gate.mjs`：真实栈上 `docker compose kill -s KILL sandbox` → 重启 → 断言作业收成 `killed`/`orphaned: worker restarted`、全表无 running/stopping 残留，8/8 PASS。Evidence: [`evidence/g7-exec-orphan-recovery-2026-09-04.md`](evidence/g7-exec-orphan-recovery-2026-09-04.md)。 |

## H. Security

| ID | Criterion | Status | Evidence / notes |
|----|-----------|--------|------------------|
| H1 | Cross-tenant blocked | `done` | live isolation gate |
| H2 | Workspace path escape blocked | `done` | 性质已移植且有离线用例（`exec/test/fs-path-policy.test.ts`、`isolation-*`、`search-service.test.ts` 的符号链接越界）；随后在 2026-10-02 真机（绕过词法黑名单后直打 bwrap 层）：`/etc/shadow`、宿主 `/var/sandbox` 与 workspaces、`/proc/1/environ` 中的密钥、指向它们的符号链接全部不可达；`/usr` `/bin` `/lib` 只读；看不到 exec 进程；无网络。公共面 `files/download` 对 `../` 与绝对路径 400。证据: [`evidence/2026-10-02-acceptance-gates-a2-a3-c4-h2-h3-f2.md`](evidence/2026-10-02-acceptance-gates-a2-a3-c4-h2-h3-f2.md)。 |
| H3 | Skill tree not writable (exec side) | `done` | `exec/test/isolation-build.test.ts` 断言 skill 层全为 `ro_bind`；2026-09-30 容器栈真机跑过：系统层按 `systemSkills` 逐包 `ro_bind`（`system: none` 时 `/home/sandbox/skill` 根本不存在）、org 层挂到 `skill-org`，模型在 Run 里 `ls`/`read` 验证同构；随后在 2026-10-02 真机：绑定 2 个系统包时 skill 树只列出这两个，包内创建/追加/删除均 `EROFS`，读取成功（对照）。注意 skill 根目录本身是命名空间内 tmpfs，根上 `mkdir` 能成功但只在当次 Run 内存在、不跨 Run 不跨 owner。证据: [`evidence/2026-10-02-acceptance-gates-a2-a3-c4-h2-h3-f2.md`](evidence/2026-10-02-acceptance-gates-a2-a3-c4-h2-h3-f2.md)。 |
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
| F2 | `partial` | A2A 自建协议面经实测确认保留（ADR 0010 撤销 D8，反向完整性棘轮通过）；live gate 待重跑 |
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
| C7 | `partial` | 2026-09-01 当时已通过 start/list/log/signal/cancel 与跨用户 404；后续进展和剩余缺口以本板 C7 主行及 2026-10-03 新增证据为准 |
| G7 | `done` | 2026-09-04 已执行：见上表 G7 行与 `evidence/g7-exec-orphan-recovery-2026-09-04.md` |

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


## Work merged 2026-10-03（#81–#111）

功能补齐、缺陷修复与全仓清理。没有把任何 `done` 行改回；运行链路证据见 [`evidence/2026-10-03-fixes-cleanup-live-chain.md`](evidence/2026-10-03-fixes-cleanup-live-chain.md) 与 [`evidence/2026-10-03-integration-live-chain.md`](evidence/2026-10-03-integration-live-chain.md)。

| Merged | Change | Rows it touches |
|--------|--------|-----------------|
| #82 | 无活 Worker 时取消 Run，工具账本随终态收尾 | D3, G2 |
| #83 | exec 单实例断言接入启动入口 | — |
| #84 #95 | kill 默认 SIGKILL；signal 语义与终态保护 | C7 |
| #85 | 远端委派接入火山 HiAgent（真实服务未验收） | — |
| #86 #87 | 通知场景扩展；SSO 部门 claim 预留 | — |
| #90–#94 #97 #99 | 清理批次 C1–C6：死代码、重复实现、错误映射与 reason_code 透传、注释漂移 | B3, H1 |
| #96 #98 #100 #101 #104 | 审批原因、进程控制台、前端热点文件拆分 | D5, D6（状态不变） |
| #102 | `AGENT_RUN_STREAM_MAXLEN` 生效 | B6 |
| #103 | 文档与实现漂移修正 | — |
| #105 | 流式工具调用丢失工具名（网关上游空 id / null name） | A2 |
| #106 | 删除旧 Agent 配置与无 sid JWT 的升级路径 | A5, H1 |
| #107 | 删除会话回收沙箱工作区 | C1 |
| #108 | 删除无调用方 BFF 端点与旧配置别名 | — |
| #109–#111 | `type Loose = any` 全仓清零（行为不变） | — |
