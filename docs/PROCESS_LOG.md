# Plan acceptance process log

Append-only log for branch `codex/plan-acceptance`.  
Each entry should say **what changed**, **why**, and **which STATUS IDs** it affects.

---

## 2026-09-02 — Capabilities Drafts 上传 Skill 包、UI 优化与 Settings 二级导航重构

- **Action:**
  1. 支持用户直接在 Capabilities → Skills 的 Drafts 区域上传 `.zip` / `.skill` 归档包，由 BFF 流式透传至 Agent 解包落入当前用户草稿目录（`/home/sandbox/skill-draft/<org>/<user>/<name>`），严格保持未启用（`enabled=false`），以 UI 上的「Enable」作为唯一激活闸门。
  2. 移除 Composer 历史拼图按钮（`#btn-install-skill`），Skill 安装入口完全收敛至 Capabilities 页面。
  3. 侧边栏一级导航收敛为 Chat 与 Schedules；将 Runs（活跃运行）与 Approvals（审批中心）移至 Settings 二级菜单，并在所有 `/settings/*` 页面顶部提供常驻 SettingsSubnav 导航栏（支持 Capabilities / Approvals / Runs / A2A 一键切换），原 `/runs` 与 `/approvals` 保持重定向兼容。
  4. 优化 Capabilities 页面 UI：Drafts 区域新增拖拽/点击上传卡片与反馈、标签页增加数量徽标、卡片排版与状态指示器微调，并使用 Chrome DevTools 完成真机交互与视觉验证。
- **Why:** 落实用户关于 Skill 包直传草稿、安装入口收口、Settings 二级菜单架构与 UI 体验提升的需求，且不破坏现有隔离边界与安全不变量。

---

## 2026-07-22 — MCP startup discovery, Run convergence, and durable UI projections

- **Action:** Added per-Run model/tool/repeated-call budgets; MCP now discovers enabled Servers at Agent startup and exposes named `mcp__{serverId}__{toolName}` tools with readiness fail-closed; durable Run list/detail gains model, token usage, lifecycle timestamps and event cursor; conversation projections retain durable message ordering and the current user turn. Artifact download headers now safely support non-ASCII filenames. Updated deployment, API, architecture, status, and changelog documentation to match these contracts.
- **Why:** A worker Run needs a finite execution boundary, MCP availability must be observable rather than silently empty, and browser refresh must be built from durable identities and event cursors rather than process-local inference.
- **STATUS IDs:** A3 remains `done` with updated startup-discovery evidence; D1 remains `done`; no previously partial or open acceptance item is claimed closed by this change.

## 2026-07-19 — Branch fork and WIP checkpoint

- **Action:** Created branch `codex/plan-acceptance` from `codex/pi-enterprise-refactor` (`8d0dad41`) and committed the full uncommitted working tree as `6d25783c`.
- **Why:** Preserve refactor follow-up work, then accept against `plan.md` with reviewable process commits instead of continuing on a dirty tree.
- **Excluded:** `.env` and local `.runtime/` state (gitignored).
- **STATUS:** No §32 row closed; baseline recorded in `STATUS.md`.

## 2026-07-19 — Documentation authority rebuild

- **Action:** Introduced `docs/README.md` (authority order), `docs/STATUS.md` (§32 gap board), this process log; moved superseded/process docs into `docs/archive/` and gate writeups into `docs/evidence/`; stubbed old `refactor-follow-up.md`; updated root README/CONTRIBUTING navigation.
- **Why:** Previous follow-up tracker was incomplete and drifted from code (e.g. interaction still described as blanket `501`). Acceptance needs one STATUS board mapped to `plan.md` §32.
- **STATUS IDs touched:** documentation only; G6 note corrected to `partial` (code present, evidence incomplete).

## 2026-07-19 — Fix Linux process starttime field index

- **Action:** Corrected `read_linux_starttime` to use kernel `/proc/<pid>/stat` field 22 (index 18 after stripping fields 1–3). Added unit tests. Adjusted hard-kill live gate assertions to track orphan command markers consistently.
- **Why:** Wrong starttime index breaks PID identity matching used for crash/orphan recovery (STATUS **G7**).
- **STATUS IDs:** G7 remains `open` until the hard-kill Bubblewrap gate is re-run with evidence; this is a prerequisite fix only.

## 2026-07-19 — G6 durable interaction refresh projection

- **Action:** GET Run attaches oldest pending interaction as `pending_input` when status is `WAITING_INPUT`; HTTP presentation dual-keys camel/snake. Frontend `rehydrateInProgress` lists without `status=running` filter so WAITING_INPUT/WAITING_APPROVAL survive refresh; `rehydrateRun` projects `pending_input` into Composer state. Added shipped-path tests: interaction HTTP respond + rehydrateWaiting, get-run pending_input, FE rehydration including rehydrateInProgress WAITING_INPUT rediscovery.
- **Why:** Browser refresh must rebuild interaction UI from MySQL facts without relying on SSE alone (plan §32 / STATUS **G6**, also advances **D1** refresh matrix).
- **STATUS IDs:** G6 remains `partial` (in-tree restart-class unit proof present; live worker-restart evidence still required for `done`). D1 notes updated.
- **Note:** Telemetry / OTEL wiring that was mixed into the same working tree was deliberately excluded from this commit so G6 lands without an untracked `telemetry.js` dependency.

## 2026-07-19 — G6 worker-restart interaction gate test

- **Action:** Extended `agent-worker-pi-restart.release-gate.test.js` with a real-Pi path that parks on `ask_user`, SIGKILLs Worker A, rehydrateWaiting + respond, then Worker B continues from the durable answer. Tightened lease TTLs for multi-worker stability; seeds BFF external refs for InteractionResponseService auth.
- **Why:** STATUS **G6** requires restart-class proof beyond unit/fake-knex coverage.
- **STATUS IDs:** G6 remains `partial` until the live gate is actually run with dated evidence (test is committed and gated behind existing live env vars).

## 2026-07-19 — G7 formal orphan recovery (unit + process identity)

- **Action:** Bubblewrap durable Process Handles run as PID-namespace init (`as_pid_1`); capture namespace_pid/start_identity; `recover_formal_orphans` signals namespace init then outer wrapper (TERM→KILL); retain CAP_KILL across setpriv uid-drop (entrypoint/Dockerfile util-linux, compose `cap_add: KILL`); drop service caps before bwrap exec; formal orphan recovery unit tests + identity/namespace helpers.
- **Why:** Hard SIGKILL orphan recovery (STATUS **G7**) needs a verified reclaim identity that survives `setsid()` descendants.
- **STATUS IDs:** G7 remains `open` until live hard-kill Bubblewrap gate is re-run with dated evidence. Unit proof committed.

## 2026-07-19 — H5/H6 secret redaction at MCP seam + B3/D6 tests

- **Action:** Redact untrusted MCP tool results and progress updates before Pi receives them; broaden URI userinfo secret patterns; structural B3 no-authoritative-run-map test; extract frontend approval decision helper with unit coverage and failed-decision UX on ApprovalsPage.
- **Why:** STATUS **H5/H6** require secrets out of model-visible paths and business DB only via MCP; **B3** residual authority audit; **D6** approval UX honesty.
- **STATUS IDs:** H5/H6/B3/D6 remain `partial` with stronger in-tree proof; none claimed `done`.

## 2026-07-19 — G4 idempotency FOR UPDATE + MySQL jsonStrings

- **Action:** IdempotencyRepository reloads under `FOR UPDATE` on CAS/duplicate-PK paths; normalize MySQL DSN with `jsonStrings=true` so JSON string scalars are not eagerly decoded; unit tests assert both. G6 restart describeLive set `concurrency: false`.
- **Why:** STATUS **G4** correctness under concurrent begin; JSON boundary stability for interaction responses stored as JSON.
- **STATUS IDs:** G4 remains `partial` (unit path strengthened; live concurrent-create matrix still open).

## 2026-07-19 — Documentation cleanup

- **Action:** Removed `docs/archive/` (superseded designs, old PLAN/AUDIT/IMPROVEMENT, process notes), deleted stub `docs/refactor-follow-up.md`, and removed pseudo-ADRs `0002-backend2712.md` / `0003-fronted0712.md` (task drafts, not ADRs). Updated active doc links in README, CONTRIBUTING, architecture, ADR 0001, evidence, and review-deferred.
- **Why:** Keep only normative + operational docs; historical drafts were confusing the acceptance surface.
- **STATUS:** Documentation only; no §32 row status change.

## 2026-07-19 — G7 live hard-kill orphan recovery (done)

- **Action:** Ran formal orphan unit suite (19 pass) and live `sandbox-live-gate.mjs` with `SANDBOX_GATE_HARD_KILL=1` + managed non-privileged Bubblewrap container. No production code change required. Wrote `docs/evidence/g7-hard-kill-orphan-2026-07-19.md`.
- **Why:** STATUS **G7** required live proof that durable bwrap orphans are reclaimed after service SIGKILL with honest LOST/UNKNOWN and no auto-replay.
- **STATUS IDs:** G7 → `done`.
- **Subagent:** `019f7991-286c-7ee3-948e-8124c5a29cab` (G7 orphan hard-kill path).

## 2026-07-19 — G6 live durable interaction Worker restart (done)

- **Action:** Ran offline interaction unit suite (17 pass) and live `agent-worker-pi-restart.release-gate.test.js` case *continues one durable interaction after Worker restart…* on isolated MySQL/Redis/Sandbox. Parent re-ran the isolated case PASS. Wrote `docs/evidence/g6-interaction-worker-restart-2026-07-19.md`. Note: `TEST_SANDBOX_MYSQL_URL` must be `mysql://` for this Node gate.
- **Why:** STATUS **G6** required respond → rehydrate → Worker B continuation across SIGKILL, not only unit/fake-knex coverage.
- **STATUS IDs:** G6 → `done`.
- **Subagent:** `019f7991-286d-7c02-acbc-e045b63e6a26` (G6 durable restart evidence).

## 2026-07-19 — A4/G2 restart matrix offline + live (done)

- **Action:** Added `agent/tests/run-services/run-recovery-waiting-input.unit.test.js` (PENDING skip / RESOLVED enqueue / missing reconciliation / CLAIMED re-enqueue). Tightened Pi-restart sandbox UNKNOWN assertion to accept `SHUTDOWN_DRAIN_TIMEOUT` or `CRASH_RECOVERY_UNKNOWN`. Parent re-ran full `agent-worker-pi-restart.release-gate.test.js` live **5/5 PASS** (~76s). Wrote/updated `docs/evidence/a4-g2-restart-matrix-2026-07-19.md`. Dual-runtime structural check (B3) green.
- **Why:** STATUS **A4**/**G2** required consolidated offline matrix plus live multi-case Worker/Session recovery proof.
- **STATUS IDs:** A4 → `done`, G2 → `done`. Residual non-blocking: dedicated graceful SIGTERM drain and corrupt-journal-under-kill live gates.
- **Subagent:** `019f7991-286d-7c02-acbc-e0543771a9f8` (A4/G2 restart matrix audit).

## 2026-07-19 — H5/H6 structural secrets + MCP audit (partial)

- **Action:** Fixed `redactSecretText` replace-callback treating match offset as a capture group (DSN → `8=[REDACTED]`); routed `sanitizeStatusReason` / `sanitizeOutboxError` through shared redaction; expanded `secret-and-mcp-policy` structural tests (sanitizers, MCP-only stack, sandbox 10-tool surface, no extension SQL tools). Offline suite 57 pass. Wrote `docs/evidence/h5-h6-secrets-mcp-audit-2026-07-19.md`.
- **Why:** STATUS **H5/H6** were partial with a real persistence-path redaction gap and weak shared-pattern correctness; strengthen offline proof without claiming production audit `done`.
- **STATUS IDs:** H5/H6 remain `partial`.
- **Subagent:** `019f799e-7935-7b11-a5a6-7c822961a9ab` (P1 H5/H6 secrets MCP audit); commit `e7ae8db8`.

## 2026-07-19 — Acceptance session close-out

- **Action:** Parent integrated G7/G6/A4/G2/H5 slices; four P0 STATUS IDs closed with dated evidence; optional P1 H5/H6 structural audit committed. Gate containers torn down. Session summary under implementer scratch.
- **Why:** plan.md §32 P0 acceptance board for this session.
- **STATUS IDs:** G6, G7, A4, G2 → `done`; H5/H6 remain `partial` with stronger offline proof.
- **Subagents:** G7 `019f7991-286c-7ee3-948e-8124c5a29cab`, G6 `019f7991-286d-7c02-acbc-e045b63e6a26`, A4/G2 `019f7991-286d-7c02-acbc-e0543771a9f8`, H5/H6 `019f799e-7935-7b11-a5a6-7c822961a9ab`.

## 2026-07-19 — P1 D1/D5/D6 FE refresh matrix (done)

- **Action:** Fixed history replay durable sequence + flat platform payload promotion; extended rehydrate/process/approval tests. FE suite 200 pass. Evidence `p1-fe-refresh-matrix-2026-07-19.md`.
- **STATUS IDs:** D1/D5/D6 → `done`. Residual: browser F5 harness absent.
- **Subagent:** `019f79b3-0d3f-7e61-b219-d5d4536f2156`.

## 2026-07-19 — P1 D7/F6 trace + A2A audit (done)

- **Action:** Added `trace-query.unit.test.js` + `a2a-audit-correlation.unit.test.js`; extended FE TracePanel projected-span render. Evidence `p1-trace-audit-2026-07-19.md`.
- **STATUS IDs:** D7/F6 → `done`.
- **Subagent:** `019f79b3-0d44-7931-970c-40d6e2a049ad`.

## 2026-07-19 — P1 G4/G5 live concurrent CreateRun (done)

- **Action:** Strengthened offline concurrent begin + G5 hold-txn tests; live 20-way same-key CreateRun on `pi_gate_20260719_g4g5` PASS. Evidence `p1-g4-g5-idempotency-2026-07-19.md`.
- **STATUS IDs:** G4/G5 → `done`.
- **Subagent:** `019f79b3-0d44-7931-970c-40ea8cca7ed3`.

## 2026-07-19 — P1 H5/H6 offline dual-path redaction (partial)

- **Action:** Expanded shared SECRET_PATTERNS (compound tokens/Cookie/sk-*); Redis log sanitizer routes through redactSecretText; extended units. Evidence `p1-h5-h6-offline-closeout-2026-07-19.md`.
- **STATUS IDs:** H5/H6 remain `partial` (production sampling + deploy allowlist open).
- **Subagent:** `019f79b3-0d44-7931-970c-40f61649bd3b`.

## 2026-07-19 — P1 session close-out

- **Action:** Parent integrated four P1 subagent slices; STATUS board updated; additive evidence files; small commits by STATUS family.
- **STATUS IDs:** D1/D5/D6/D7/F6/G4/G5 → `done`; H5/H6 → `partial` (honest residual).
- **Subagents:** FE `019f79b3-0d3f-7e61-b219-d5d4536f2156`, Trace `019f79b3-0d44-7931-970c-40d6e2a049ad`, G4/G5 `019f79b3-0d44-7931-970c-40ea8cca7ed3`, H5/H6 `019f79b3-0d44-7931-970c-40f61649bd3b`.

## 2026-07-19 — Partial closeout B3 residual Run Map (done)

- **Action:** Expanded `no-authoritative-run-map.unit.test.js` to inventory every residual `new Map(` under `agent/src` with fail-closed whitelist (5 pass). Evidence `partial-b3-run-map-audit-2026-07-19.md`.
- **STATUS IDs:** B3 → `done`.
- **Subagent:** `019f79ce-4719-7dd1-8444-b22af9d390d1`.

## 2026-07-19 — Partial closeout C7 Process Handle (done)

- **Action:** Added `tests/test_formal_process_handle.py` driving real ProcessManager start/status/read/kill + formal dual-write + durable launch flags; offline suite 30 pass. Evidence `partial-c7-process-handle-2026-07-19.md`. Multi-host reclaim remains review-deferred residual.
- **STATUS IDs:** C7 → `done`.
- **Subagent:** `019f79ce-471a-7f41-849d-3c22b0bfffbc`.

## 2026-07-19 — Partial residual H5/H6 ops checklist (partial)

- **Action:** Re-ran H5/H6 suite green; tightened secret-and-mcp-policy enterprise-tool-plane structural test; committed ops sampling + MCP allowlist checklist as `partial-h5-h6-ops-checklist-2026-07-19.md`. No production samples invented.
- **STATUS IDs:** H5/H6 remain `partial`.
- **Subagent:** `019f79ce-471a-7f41-849d-3c380e81c76b`.

## 2026-07-19 — Module layout reorganization

- **Action:** Collapsed agent dual tree into `agent/src/**` (lib, skills, runtime, sandbox-client, model-registry, context-policy); parked approval-waiter under `agent/legacy/`. Moved api-server production modules under `api-server/src/**` with thin `server.js`. Documented sandbox FastAPI hybrid package layout in `docs/module-layout.md`. Added layout structural unit tests.
- **Why:** Package-root parallel trees (agent application/runtime/services/lib vs src; api-server flat routes/application) made ownership unclear and violated conventional single-root layout.
- **STATUS IDs:** documentation / structure only; no §32 row change.
- **Tests:** agent layout + moved-module suites; api-server unit suite (excl. listen-smoke hang); sandbox pytest subset + package imports.

## 2026-07-23 — Code and documentation cleanup

- **Action:** Removed the now-unused Agent approval waiter, unreferenced TypeScript contracts package, and obsolete Sandbox Agent/approval DTOs. Moved the two retained cross-language golden fixtures to `tests/fixtures/contracts/`.
- **Documentation:** Corrected stale source-root paths and SDK persistence/upgrade guidance; removed references to deleted compat fixtures and legacy modules.
- **Tests:** Added a Sandbox model regression check; retained cross-language fixture consumers under their new shared location.

## 2026-08-23 — Documentation pass: drift fixes, AGENTS.md, dead doc removal

- **Action:** Created root `AGENTS.md` (docs authority order, per-file update rules, forbidden actions, pre-commit checklist for AI agents). Updated active docs to match code reality through `0a73cf64`: CHANGELOG gained Fixed entries for #19/#21 (admin bootstrap via `SANDBOX_AUTH_ADMIN_USERNAMES`, process control/cancel/upload error paths, agent `/internal/*` fail-closed auth with `AGENT_ALLOW_UNAUTHENTICATED_INTERNAL` escape hatch, non-root containers, bounded BFF outbound timeouts, sandbox JWT fail-open fix); deployment.md documents the new env vars and the `agent_user_skills` chown caveat; architecture.md security table updated; webui.md reflects the pages/ structure, sub-agent fan-out/task-state rendering and the SVG theme system. Removed `docs/biz-db-mcp/` (external-service design doc, confirmed out of repo scope). Added `docs/reviews/dead-code-2026-08-23/` working papers. STATUS.md header notes the docs pass.
- **Why:** Active docs had drifted behind twelve commits of behavior changes (#13–#21); agents lacked a single binding spec for how docs must be maintained.
- **STATUS IDs touched:** none flipped; H5/H6 remain the only `partial` rows.

## 2026-08-26 — Landing the two 2026-08-26 reviews (full-repo + real-user scenario)

- **Action:** Fixed the A2A streaming terminal-event gap (R1), closed the AGENTS.md §2 outbound-timeout holes on both Sandbox client chains, extended the §3 line-budget ratchet to `frontend/src` and `api-server/src`, and deleted the dead code the specialist review had verified. Archived all three reports to `docs/archive/reviews/` with per-finding resolution notes, and moved the scenario CSV out of `tests/fixtures/` to sit beside the reports that are its only consumers.
- **Root cause found (R1):** the A2A projector's run-status vocabulary (`run.succeeded` / `run.status` / `run.terminal`) matched nothing any service emits. `plan.md`'s event vocabulary and `applyRunTransitionInTxn` both say `run.status.changed` / `run.completed`, so every terminal transition was dropped in projection and the stream returned silently once the Run row went terminal. The existing tests missed it because their fixtures used the same fictional names.
- **Reproduced first:** `agent/tests/a2a/a2a-terminal-event-vocabulary.unit.test.js` failed on the real vocabulary before the fix; the sandbox-timeout tests hung indefinitely against the pre-fix client (which is the defect).
- **STATUS IDs touched:** F2 (`done` retained; evidence corrected to record that the live gate never checked the terminal frame, and to name the fix and the new ratchet).
- **Deferred:** every judgment-call smell, test-only export, shim chain and live-gate item went to `review-deferred-items.md` with evidence, risk and the decision each needs. Nothing `open` in §32 was parked there.
- **Second defect, found only live:** rebuilding the containers and replaying a real Run's journal showed `message.completed` never projected either — production writes it as `{ context, data: { role, message, messageId } }` and the projector only read the flat shape, so the A2A stream carried no agent text. The unit fixtures happened to use the flat shape, which is why the offline suite was green on a broken projector. Both shapes are now read and both are pinned in the regression test.
- **Real chain (AGENTS.md §4):** `docker compose build agent api-server sandbox && docker compose up -d`, then login → session → tool-using Run → file upload/download proxy → managed process status/read/signal/cancel → cross-tenant 404 on four surfaces. `cancel` converged on a genuinely running process (SIGKILL, exit 137), closing the API half of the scenario report's R2; `kill` turned out to be a SIGTERM alias, recorded as deferred rather than renamed. Evidence: `docs/evidence/2026-08-26-review-fixes-live-chain.md`. The A2A HTTP surface itself was not driven — that needs an admin-minted credential.
- **Tests:** `uv run pytest -q` (1137 passed, 6 skipped); `npm test --prefix agent` (1558 passed with `~/.pi/agent/mcp.json` moved aside — the documented ambient-MCP environment trap accounts for the 6 failures when it is present); `npm test --prefix api-server` (143); `npm test --prefix frontend` (319) + `tsc --noEmit` clean.

## 2026-08-31 — DSH 重建文档对账（refactor/dsh-rebuild）

- **Action:** 把活跃文档对齐到当前代码。施工已经走完 Wave 0–7 与 agent 内部整理阶段 0 / A′–G，但交接稿还写着「C–F 未开始」、Wave 3 还标占位、`module-layout` 还画着独立 `agent/runtime/` 包和 `server.js` / `extensions/` / `infrastructure/pi`。本轮只改文档，不改行为。
- **What:** `docs/design/waves/HANDOFF.md` 重写为第四次交接；Wave 进度表把 Wave 3 标成经 Wave 7 补齐；`module-layout.md` / 根 README / `architecture.md` / `development.md` / `api.md` / `deployment.md` 的路径与入口改成 `agent/src/runtime/`、`server.ts`、`exec/`；`STATUS.md` 把 C8/E2/E3 从「还在占位的 `open`」改成 `partial`（实现已补、live 未重跑），并更正 A3：`pi-mcp-adapter` 仍在用。ADR 0007 补记阶段 F 把 runtime 并进主树。`CHANGELOG.md` `[Unreleased]` 补上引擎替换与 Python 执行面删除。
- **Why:** 下一轮按过期交接开工会去跑已经不存在的 `agent/runtime/tsconfig.json`，也会把 Wave 7 已经补上的搜索/产物/数据集重新当缺口。
- **STATUS IDs:** C8 / E2 / E3 `open` → `partial`（不标 `done`）；A1 取证对象改为 `agent/src/runtime/`；A3 备注更正。其余行未翻转。
- **Not done:** Linux Bubblewrap 真机、LLM 网关链路、CI 纳入 exec/contract、`strict`、`pi-` 文件名。

## 2026-08-31 — ADR 0009：host 出厂工具 + application 管家

- **Action:** 新增 `docs/adr/0009-dsh-host-tools-and-application-steward.md`。锁定：不采用 `dsh-web-app`；组合为 dsh-base + overlay；出厂 tool 挂 host 不用 preset；旧 Extension 的模型面用 dsh-base；组合 `dsh-user-approval`（改写 0007 D4）；memory 与模型侧 `skill_install` 本阶段不做；application 改为听 DSH、停泊 Run、对 BFF 负责。
- **Why:** 0007 换了引擎但删 Extension 后没把 base 里的 tool 按 bundle 方式留在循环上；讨论中曾把官方 web 的 preset 误当成加插件的通则。
- **STATUS IDs:** 无行翻转（决策尚未实施）。A2 取证对象将在实施时按 0009 改写。

## 2026-08-31 — ADR 0009 第二版：审批 park+replay、工具名先行、skill 取消变更工具

- **Action:** 重写 `docs/adr/0009-dsh-host-tools-and-application-steward.md`（决策仍未实施）；同步 `docs/adr/0006-user-skill-enablement-gate.md` 的 P1 状态、`docs/README.md` 的 ADR 索引、`docs/design/waves/HANDOFF.md` 的「剩下什么」。
- **What:** D4 新增「工具名是契约面」并列为第 0 步（`risk-table.ts` / `tool-risk-classifier.ts` / `constants.ts` / `tool-risk.json` 四处 fail-closed，外加 AgentVersion 冻结快照里的旧工具名要别名映射）；D5 改成组合 `ctx.approval` seam + 自建 answerer，停泊语义写死为 park + 重建会话重放（上游不支持 out-of-turn 审批），application 侧重放退役；D3 换掉「所有 Run 工具一样」这个错误理由，改用 ADR 0002 实测的「preset 表 process-level 无租户维度」，AgentVersion 差异走 `pre-execute` 过滤；D7 取消 `skill_install/create/edit/uninstall` 与 `source_digest`，改为可写草稿根 + 启用时复制只读副本，`skill-creator` 承担语义；D8 自建 `remote-fs-search`；D9 新增 MCP 一节；每条 D 补「现状差距」。README 的 ADR 索引补回 0002（号已复用），并把「0002 与 0003 都不存在」更正为只有 0003 退役。
- **Why:** 初版有三处会在起栈时直接撞墙：原生审批是没有 answerer 的 seam 且必须在 open turn 内（跨 Worker resolve 不成立）；工具名换了而 fail-closed 名单没换；`source_digest` 与「不给模型 skill 工具」同时写就是死代码。另有两处事实错误（工具面按 AgentVersion 就是不同的；前端并非零改动——todo 卡片按 `todo_write` 的 schema 解析）。
- **STATUS IDs:** 无行翻转（决策仍未实施）。A2 取证对象仍待实施时按 0009 改写。
- **Not done:** 实施本身一步未动；base 出厂工具的真实注册名要等 `npm i` 后从包里抄；MCP 工具怎么进 DSH 注册表未定。

## 2026-08-31 — ADR 0009 按 registry 实物核对（MCP 有出厂包；工具名拿到真名单）

- **Action:** 用 `npm view` / `npm pack` 直接查 `@deepseek-ai/*@0.1.1-rc.2` 的实物，改写 ADR 0009 的 D3 / D4 / D5 / D8 / D9 与「影响」。仍未开始实施。
- **What:** ① **D9 推翻上一版**——`@deepseek-ai/dsh-mcp-client` 存在（"connects to MCP servers and registers their tools on ctx.tools"，依赖官方 `@modelcontextprotocol/sdk`），只是不在 `dsh-base` 里而在 CLI 包 `@deepseek-ai/dsh` 的依赖里；官方就是「一个 server 一个插件实例」写进 `cordis.yml`。改为组合出厂包 + 退役 `pi-mcp-adapter@2.11.0` 与自建发现。② **D4 拿到真名单**：`read/write/edit/read_image`、`glob/grep`、`bash`、`job_list/job_output/job_kill`、`todo_write`、`skill`、`subagent`、`ask_user_question`；`ls`/`find`/`process_*`/`skill_*`/`spawn_subagent`/`ask_user` 全是死条目，出厂 `tool-fs` 没有 `ls`。③ **D3 补两个缺口**：base 只有 `ctx.userQuestions` seam，问人的**工具** `dsh-tool-ask-user` 要另加依赖；MCP 同理。④ **D5 悬念查清**：`dsh-user-approval` 只依赖 schemastery，与 `dsh-permission-presets` 无关，而 base 里的 `permission` id 就是 presets——打开 `approval`、继续关 `permission`。⑤ D8 明确自建搜索必须注册成 `glob` / `grep`。⑥ 影响里更正前端：`todo_write` 名字不变但**结果形状变了**（result 是一句话，清单在 arguments 与 `todo/write` 事件里）。
- **Why:** 上一版的 D9 建立在「DSH 没有 MCP 传输」这句代码注释上，那句只对 `dsh-base` 成立；D4 的名单是推的不是查的，而它是 fail-closed 的第 0 步，推错就是整片工具被拒。
- **STATUS IDs:** 无行翻转。A3（`pi-mcp-adapter` 仍在用）在 D9 落地时可翻转。

## 2026-09-01 — ADR 0009 收口与文档对账

- **Action:** 补齐 Skill 启用的 Agent HTTP / BFF / Capabilities UI、owner-scoped MySQL 账本与 exec 逐包只读挂载；审批停泊时把其它在飞工具从 `RUNNING` 收敛为 `UNKNOWN`；新增 exec/contract CI job。
- **Root cause:** 2026-08-31 真机只直接调用了 `manager.enable()`，没有验证浏览器入口、账本写入和 exec 生产装配；并行工具停泊也只记录了症状。新增回归先在旧代码上复现 404、Promise diagnostics 与永久 `RUNNING`。
- **Docs:** 对齐 ADR 0009、STATUS、HANDOFF、architecture/api/deployment/development/webui、env 示例与 changelog；删除旧 `pi-mcp-adapter` 运行时目录配置。
- **STATUS IDs:** A3 `partial` → `done`（官方 SDK 真 MCP server 的连接/注册/调用测试已存在）；A2 保持 `partial`，唯一剩余原因是 LLMIO 余额导致模型驱动完整链未跑完。
- **Not done:** 实施未动；MCP 工具的**可见性**能否按 agent/session 收窄仍要装好包后确认（执行层过滤不受影响）。

## 2026-09-01 — exec 迁移后的浏览器认证断链收口

- **Reproduced first:** 重建四个运行镜像后，`GET /api/auth/me` 返回 404；BFF 仍请求 exec `/auth/me`，而 TypeScript exec 从未实现 `/auth/*`。`auth_credentials` 迁移已在 Agent schema，说明这是 Python Sandbox 删除时漏迁的权威边界，不是环境配置。
- **Action:** 将 register/login/me 迁到 Agent `/internal/auth/*`，复用 Agent Knex 与 Node crypto；BFF 保留 HttpOnly Cookie 适配，删除 BFF/Agent sandbox-client 的死 `/auth/*` 调用。生产 JWT 密钥加入 Agent fail-closed 校验，compose 只把认证变量交给 Agent。
- **Gate repair:** `scripts/smoke-cross-service.mjs` 同样仍启动已删除的 Python `sandbox.main` 和不存在的 Agent JS 源入口；改为 exec/Agent `dist` 入口，CI 显式安装并构建 contract/exec/agent 后再运行。
- **Docs correction:** 上一条同日记录末尾的“实施未动”是旧交接文字，与该条 Action 自相矛盾；实际 ADR 0009 实施和 Skill 收口已经完成，以本条及 STATUS 为准。PROCESS_LOG 按 append-only 规则不改写旧条目。
- **STATUS IDs:** 暂不翻转；A2 仍须由本轮真实模型链最终结果决定。

## 2026-09-01 — DSH 多轮与 exec 长进程真机收口

- **Reproduced first:** 同一会话后续 Run 分别暴露 journal header conflict / multi-root；后台 `bash` 返回 Agent 本地假 id 而 `exec_jobs` 为空；真实 MySQL 对 prepared `LIMIT ?` 报 `Incorrect arguments to mysqld_stmt_execute`；BFF 又把 Sandbox Session id 直接当成 exec Workspace id，导致进程列表为空。
- **Root cause / action:** runtime 重建保留恢复 header，checkpoint manifest 改接 journal leaf；增加 `exec_jobs` migration；DSH `RemoteJobs.start` 预留 id 并用 AsyncLocalStorage 传给 `RemoteShell.start`，exec `/shell/start` 统一经 registry 启动；分页 LIMIT 在共享 `sqlLimit` 校验后插入；BFF 经 Agent session authorization 取得 Workspace id 后访问 exec。Agent 旧进程查询/控制生产路径删除。
- **Live:** 重建 `agent` / `api-server` / `sandbox` / `sandbox-mcp` 后均 healthy。用户 A 在同一 Conversation/Session 完成连续模型 Run；最终后台 `sleep 120` 的 ToolExecution、`exec_jobs` 与 `/api/processes` id/run 绑定一致，logs 200，SIGTERM 后 `stopping` → `cancelled`；用户 B 查询同一 session/run 为 404。
- **Evidence:** [`evidence/2026-09-01-dsh-process-closure-live-chain.md`](evidence/2026-09-01-dsh-process-closure-live-chain.md)。
- **STATUS IDs:** A2 `partial` → `done`；A4 `unknown` → `partial`；C7 `unknown` → `partial`；G7 保持 `unknown`。
- **Tests:** pytest 98；exec 312 pass + 1 skip；contract 29；agent 1174；BFF 144；frontend 323；exec/contract/agent/frontend typecheck、cross-service smoke 语法检查、compose config 与 diff check 均通过。
- **Not closed:** 原生 DSH persistence backend 尚未挂载/resume；模型侧同步 `job_list`/`job_output` 未接异步 exec 结果；日志/活句柄不能跨 exec 重启恢复；hard-SIGKILL orphan gate 未跑。

## 2026-09-01 — A4 原生 DSH session persistence 接线

- **Reproduced first:** `createSessionBackend()` 每轮都建了 backend，却被 `void sessionStore` 丢掉；根 ctx 没有 `sessionPersistence`；每次 Run 都走 `ctx.agents.create()`，从不 `resume()`；`dsh_sessions` / `dsh_session_events` migration 也不存在。
- **Action:** 复用上游 `SessionPersistence` + `PersistenceCoordinator`，只补 owner-scoped MySQL `PersistenceBackend` 与 create/resume 选择。进程内一次 `mountSessionPersistence`；已物化会话 `has(sessionId)` 为真时走 `agents.resume`。
- **Tests:** `mysql-session-store` seam（create/append/prepare）、factory resume 选择、migration 常量、`mountSessionPersistence` 幂等与缺 `ctx.sessions` fail-closed。
- **STATUS IDs:** A4 保持 `partial`。接线与离线证明已补；compose 上原生 resume 与 Worker 重启上下文 gate 仍未取证。
- **Not closed:** 真机 `agents.resume`；Worker 重启后模型上下文；C7 的同步 job 查询与跨 exec 重启；G7 hard-SIGKILL。

## 2026-09-01 — A4 原生 DSH session resume 真机

- **Reproduced first:** compose Agent 只有 `AGENT_DATABASE_URL`，`requireMysql` 却读 `MYSQL_HOST`，第一轮 Run 立刻失败。补 URL 解析后第二轮确实走 `resume`，但 mysql2 已解析的 JSON 列被再次 `JSON.parse`，报 `"[object Object]" is not valid JSON`。
- **Action:** `readMysqlSessionStoreConfig` 解析 `AGENT_DATABASE_URL`；pool 打开 `jsonStrings`/`dateStrings`，`loadStored` 兼容已解析对象。
- **Live:** 同一 `agent_session_id` 上 Run 1 `create` + `SUCCEEDED`（24 行事件），follow-up Run 2 `resume` + `SUCCEEDED`（43 行，含 `session/end-seed` 与两套 turn）。
- **Evidence:** [`evidence/2026-09-01-dsh-native-session-resume.md`](evidence/2026-09-01-dsh-native-session-resume.md)。
- **STATUS IDs:** A4 保持 `partial`。原生 resume 已取证；Worker 重启上下文 gate 未跑。
- **Not closed:** Worker 重启后模型上下文；C7 同步 job 查询与跨 exec 重启；G7 hard-SIGKILL。

## 2026-09-01 — A4 Worker 重启后模型上下文真机

- **Reproduced first:** 终态 Run 之后 `docker compose kill -s SIGKILL agent-worker`，容器停在 `exited`，本机 `unless-stopped` 未自动拉起；`up -d` 后新 PID 接手。
- **Live:** 同一 `agent_session_id` 上 Run 1 `create`/`SUCCEEDED`（口令 `OXBIRD-B7D12629`，助手可见文本 `OK`）；Worker PID 更换后 follow-up `resume`/`SUCCEEDED`，助手可见文本原样复述该口令。`dsh_session_events` 38 → 58，含 `session/end-seed`。
- **Evidence:** [`evidence/2026-09-01-dsh-worker-restart-model-context.md`](evidence/2026-09-01-dsh-worker-restart-model-context.md)。
- **STATUS IDs:** A4 `partial` → `done`。G2 保持 `unknown`（未测运行中 SIGKILL）。
- **Not closed:** G2 中途回收；C7 同步 job 查询与跨 exec 重启；G7 hard-SIGKILL。

## 2026-09-02 — ADR 0007 D8 判定：撤销，保留自建 A2A 协议面

- **Reproduced first:** 先证明 D8 从未执行。`git show --stat --diff-filter=D 2a1462fa | grep -i a2a` 输出为空——该 commit 的 message 声称「A2A drops the 12 hand-written protocol files」，但对 `agent/src/{application,presentation}/a2a` 只有 9 个文件 +48/-17，零删除。`2a1462fa^` 的 12 个模块今天全在（转成 `.ts`），另加第 13 个 `sdk-adapter.ts`（23 行，只调 `formatSSEEvent`）。`@a2a-js/sdk/server` 全仓零 import。W6-B 的 ✅ 是照 commit message 打的。
- **Action:** 按工单 [`design/a2a-sdk-server.md`](design/a2a-sdk-server.md) §10 走退出路径而不是硬做迁移。判定依据（均在 `agent/node_modules/@a2a-js/sdk/dist/` 核实）：`DefaultRequestHandler.resubscribe` 遇终态任务直接抛 `UnsupportedOperationError`（`dist/server/index.js:3109`）；无活跃事件总线时只 `yield` 一个快照即 `return`；`ExecutionEventBusManager` 三个方法全同步（`dist/server/index.d.ts:142-146`），无处注入 `afterSequence`/`Last-Event-ID`；v1 JSON-RPC 只认 PascalCase，`compat/v0_3` 只认 slash，本仓库双轨别名两边都落不下。立 [ADR 0010](adr/0010-retain-custom-a2a-server-layer.md) 撤销 D8，并加反向完整性棘轮 `agent/tests/a2a/a2a-custom-protocol-integrity.unit.test.ts`（含一条真调 SDK 的 spike，不只是文件存在性断言）。
- **STATUS IDs:** F2 保持 `partial`——缺口是 live gate 未重跑，与协议面由谁实现无关，本次只改 Evidence 文字。F1/F3–F6 维持。`review-deferred-items.md` 的 "ADR 0007 D8 未执行" 行改为 Closed。
- **Tests:** pytest 98；agent 1211 pass / 0 fail（含新增 5 条）；`agent/tests/a2a/` 15 个文件 125 用例全绿；`npm --prefix agent run typecheck` 干净。纯文档 + 一个新测试文件，未触及运行路径，未重建容器。
- **Not closed:** F2 的 live gate 仍未重跑。`design/waves/README.md` 的 W6-B 保持 ⚠️：那一格记录的是"当时声称做了而没做"，不因为后来决定不做而变成 ✅。

## 2026-09-03 — TypeScript 迁移与 DSH 命名收口真机验证

- **Reproduced first:**
  1. `api-server` 移开 `dist/` 后执行 `npm run smoke --prefix api-server`，因缺失前置构建且回退到已删除的 `server.js`，复现 `ECONNREFUSED` 崩溃。
  2. `DshRunExecutor` 构造函数接收 `{ ...deps, sessionLockManager: {} }`（空对象无 `acquire` 方法），未抛出预期 TypeError，复现运行时校验弱化。
  3. `import('./agent/dist/src/application/pi-run-executor.js')` 复现 `ERR_MODULE_NOT_FOUND`，证明深层导入兼容性失效。
- **Action:**
  1. `api-server/package.json` 的 `smoke` 脚本前置追加 `npm run build &&`，`tests/listen-smoke.test.js` 直接检查并拉起 `dist/server.js`。
  2. `agent/src/application/dsh-run-executor.ts` 恢复严格的前置 `!deps.sessionLockManager?.acquire` 检查，并补充单测断言。
  3. 按照用户决策不做兼容，彻底移除 `PiRunExecutor`、`createPiRunExecutorFactory`、`PiRunExecutorDeps` 等全部 `Pi*` 历史遗留别名与死导入，全仓统一收口为 `Dsh*` 命名。
  4. 同步修正 `docs/development.md`、`docs/module-layout.md`、`README.md`、`docs/CONTRIBUTING.md`、`docs/runbooks/sdk-upgrade.md`、`docs/adr/0007-agent-runtime-rebuild-on-dsh.md` 及 `docs/CHANGELOG.md` 中过时文件名与测试命令。
  5. 重建 `agent`、`api-server`、`sandbox`、`sandbox-mcp` 四个服务镜像，拉起 Docker compose 栈并执行完整真实链路验证（登录 → 会话 → 工具 Run → 后台进程与 SIGTERM → 跨租户 404 隔离）。
- **Live:** 四个镜像重建并进入 `healthy`；用户 A 注册并验证 `/api/auth/me`；创建 Conversation；提交带 `bash pwd` 的 Run，实时收集 87 个 SSE 事件帧并在沙箱内成功执行输出 `/home/sandbox/workspace`，Run 终态 `SUCCEEDED`；启动后台 `sleep 60` 并在 `/api/processes` 查得进程，成功读取 logs 并发送 `SIGTERM` 成功；用户 B 请求用户 A 的 Run / Conversation / Processes 均严格返回 404。
- **Evidence:** [`evidence/2026-09-03-ts-migration-and-dsh-cleanup-live-chain.md`](evidence/2026-09-03-ts-migration-and-dsh-cleanup-live-chain.md)。
- **Tests:** 全量 6 套单测与类型检查全部通过：
  - `uv run pytest -q`：98 passed
  - `exec`：323 passed, 1 skipped, 0 fail; typecheck clean
  - `contract`：29 passed; typecheck clean
  - `agent`：1210 passed; typecheck (tsc + tsc.runtime) clean
  - `api-server`：146 passed; typecheck clean; smoke clean
  - `frontend`：334 passed; typecheck clean

## 2026-09-04 — 一个 org 多个可选智能体（P0/P1），以及 AgentVersion.systemPrompt 的消费缺口

两个 commit：`057a4622`（P0+P1 实现）与 `410e9137`（前者上线后才可观测到的运行时缺口）。

- **Reproduced first:**
  1. P0/P1 的六条回归项按 `design/multi-agent-selection.md` §11 先写后修，
     `agent/tests/run-services/agent-catalog-service.unit.test.js` 在实现前全红
     （含用两个真实 org 验证跨租户 404）。
  2. 顺带复现出一个**已存在**的缺陷：不带 `agent_id` 的 follow-up 会先解析成租户默认
     Agent、再与会话已绑定的 Agent 比对，抛 `Conversation is bound to a different agent`
     ——绑在非默认 Agent 上的会话（A2A 建的早就如此）下一轮就跑不起来。
  3. `410e9137` 由一条真实 trace（`55e02176046cd296503915dc42ad27ac`）暴露：会话绑定的
     Agent 与 `runs.agent_version_id` 都是对的，但该版本 `config_json` 里的 `systemPrompt`
     在发给模型的 system prompt 里一个字也没有。回归测试
     「hands the AgentVersion systemPrompt to the runtime factory」先失败后通过。
- **Action:**
  1. `agent/`：新增 `application/agent-catalog-service.ts`（建 Agent = definition + v1 +
     活跃指针单事务；建版本；切活跃版本；列目录与版本线）与
     `presentation/http/agents-routes.ts`（`/internal/agents` 五条路由，
     `create-http-server.ts` 只加一次委派）。角色闸门与归属判定放在服务层而不是 handler。
     新增 `AdminRoleRequiredError` → 403，`agent_definitions` / `agent_versions` 进 404 名词表。
     `conversation-service` 的 create / ensureSession 与 `/internal/agent-runs` 接收 `agent_id`。
  2. `api-server/`：`routes/agents.ts` + `services/agent-catalog-client.ts`（单开 client 文件是
     因为 `agent-client.ts` 会顶破 1000 行结构棘轮）；只转发，不做目录状态判断。
  3. `frontend/`：`AgentPicker`（仅新会话且 org 多于一个 Agent 时渲染）、会话头部只读 Agent chip、
     `settings/AgentsPage.tsx`（admin）。`ChatContext.tsx` 行数预算钉死，按职责把模型选择抽成
     `useModelSelection.ts`，Agent 选择作为同级 hook 加入（1443/1456）。
  4. `410e9137`：`DshRunExecutor` 在加载 AgentVersion 后经 `bindAgentVersionConfig()` 取
     `systemPrompt` 传给运行时工厂（工厂读的是 `input.systemPrompt`，此前无人接线，
     `assembleSystemPrompt(undefined)` 只返回企业条款）。不直接读 `configJson`——那里是唯一
     定义「这份 config 怎么读」的地方。企业条款位置不变，租户自定义段在前、条款追加在后，
     覆盖不掉。缺口不是本次多 Agent 改动引入的：换引擎起就在，此前 org 只有一个 Agent、
     `systemPrompt` 一直是空串，没有可观测后果。
- **Live:** 按 AGENTS.md §4 重建 `agent` / `api-server` / `sandbox` / `sandbox-mcp` 四个镜像后跑
  真实链路，**18 条断言全过**：登录 → 建 Agent（admin）→ 建会话并指定该 Agent → 一轮带工具的
  run（`SUCCEEDED`，1 个工具）→ 后台进程 logs/signal → 未知 `agent_id` 一律 404 且响应体不回显
  该 id → 切版本后老会话仍用 v1、新会话用 v2 → 非法 config 400 → 非 admin 写目录 403。
  `410e9137` 另行重建 `agent` 镜像后跑了 6 条断言：直接查 `dsh_session_events` 的 request/header，
  确认自定义提示词进入 system（1/1）、企业条款仍在场（1/1）、自定义段排在条款之前
  （custom@56 < clauses@76）、`systemPrompt` 为空的 Agent 行为不变（0 命中）。
- **Evidence:** [`evidence/multi-agent-selection-p0-p1-2026-09-04.md`](evidence/multi-agent-selection-p0-p1-2026-09-04.md)。
  `410e9137` 的真机验证**没有单独的证据文件**，细节只在该 commit message 里。
- **Tests:** `057a4622` 时点六套全绿：pytest 98 / exec 326 / contract 29 / agent 1224 /
  api-server 154 / frontend 350，全部类型检查（含 `src/runtime` strict）干净。
  `410e9137` 时点：agent 1233 / pytest 98，typecheck 干净。
  行数棘轮：`create-http-server.ts` 1272/1399，`ChatContext.tsx` 1443/1456，
  `dsh-run-executor.ts` 1523/1526（为此把新增注释压到 4 行，**没有抬预算**）。
- **Docs:** `docs/api.md` 新增 `/internal/agents` 与 `/api/agents` 条目，并补一张「config 里哪些
  字段真的生效」的逐字段表——`systemPrompt` / `modelPolicy`（含 `maxOutputTokens`）/ `toolPolicy`
  生效；`temperature`、`thinkingLevel`、`skills`、`mcpServers`、`extensions`、`sandboxPolicy`、
  `a2a`、`contextPolicy` 不生效，各自注明原因。此前没有任何地方说明这件事。
  `docs/webui.md` 随 P1 的 UI 结构变化更新；`docs/CHANGELOG.md` `[Unreleased]` 已记；
  `design/multi-agent-selection.md` §13 记录实施状态、与原计划的五处偏差，以及 §0
  「运行时消费面已经建好了」这句前提是错的。
- **STATUS IDs:** 无 §32 行状态改变，`STATUS.md` 未动。A5（Agent Version pinned）维持 `done`
  ——版本钉本来就是对的，`410e9137` 修的是「钉对了但内容没被消费」，不属于 A5 的断言范围；
  D8 维持 `done`，`A2aPage` 的 agents 本就来自同一张 `agent_definitions`，不存在两套列表。
- **Not closed:**
  - 设计文档 P2 三项：SSO 的 org claim 替代 `BOOTSTRAP_ORG_ID`（claim 缺失须拒签，不回落默认
    org）、Run 详情 / TracePanel 展示本次 Run 绑定的 Agent 名与 `version_no`、复核
    `BFF_DEV_ACTING_ORGANIZATION_ID` 在生产镜像中够不到。均依赖尚不存在的 IdP 接入。
  - **真正的跨 org 隔离未在浏览器面复现**：所有浏览器用户目前共用 `BOOTSTRAP_ORG_ID`，
    真实链路第 11/12 条用的是本 org 不存在的 `agent_id`，与「属于别的 org」走同一分支。
    跨 org 分支判定目前只由单测用两个真实 org 覆盖，P2 接上 SSO 后应在真实栈上补。
  - 版本不漂移那几条（第 7/14/15 断言）是直接查 `runs.agent_version_id` 账本，不是读 API
    ——Run 详情还没把绑定的 Agent 名与 `version_no` 投影出来，即 P2 第 2 项。
  - `sandboxPolicy` 明确不做：它从 ADR 0002 起就没有执行路径，沙箱模式 / 网络模式 / 可写根
    都由 exec 的部署级配置决定，不按 Agent 分。要接需要定义 schema、扩 contract 的 shell RPC、
    改 exec 的 isolation/build——那是在动 AGENTS.md §2 的容器隔离不变量，应当单开一件事并起
    新 ADR（下一个可用编号 **0011**）。

## 2026-09-04（下午）— exec 产物持久化 + 四项稳健性修复

- **Context:** 对全仓做了一次外部 review，逐条复核（不是照单全收——其中若干条的定性、
  归因或严重性需要修正）。本次落地其中五条。
- **Action（按严重性）:**
  1. **P0，用户可见的数据丢失**：`exec/src/db/repositories/{artifacts,datasets}.ts` 的
     `MySql*Store` 与 DDL 常量早就写好，但**既没有迁移，也没有在 `createExecAppFromEnv`
     里接上**，`ArtifactService`/`DatasetService` 一直跑在构造函数默认的内存实现上。
     六套单测全绿，容器一重启 `GET /api/artifacts` 就返回空列表、下载全部 404。
     新增迁移 `20260904000001_exec_artifacts_datasets.js`，两个 Store 与 `MySqlJobStore`
     共用同一个池与同一次 fail-closed 判定。
  2. `MySqlJobRegistry.lives` 只增不减——结算路径的 `finally` 里只有一句"活句柄用完即丢"
     的注释，实际什么都没丢。改为打结算时间戳 + `pruneSettled()`（5 分钟保留窗口 +
     512 条硬上限），运行中的作业永不回收。
  3. `RemoteShellProcess.monitor` 固定 200ms 轮询且把一切错误当抖动：`WORKSPACE_NOT_FOUND`
     现在立刻结算，其余错误指数退避（200ms→2s）并有 60s 失败截止。
  4. `ExecRpcClient.getStream` 的超时定时器在拿到响应头时就被清掉，之后逐 chunk 读流
     没有任何截止。新增每块的空闲超时。
  5. exec 公共会话面从不校验 `SANDBOX_API_TOKEN`（compose / `.env.example` / `deployment.md`
     三处都要求它，BFF 与 agent 也一直在发 `X-API-Key`）。现在常量时间比较，不匹配 401；
     `ExecAppDeps.publicApiToken` 是必填字段，`createExecAppFromEnv` 缺它拒绝启动。
- **Verification:** 六套单测 + 五处类型检查全绿；重建四个镜像后在 compose 上跑真实链路
  15/15 PASS，含**重启 sandbox 容器后产物列表与下载字节仍在**这条 P0 断言。
  证据：`docs/evidence/exec-durable-artifacts-and-hardening-2026-09-04.md`。
- **STATUS IDs:** 没有关闭任何 §32 行。G7 那行补了一句复现结论：
  `scripts/release-gates/sandbox-live-gate.mjs` import 的三个模块在 DSH 重建里已删除，
  脚本 `ERR_MODULE_NOT_FOUND`，要按 `runtime/providers/exec-rpc` 的新接缝重写才能重跑。
- **Not closed（本次刻意没做）:**
  - `exec_workspaces` / `exec_executions` / `session_events` / `workspace_quota_reservations`
    四张表同样只有 DDL、没有迁移，但它们**没有任何运行时消费者**——接它们是新功能，
    不是修 bug。新增的 `tests/test_exec_schema_migrations.py` 只要求"已接线的表必须有迁移"，
    这四张一旦被接进 `createExecAppFromEnv` 就会立刻要求补迁移。
  - 产物/数据集的配额账本仍是 `InMemoryQuotaStore`（`MySqlQuotaStore` 存在但没接、没迁移）：
    重启会让配额计数归零，是"多放行"而不是"丢数据"，与本次的 P0 不同级别，另开一件事。
  - `agent/src/infrastructure/sandbox/internal-hmac.ts`（980 行）与 `contract/src/hmac.ts`
    （816 行）是两套都活着的实现，`internal-session-http.ts` 与
    `internal-artifact-download-http.ts` 仍在用前者。收口要迁调用方 + 迁 fixture 单测，
    风险不小，单开一件事。
  - `agent/src/runtime/providers/memory.ts` 对应的工具已按 ADR 0009 D10 退役
    （`tool-names.ts` 给 `TOOL_RETIRED`），实现与导出仍在，属于可删的死代码。
  - 契约层 `htm` 仍硬编码 `'POST'`，exec 侧靠 `!(expectedHtm === 'POST' && method === 'GET')`
    这条例外放行 `GET /internal/v1/fs/stream-text`；同一处还有一个空 if 块与三行自相矛盾的注释。
  - `ExecRpcClient.issueToken` 对所有 RPC 写死 `tool_name: 'fs'` / `scope: ['internal:fs']`。
    今天 exec 侧**根本不校验 scope**，所以这枚 claim 是装饰性的——补 scope 校验时会一次性
    发现所有调用方都在冒充 `fs`。
  - `exec/src/http/router.ts` 的 `getClientIp` 盲信 `X-Forwarded-For` 且兜底 `127.0.0.1`；
    CIDR 只是 HMAC 之前的一道纵深，且 sandbox 在 compose 里不发布端口，故未在本批处理。

## 2026-09-04（续）— 内部 HMAC 实现收口到 `@pi/contract`

- **Context:** 上一条 Not closed 的第三项。`agent/src/infrastructure/sandbox/internal-hmac.ts`
  （980 行）与 `contract/src/hmac.ts`（816 行）是两套都活着的实现，两个生产模块用前者。
- **Action:** 先证明两份**不等价**再收口，没有靠放宽来"统一"。把 agent 那套 599 行严格性
  套件原样指向 contract：21 条里 2 条失败——contract 会放行 (a) keyring 值是 getter
  的 accessor 属性，(b) `scope` 数组挂了额外自有属性。两条都补进 contract 后 21/21。
  随后两个生产模块改指 `@pi/contract/hmac.js`；`normalizeBaseUrl`（与签名无关，管的是
  baseUrl 能不能用）抽到新的 `transport-base-url.ts` 并自带
  `SandboxTransportConfigError`（原先借用 `InternalHmacError` 携带一个不在其码枚举里的
  code）；删除 agent 那份 980 行；严格性套件随实现移到 `contract/test/hmac-strict.test.ts`。
- **Verification:** 六套单测 + 五处类型检查全绿（contract 29→50，agent 1240→1219，
  数目变化正是套件迁移）。重建四个镜像后真实链路 15/15 PASS，其中 sandbox 侧记录到两次
  `POST /internal/v1/sessions/ensure 200`——contract 实现签发的令牌被 exec 验证器接受。
  另在生产镜像内直接构造 artifact-download transport，确认新补的 getter-keyring 拒绝
  在镜像里生效。证据：`docs/evidence/internal-hmac-consolidation-2026-09-04.md`。
- **STATUS IDs:** 无 §32 行状态改变。
- **Not closed:** `exec-rpc.ts` 里还有一个同名但只做去尾斜杠的私有 `normalizeBaseUrl`，
  与本次抽出的策略函数不是重复实现（它的 baseUrl 来自进程环境而非用户输入），
  故意没有合并；要不要收到同一条策略下是单独一件事。
  上一条列出的其余 Not closed 项（G7 门禁重写、配额落库、`memory.ts` 死代码、
  `htm` 硬编码、`issueToken` 写死 scope、`getClientIp` 信 XFF）仍然未做。

## 2026-09-04（续二）— G7：先修根因，再重写门禁

- **Context:** 上一条 Not closed 的第一项是「重写 G7 门禁」。动手前先看门禁到底
  想断言什么，结果发现被断言的那件事**根本没实现**。
- **Action:**
  1. **根因**：`MySqlJobRegistry.recoverOrphans()` 自写出来就没有任何调用点
     （`exec/src/main.ts` 里没有，只有一条单测在调）。开发栈上直接查到 6 条
     `running`/`stopping` 僵尸行、最老的两天前，而容器里一个对应进程都没有。
     `countActiveForOwner` 统计的正是这两个状态，是每 owner 并发上限的依据——
     僵尸行攒够 20 条该 owner 就再也起不了作业，随重启次数单调恶化。
     修复：`main.ts` 在 `listenHono()` 之前 `await runtime.recoverOrphans()`，
     失败即 `process.exit(1)`。顺序是硬要求（回收扫描无租户过滤，不能和用户请求并发）。
  2. **旧门禁不是「修一修」**：`sandbox-live-gate.mjs`（932 行）除了 import 三个
     已删除的 agent transport，整个 harness 针对的是 Python 执行面
     （`grep uvicorn sandbox.main:app` 找 PID、`SANDBOX_GATE_RSS_ARG=sandbox.main:app`、
     旧 `/internal/v1/*` 的 claim 模型）。已删除，换成
     `scripts/release-gates/exec-orphan-recovery-gate.mjs`（照当前接缝写，约 170 行）。
- **Verification:** 重建 sandbox/sandbox-mcp 后第一次启动即打印
  `exec recovered 6 orphaned job(s) at startup`，僵尸行清零。新门禁在真实栈上
  8/8 PASS（`docker compose kill -s KILL sandbox` → 重启 → 作业收成
  `killed` / `orphaned: worker restarted`、全表无残留）。六套单测 + 五处类型检查全绿。
  新增两条 pytest 守卫（`tests/test_exec_startup_orphan_recovery.py`）：入口必须在
  listen 之前 await 回收、回收失败必须 fail-closed；把 `main.ts` 退回旧样子两条都失败。
  证据：`docs/evidence/g7-exec-orphan-recovery-2026-09-04.md`。
- **STATUS IDs:** **G7 由 `unknown` 改为 `done`**（上表与 2026-09-01 重审增量表两处同时改，
  看板内部不留矛盾）。
- **Not closed:** 门禁只查账本、不查残留进程，因为当前拓扑下「容器还活着但 bwrap 子进程
  成了孤儿」不成立——exec 是 `init: true` 下 docker-init 唯一监管的子进程，实测
  `kill -9` 它容器立刻 restarting。这一条写进了新门禁的文件头注释。
  旧门禁里另外三块断言（20 并发执行、5 GiB 流式 Dataset 的有界 RSS、跨租户内部面隔离）
  **没有**随之重写——它们对应的是 C4/C6/H2 等其它行，不在 G7 范围内，应各自单开一件事。

## 2026-09-04（续三）— 配额落库、内部面收紧、死代码清理

一次把上两条 Not closed 里剩下的可控项做完。

- **配额落库**：`workspace_quota_reservations` 只有 DDL 没有迁移，
  `ArtifactService` / `DatasetService` 各自默认装配一个 `InMemoryQuotaStore`——
  既重启即忘，又**互相看不见**（同一个工作区的产物与数据集各算各的，1024MB
  能被用掉两份）。新增迁移 `20260904000002_workspace_quota_reservations`，
  生产装配用 `MySqlQuotaStore`，两个服务共用一个 `WorkspaceQuotaLedger`。
  `tests/test_exec_schema_migrations.py` 的 ratchet 自动把它纳入了覆盖。
- **内部面 htm/scope/tool_name 逐字绑定**：contract 的 `htm` 放开到 `'POST' | 'GET'`
  （**不是放松**——正因为钉死 POST，exec 侧才不得不写「POST 令牌打 GET 端点也放行」
  的例外），exec 侧改为逐字相等并删掉那条例外；新增 `internalBindingForHtu()`
  作为两侧共用的 scope/tool_name 绑定表，未登记路径一律拒。
- **对端 IP 不再采信 `X-Forwarded-For`**：监听器把 socket 的 `remoteAddress` 注入成
  `x-exec-peer-ip`（同名头先剥后写），`getClientIp` 只认它；取不到返回空串而不是
  兜底 `127.0.0.1`。新增 `EXEC_INTERNAL_ALLOW_CIDR` / `EXEC_HTTP_LOG` 两个变量的
  文档（`.env.example` 与 `deployment.md` 双侧）。
- **请求行日志**：两行裸 `process.stdout.write` 改成一个默认关闭、由 `EXEC_HTTP_LOG=1`
  打开的 JSON 单行。
- **删除 `runtime/providers/memory.ts`**（+ 单测 + `runtime/index.ts` 的导出）：
  ADR 0009 D10 早把这两个工具标成 `TOOL_RETIRED`。Map 白名单 27 → 26。
- **中途自己引入又抓住的一个 bug**：给 `issueToken` 加 method 参数时，`post()` 与
  `getStream()` 两处调用签反了——POST 请求带着 `htm: 'GET'` 的令牌，真实链路上
  exec 全线 401。单测没抓住是因为假 fetch 不校验 HMAC。补了
  `remote-providers.test.ts` 里一条**解开令牌**比对 htm/htu/scope/tool_name 与真实
  请求的用例；把两处再签反一次，这条立刻失败。
- **Verification:** 六套单测 + 五处类型检查全绿。重建后真实链路 15/15 PASS，
  G7 门禁 8/8 PASS。配额落库另做了一次针对性验证：往
  `workspace_quota_reservations` 直接插一条 1GiB 的预留，随后的 `artifacts/submit`
  被拒并回显 `reserved 1073741824`——证明 exec 读的是 MySQL 而不是进程内的 Map。
- **STATUS IDs:** 无 §32 行状态改变。
- **Not closed:**
  - `exec_workspaces` / `exec_executions` / `session_events` 三张表仍然只有 DDL、
    没有消费者；接它们是新功能。
  - 旧 G7 门禁里的另外三块断言（20 并发执行、5 GiB 流式 Dataset 的有界 RSS、
    跨租户内部面隔离）没有重写，对应 C4/C6/H2 等行。
  - `WorkspaceQuotaLedger` 用的仍是 `InProcessWorkspaceLock`：单实例 exec 够用，
    多实例要换成 DB 级锁。今天只有一个 exec 实例，先记在这里。
  - `exec-rpc.ts` 里那个只去尾斜杠的私有 `normalizeBaseUrl` 仍未与
    `transport-base-url.ts` 的策略函数合并（前者的 baseUrl 来自进程环境）。
  - 十个超千行文件仍在棘轮里记着账，本轮没有拆分。

## 2026-09-04（续四）— 删掉的代码还在镜像里

- **Context:** 上一条收尾时顺手核对"运行中的镜像是否含本批全部改动"，反过来发现
  镜像里还留着**当天刚删掉**的文件。
- **Finding:** `.dockerignore` 里的 `dist/` 与 `node_modules/` 不带 `**/`。Docker 的
  语义是：不含斜杠前缀的 `dist/` 只匹配上下文根下的 `./dist`。本仓库的构建上下文
  是仓库根，每个包各有自己的 dist，Dockerfile 又是 `COPY agent ./agent` 整目录拷贝，
  于是宿主机的 `agent/dist` 被完整塞进镜像；`npm run build` 的 tsc 只覆盖它自己
  编译出的文件，不清理别人留下的。实测运行中的 agent 镜像里有：
  `dist/src/infrastructure/sandbox/internal-hmac.js`（当天删的 980 行）与
  `dist/src/runtime/providers/memory.js`（当天删的退役 provider）。
  这个文件的注释原本就写着这个意图（"Shipping the host's would let a stale local
  dist/ silently win over the in-image build"），只是模式没写对。
- **Action:** 改成 `**/dist/` / `**/node_modules/` / `**/*.tsbuildinfo`，新增
  `tests/test_dockerignore_excludes_host_build_output.py`。重建四个镜像后两个残留
  文件均已消失，§4 真实链路 15/15、G7 门禁 8/8 仍全过。
- **一处自我更正：** 最初还怀疑宿主机的 `node_modules` 把 macOS 原生二进制带进了
  Linux 镜像（镜像里确有 `@img/sharp-darwin-*`）。改完 `.dockerignore` 重建后它们
  **仍然在**——说明那是 npm 按 optionalDependencies 自己装的，不是宿主机泄漏。
  已证实的只有 dist 那一条，文档与测试里只写这一条。`node_modules/` 的模式仍然
  一并改掉，因为它是同一个错误。
- **STATUS IDs:** 无 §32 行状态改变。

## 2026-09-05 — 全量回归案例改为真实用户任务

- **Context:** 原回归清单大量使用固定回显与小型合成文件，不能证明用户最终得到正确、可用的工作成果；同时缺少当前多 Agent 与版本管理等能力。
- **Action:** 重写 `reviews/2026-09-01-full-regression/test-cases.md` §1–§3，保留全部原案例 ID 与 §4–§9 历史原文；以冻结项目资料、官方公开数据和独立验算为基础，补齐办公四格式、系统 Skill 逐包、Agent 发布/回滚、Dataset/Artifact 重启、完整恢复与容量/安全分支。新增资料规范和页面/工具/API/STATUS 覆盖矩阵，更新 README。
- **Evidence boundary:** 本次只更新测试设计，没有执行新的产品回归，也没有生成真实业务数据或继承历史通过结论；合成数据仅用于明确标识的边界/故障夹具。
- **STATUS IDs:** 覆盖映射 A1–A5、B1–B6、C1–C8、D1–D8、E1–E3、F1–F6、G1–G7、H1–H6；无任何行状态改变。
- **Verification:** 仓库布局测试 5 passed；案例 ID、覆盖引用、相对链接及历史段落一致性另做文档检查。本轮没有改生产代码，不需要为文档改动重建运行栈。

## 2026-09-05 — 前端 UI/UX 体验重构：现代卡片输入框、Grok 风格设置、Runs 行内展开与 Details 弹窗稳固化

- **Context:** 前端页面存在多处影响体验与视觉一致性的问题：输入框模型选择与参数裸露悬浮于输入框上方，上下割裂；Details 弹窗高度在不同 Tab 间剧烈跳动（250px~800px），且 Tab 按钮长短不一；Runs 记录的 Logs 在表格最末尾展开而非当条记录下方；设置中心二级导航存在多余重叠与对齐错位。
- **Action:**
  1. 重构 `Composer.tsx` 与 `app.css`：对标 ChatGPT/Claude 3.5 采用一体化卡片容器（`.input-inner.composer-card`），自适应 Textarea 居中，底部工具栏集成回形针上传、内嵌 `256k` 徽章的模型选择器（向上呼出）与状态圆形发送按钮；
  2. 重构 `ContextInspector.tsx`：将弹窗尺寸锁定为 `740px × 620px` 消除高度跳跃（0px 抖动），引入均等宽度（113.67px）的分段控制音轨（`.inspector-tabs-track`），并优化空状态图文居中排版；
  3. 改造 `SettingsSubnav.tsx` 与 `AppShell.tsx`：采用对标 Grok Web 的两栏式设置中心，侧栏分类垂直左对齐；
  4. 改造 `RunsPage.tsx`：使用行内 `<tr className="mgmt-expand-row">` 替代末尾渲染，点击单条记录的 Logs 或 Trace 直接在当前行下方就地平滑展开；
  5. 修复 `ChatContext.tsx` 与 `ConversationSidebar.tsx`：点击历史会话即刻高亮并切换上下文；
  6. 同步更新 `docs/webui.md` 描述最新 UI 架构规范。
- **STATUS IDs:** 无 §32 行状态改变。
- **Verification:**
  - Chrome DevTools MCP 实机测量：6 项 Tab 宽度严格锁定 113.67px，Modal 宽高严格锁定 740px × 620px；
  - 自动化测试与检查全绿：`pytest` (104)、`exec` (346)、`contract` (50)、`api-server` (157)、`agent` (1219)、`frontend` (350) 全数通过；
  - 镜像与容器：`docker compose build frontend && docker compose up -d frontend` 重建并生效。

## 2026-09-06 — AgentVersion 接入前置复核与工作规范优化

- **Context:** 配置目录已能保存版本，但独立 DSH 探针发现版本权限、模型参数与 prompt 消费不完整；基础插件挂载的历史证据不足以证明整条配置链正确。
- **Action:** 按用户要求优化 `AGENTS.md`，修正进程与版本权威描述，明确阶段/最终验证、前后端 DTO、协作所有权及证据边界。继续按 `design/agent-version-runtime-integration-plan.md` 实施，由 Luna 负责代码、主任务独立审查。
- **Evidence:** 新增 `evidence/2026-09-06-agent-version-preflight.md`。对本地 MySQL 只读盘点得到 2 个 legacy 版本，均无 MCP 引用，共绑定 118 个历史 AgentSession；无配置/密钥原文输出、无历史配置回写，不外推生产影响。
- **STATUS IDs:** A2/A3/A5 改为 `partial` 并注明具体缺口；H5/H6 保持 `partial`。本轮为实施中的阶段记录，完整审批/模型/浏览器/容器验收尚未完成，未宣称 P5 通过。

## 2026-09-06 — AgentVersion 配置真正接到运行时（P1–P4 实施 + 阶段验证）

- **Context:** 前置盘点（同日）确认配置目录能保存版本，但独立 DSH 探针证明版本的
  工具授权、MCP 引用、风险/审批、模型参数与 persona 的**实际消费面**不完整——写进去
  不报错却没有执行路径。按 `design/agent-version-runtime-integration-plan.md` 接手实施。
- **Action:**
  - P1 授权：`toolPolicy` 显式 deny、`mcpServers` 精确引用、风险跨具体性取更严、
    空 allowlist 真正零工具、已批准调用的续跑查找+一次性消费 CAS（拆到
    `application/approved-replay-claim.ts`）。
  - P2/P4 配置契约：新增 `application/agent-config-validator.ts`（v1/legacy 契约、字段级
    错误、MCP fail-closed、legacy 模型映射、reasoning effort 按适配器投影）与配置面接口
    `GET /api/agents/config/options`、`POST /api/agents/config/validate`（Agent 语义权威、
    BFF 纯代理）；激活加 `expected_active_version_id` 乐观并发（409 带当前指针，
    `application/durable-policy-replay.ts` 拆出纯判定）。前端拆出 `AgentConfigEditor`/
    `AgentValidationPanel`、`conversationProjection.ts`，会话头/模型选择器读版本固定模型。
  - P3 prompt/模型：prompt 拆成企业 section + 字面量 persona 变量（移除正文标题幂等），
    roots 用服务端逻辑根；`maxOutputTokens`→`AgentOptions.maxTokens`、`thinkingLevel`→
    agent scope `ModelSelection.reasoningEffort`（`infrastructure/dsh/reasoning-efforts.ts`
    按路由适配器投影 effort，纠正退役的 pi-ai `medium` 枚举）。
  - 按职责拆分让三个热点文件回到行数预算之下并收紧棘轮。
- **Evidence:** [`evidence/2026-09-06-agent-version-runtime-integration.md`](evidence/2026-09-06-agent-version-runtime-integration.md)：
  六套测试 + 全部类型检查 + 前端 build 绿；真实插件树 `tools.execute` 授权链（含正向对照）；
  真实 `llm/stream` wire request（maxTokens/effort/字面量 persona/逻辑路径）；容器重建后
  以测试账号 admin 走完 P5 真机全链（配置面→发布/激活→乐观并发 409→跨租户 404→运行链的
  版本绑定、deny 端到端、旧会话版本钉住）。均为开发栈，不外推生产。
- **STATUS IDs:** A2/A3/A5 保持 `partial` 并更新证据链接与已闭合缺口；H5/H6 不变。
  本轮完成 P1–P5 的运行证据（P5 为开发栈真机链）；生产迁移与专项审批浏览器用例仍待补，
  未据此翻绿 §32 行。

## 2026-09-12 — UPDRDB / DBPM 与双集群部署设计修订

- **范围：** 仅 review / design 文档；分支 `refactor/updrdb-dbpm`，基线 `57b9b6a1`，未实施迁移、未改生产代码、未提交。保留已有 full-regression 目录四个未提交文件。
- **Action：** 新增 [统一 design](design/updrdb-dbpm-deployment.md)，按 R1–R7 补齐共享 Skill 存储、HTTPS 入口、抢占事务、完整 schema 校验、新数据卷、VM 工具链与 Redis 放行设计；旧方案标记为已被取代，ADR 0011 补充证据边界。用户确认共享存储可提供；HTTPS 资源待落实。Skill 发布一致性接口仍为多副本上线前检查点。
- **STATUS IDs：** 验收计划关联 A2、B1/B2/B4、C4/C6/C7、D1/D4、G1/G2/G3/G4/G7、H1/H3/H4/H5；本次不改变任何 STATUS 状态，不以设计替代运行证据。
- **验证：** Python 3.11.15；`uv run pytest -q tests/test_repository_layout.py tests/test_runtime_versions.py`：28 passed；文档相对链接路径检查及 `git diff --check` 通过。纯文档修改，不跑六套业务测试、不重建容器；未连接目标 UPDRDB / UPRedis / DBPM、双集群或 VM，目标验收待实施后执行。

## 2026-09-12 — D1：抢占去 SKIP LOCKED、会话 UTC、开发基线切 MySQL 5.7

- **范围：** 实施 [统一 design](design/updrdb-dbpm-deployment.md) 的 D1 阶段；分支
  `refactor/updrdb-dbpm`，基线 `57b9b6a1`。改动落在 `agent/`（outbox / cron 抢占、knex
  afterCreate、DSH 裸池）、`exec/`（裸池会话初始化）、compose / CI / `.env.example` 与相关文档。
  未触及 D2（DBPM、双 Proxy）、D3（手工 DDL）、D4（UPRedis）。
- **Action：** outbox 与 cron 改为「条件 UPDATE 打批次 token → 同事务按 token 回读」，
  新增迁移 `20260912000001_claim_without_skip_locked`（`cron_jobs.claim_token` + 两张表的
  非唯一回读索引）；cron 的 token 是事务内标记，commit 前逐行清空并校验无残留。
  三个连接点统一 `SET SESSION time_zone = '+00:00'`，初始化失败不交付连接。
  开发/CI 数据库切 `mysql:5.7` + **新卷 `mysql57_dev_data`**，旧 8.0 卷保留不复用。
  另在锁定版本上验证了 Knex 多端点故障切换的扩展点，结论写入 design §4.2。
- **STATUS IDs：** 不改变任何 STATUS 行。G3/G4 保持 `done`——其 live 证据来自 MySQL 8，
  本轮在 5.7 上重跑了同键并发 CreateRun 与 outbox 集成用例作为补充对照，未据此改状态。
- **验证：** 六套测试全绿、四项类型检查通过、前端 build 通过、`docker compose config` 通过；
  重建 agent / agent-worker / sandbox / sandbox-mcp 镜像后在 MySQL 5.7.44 上跑通真实链路
  （登录 → 建会话 → 带工具 Run → 进程 logs/signal → 跨租户 404 带正对照），
  live 集成 21 例全绿，含两个真重叠事务用例与 errno 1205 锁等待超时用例。
  详见 [证据](evidence/d1-claim-utc-mysql57-2026-09-12.md)，其中记录了 `.env` 覆盖数据卷
  导致 5.7 起在 8.0 数据目录的实际事故，以及尚未验证的 8.0 回退点。

## 2026-09-14 — D2a/D2b：UPDRDB 双 Proxy 故障切换与等待式 UTC 初始化

- **范围：** [统一 design](design/updrdb-dbpm-deployment.md) D2 阶段的接线部分；分支
  `refactor/updrdb-dbpm`。D2a（`037fccf4`）在 `contract/` 新增无驱动依赖的端点选择策略与
  DBPM TCP 客户端；D2b 把 Agent Knex、Agent DSH 会话存储、exec 三处 MySQL 接入点接上故障
  切换，并把会话 UTC 初始化改为交付连接前等待完成。未做 D2c（DBPM 启动取密、假 DBPM 默认
  启用、Redis 口令）。
- **Decision：** 用户决定旧 8.0 开发卷 `mysql_dev_data` 作废（不删除、不再作为回退点），
  D1 证据中「回退点未验证」一项据此关闭为不适用；compose / `.env.example` / deployment /
  CHANGELOG 的表述同步。用户决定假 DBPM 在开发环境默认启用，落在 D2c。
- **Action：** 新增可选 `UPDRDB_ENDPOINTS`；Knex 按实例继承 mysql2 方言覆写
  `acquireRawConnection()`，裸池按端点建池并外包 acquire；认证/初始化失败不换端点，
  已发出 SQL 不重试。exec 仓储池类型收窄为 `ExecDbPool`。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 H5、G2/G4，目标环境 Proxy/DBPM 验收未做）。
- **验证：** 六套测试、四包类型检查、前端 build、compose config 通过；agent 3 例与 api-server
  2 例 `cancelled` 在不含本次改动的 `037fccf4` 上同样复现，未记为通过。重建 agent /
  agent-worker / api-server / sandbox / sandbox-mcp 镜像后在 MySQL 5.7.44 上跑通真实链路
  （登录 → 建会话 → 带工具 Run → 进程 logs/signal → 跨租户 404 带正对照），live 集成
  agent 27 例、exec 20 例全绿。宿主 Node v23.11.0；本机 3306 被宿主 mysqld 占用，容器
  MySQL 改映射 3307。详见 [证据](evidence/d2b-updrdb-failover-2026-09-14.md)，其中记录了
  未定位的 sandbox `fs-error` 日志与只由假驱动覆盖的握手超时分支。

## 2026-09-14 — D2c：启动经 DBPM 取密，开发默认假 DBPM，本地 Docker 模拟双 Proxy

- **范围：** [统一 design](design/updrdb-dbpm-deployment.md) §7 / ADR 0011 D10；分支 `refactor/updrdb-dbpm`，
  基线 `2fefd531`。改动落在 `contract/`（`dbpm-config.ts`）、`agent/`（容器取密接线、Knex / Redis / BullMQ /
  DSH 会话存储口令注入）、`exec/`（exec 与 sandbox-mcp 入口取密）、开发与生产 Compose、CI、smoke、
  release-gate 测试与文档。
- **Decision：** 用户选择「全部强制」：没有环境变量口令回退，连接串带口令拒绝启动，生产 overlay 要求真实
  `DBPM_URL`。核对实际消费方后，replay Redis 无读取方，只取 UPDRDB 与服务 Redis 两类口令（design §7 与
  ADR 0011 已加 2026-09-14 细化说明）。`agent-migrate` 作为 DBA 工具保留带口令 DSN（`AGENT_MIGRATE_DATABASE_URL`）。
- **Action：** 新增 `dbpm-fake`（真协议假服务端）与本地双 Proxy 模拟 overlay；应用容器清空 `env_file`
  带进来的服务端口令；CI smoke 与 release-gate 在测试内起假 DBPM；新增 DBPM Compose 棘轮测试。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 H5、G2/G4；真实 DBPM / Proxy 目标环境验收未做）。
- **验证：** 六套测试、四包类型检查、前端 build、开发 / 模拟 / 生产 Compose 渲染与生产配置校验通过；
  agent 3 例、api-server 2 例 cancelled 与 D2b 记录相同，未记为通过。重建镜像后在 Docker 模拟栈上跑通真实链路，
  并完成主 Proxy 故障、主 DBPM 故障、双 DBPM 故障拒启、连接串带口令拒启四项演练，日志口令出现 0 次。
  live 集成改用独立库 `pi_d2c_it`（agent 27、exec 29 全绿）。两个 release-gate 未实跑。详见
  [证据](evidence/d2c-dbpm-credentials-2026-09-14.md)。

## 2026-09-14 — D3：手工 DDL 发布包、三进程启动 schema 核对、删除自动迁移

- **范围：** [统一 design](design/updrdb-dbpm-deployment.md) §6 / ADR 0011 D6；分支 `refactor/updrdb-dbpm`，基线
  `0392d0e3`。改动落在 `contract/`（schema 清单与比对）、`agent/`（schema 导出/重放/核对 CLI、容器启动核对、
  去掉启动迁移）、`exec/`（启动核对先于孤儿回收）、两份 Compose、恢复脚本、生产配置校验、卫生测试与文档。
- **Decision：** 用户决定开发 Compose 也去掉自动迁移，与生产同一流程。schema 清单
  `contract/schema/schema-manifest.json` 作为规范提交进仓库（由真实迁移生成、有防漂移测试），发布包 SQL 不提交。
  归一化只抹平实测的 5.7 / 8.0 表示差异；Knex 记账表只核对存在。
- **Action：** 新增 `schema:manifest|sql|replay|verify`、`scripts/dev/schema-apply.sh`；agent / agent-worker / sandbox
  启动时按清单核对，差异即 `SCHEMA_DRIFT` 拒启；删除 `agent-migrate` 与 `AGENT_MIGRATE_ON_START`；`restore.sh`
  改为只读核对；生产配置校验改为拒绝迁移服务回归并校验 DBPM 与无口令连接串。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 B1/B4；目标 UPDRDB 上的 DBA 执行与元数据权限验收未做）。
- **验证：** 六套测试、四包类型检查、前端 build、开发 / 模拟 / 生产 Compose 渲染与生产配置校验通过；agent 3 例、
  api-server 2 例 cancelled 同前，未记为通过。清单在 MySQL 8.0 临时库与 5.7 运行库上均零差异。live 集成
  agent 37、exec 31 全绿（含首装/增量重放零差异、中途失败不记账、缺触发器/列/索引/未知表/迁移记录被报出）。
  Docker 演练：空库三进程拒启 → `schema-apply.sh` 建表 → 自动恢复并跑通真实链路 → append-only UPDATE/DELETE
  被拒 → 删触发器后 agent-http / agent-worker / exec 均以 `missing_trigger` 拒启 → 恢复后零差异。最终镜像在新空库复验通过。
  详见 [证据](evidence/d3-schema-release-2026-09-14.md)。

## 2026-09-14 — D4：BullMQ `{bull}` prefix、Redis 5.0.14 基线与 UPRedis 路由模拟

- **Context：** UPDRDB/UPRedis/DBPM 迁移 §11 的 D4。UPRedis Proxy 按 key 路由，BullMQ 多 key 脚本要求同队列 key 同节点；
  探针另把 Redis 5.0 缺 `LPOS`、`volatile-lru` 淘汰策略列为阻塞项。触及 `agent/`（队列工厂、容器、worker 入口）、两份 Compose、CI 与文档。
- **Decision：** 新增 `AGENT_RUN_QUEUE_PREFIX`（空值 = `{bull}`），HTTP 与 Worker 共用，不含非空 hash tag 拒绝启动；
  开发 / 生产 overlay 本地 Redis 降到 5.0.14、显式 `noeviction`，因 5.0 读不了 7.x 数据文件而换新卷、旧卷保留。
  核对 bullmq 5.80.7 源码后确认低于 6.0.6 时自动改用无 `LPOS` 脚本，`LPOS` 不再作为升级 Redis 的理由（ADR D9 已补实施细化）。
- **Action：** prefix 校验与接线；Compose / CI / 卫生棘轮；开发用 RESP 路由模拟代理与 overlay；放行测试
  `upredis-queue.integration.test.js`；三个 release gate 断言同步；runbook `run-queue-prefix-switch.md`；文档与 CHANGELOG。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 B2、G2/G3；真实 UPRedis Proxy 放行与节点 `noeviction` 核验未做）。
- **验证：** 六套测试、四包类型检查、前端 build、开发 / 模拟 / 生产 Compose 渲染与生产配置校验通过；agent 3 例、api-server 2 例
  cancelled 同前，未记为通过。放行测试直连 5.0.14 6 pass / 1 skip、经模拟代理 7 pass（含零 key EVAL 与无 tag 前缀被拒负对照，
  立即 / 延迟 / 重试 / stalled / 取消 / 状态查询 / 单 key CAS，逐 key 无遗留）。Docker 演练按 runbook 盘点 → 停服务 → 切到
  5.0.14 + 模拟代理，真实链路（带工具 Run、进程 signal、跨租户 404）通过，`bull` 前缀 worker 拒启后恢复。
  详见 [证据](evidence/d4-upredis-queue-prefix-2026-09-14.md)。

## 2026-09-14 — D4 复验：release gate 修复、容器内运行器、FsError 错误码映射

- **Context：** 换一台 macOS 开发机重建到 `ecda592e` 复验 D4。D2c–D4 证据均记录 release gate 未实跑；实跑后三个 gate 失败，
  另定位了 D2b 证据中未定位的 `exec fs-error … INTERNAL_ERROR`。用户要求测试在 Docker 中运行、旧数据直接清理。
- **Decision：** gate 不放宽 schema 核对，副作用表移到兄弟库；`WAITAOF` 改为 5.0 可用的 `BGREWRITEAOF` 完成判定；
  新增容器内运行器取代宿主机起进程。FsError 分类改为结构判断但只认 dsh-fs 声明的错误码，不透传任意 `code`。
- **Action：** 修改三个 gate、worker fixture 与 dsh gate 的子进程加载；新增 `scripts/dev/release-gates.sh` 与运行器 Dockerfile；
  contract `isFsError` 与回归测试；exec 真实 bwrap 用例改用 `buildPreflightProfile()`；`development.md`、CHANGELOG；
  design §3.3 补 S1 接口草案（待用户确认，未实施）。删除旧 8.0 / 7.2 数据卷与临时测试库。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 B1/B2、G2/G3；目标环境验收未做）。
- **验证：** 容器内 Node 22.23.2：release gate 运行器全绿（UPRedis 直连 6 pass / 1 skip、经代理 7 pass、redis-restart 4/4、
  bullmq-worker-restart 2/2、agent-worker-restart 3/3）；contract 99/99、exec 369/369（带 bwrap + seccomp、非 root）、
  api-server 159/159、frontend 367/367 + build、各包 typecheck 通过；agent 1297 pass / 3 cancelled（与 D2b 同一组，不记为通过）；
  `uv run pytest` 123 passed。重建 agent / sandbox 镜像并换新容器后真实链路通过，sandbox 日志 `INTERNAL_ERROR` 归零。
  `agent-worker-dsh-restart` gate 未跑。详见 [证据](evidence/release-gates-docker-2026-09-14.md)。

## 2026-09-14 — 修复：已启用用户 Skill 对模型不可见

- **Context：** S1 实施前按 design §3.3 核对模型可见 Skill 路径，真实链路复现出更前一层的缺陷：UI 启用成功的用户
  Skill 在 `skill` 工具中报 unknown，系统 Skill 正常。
- **Decision：** 先单独修复并提交，再在其上实施 S1；模型可见路径与 exec 挂载不一致（同次复现确认）归入 S1 第 6 条。
  用户确认 S1 按推荐方案：按摘要分版本目录、回收宽限期默认 24 小时（可配置）、草稿根保持共写。
- **Action：** 运行时探针定位到 `createDshRunExecutorFactory` 漏转发 `skillRootsForRun`；补转发与回归测试；
  CHANGELOG；design §3.3 补充两条已复现事实与决策记录。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 A2、H1/H3）。
- **验证：** 回归用例修复前失败、修复后通过；容器内 agent typecheck 通过、1298 pass / 3 cancelled（已知组）；重建 agent
  镜像后真实链路 `skill` 加载用户 Skill 成功；`uv run pytest` 123 passed。详见
  [证据](evidence/skill-discovery-fix-2026-09-14.md)。

## 2026-09-14 — S1：用户 Skill 账本发现、按摘要分版本、exec 按清单挂载

- **Context：** design §3.3 S1 接口检查点。实施前在真实链路复现模型可见 Skill 路径与 exec 挂载不一致；静态核对 exec 扫目录并吞异常、
  启用无锁非事务。实施中发现内部面 GET 的 query 不在签名内。
- **Decision：** 用户确认推荐方案（S1-Q1 摘要分版本目录、S1-Q2 宽限期默认 24 小时可配置、S1-Q3 草稿根共写）；历史数据直接清理，
  不做平铺布局迁移。清单放在请求体顶层 `enabledSkills`；GET 签名改为覆盖规范化 query；版本目录内再套包名以复用出厂 provider。
- **Action：** contract `skill-manifest.ts` 与两个传输错误码；exec 按清单核对版本与侧车、GET 规范化验签；agent 发布存储重写、
  owner membership 行锁事务、Worker 按账本核对、Run 内逻辑路径 provider、exec RPC 携带清单、能力投影按账本、
  `SKILL_VERSION_GC_GRACE_MS`；api / webui / deployment / development / `.env.example` / design / CHANGELOG 同步。
- **STATUS IDs：** 不改变状态值；B3 行按门禁更新清单计数 18 → 31（关联 A2、H1/H3；多副本与共享存储目标环境验收未做）。
- **验证：** 容器内 Node 22：contract 109/109、exec 374/374（非 root + bwrap + seccomp）、agent 1303 pass / 3 cancelled（已知组）、
  各包 typecheck；锁集成测试在开发栈 MySQL 4/4；`uv run pytest` 123 passed。重建镜像后真实链路：启用得 `.v/<digest>` 版本、
  模型按 `/home/sandbox/skill-user/path-probe` 读到资源、停用后不可见且草稿回到未发布、字节保留。详见
  [证据](evidence/s1-skill-ledger-2026-09-14.md)。

## 2026-09-15 — S2a / S2b：Worker 探针 listener 与 sandbox-mcp 就绪探针

- **Context：** design §11 S2 中不依赖目标环境的两项（§9.2 探针表）。HTTPS 域名、K8s NetworkPolicy、LB 注册依赖 S0 平台信息，
  不在本次猜测。实施中在运行栈复现：执行面 `/ready` 与 `/health` 是同一个恒 ok 处理器，`deployment.md` 描述的预检不存在。
- **Decision：** Worker 独立 listener 只开 `/health`（不查依赖）与 `/ready`（启动完成 + 消费者在跑 + 未关停 + MySQL / Redis 2s 内可达），
  端口非法拒启、先于容器启动、SIGTERM 先摘除就绪。facade `/ready` = 服务 Redis PING + 执行面 `/ready`，探针不带桥 token，
  不为探测新增窄桥路由。执行面 `/ready` 的修复拆为 S2c，本次只把文档改成现状。「readiness=false 时暂停取任务」暂不实现，记为待定。
- **Action：** agent `worker-probe.ts` 与 `worker-main.ts` 接线；exec facade `ContextStore.ping` / `sandboxReady` / `readiness` / `GET /ready`；
  Compose `agent-worker` healthcheck；`deployment.md`、`.env.example`、design §9.2、CHANGELOG。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 G1；目标环境部署验收未做）。
- **验证：** 探针单测 Worker 12/12、facade 23/23；agent 1311 pass / 3 cancelled、api-server 157 pass / 2 cancelled（已知组，不记为通过）；
  exec 376 / 1 skip、contract 109/109、frontend 0 fail + build、四包类型检查、`uv run pytest` 123 passed，均在宿主 Node v23.11.0。
  重建 agent / sandbox 镜像并换新容器：停 UPRedis 代理时 Worker 与 facade `/ready` 503、`/health` 200，停 sandbox 时 facade `/ready` 503，恢复后 200；
  真实链路（带工具 Run、进程 logs / SIGTERM、跨租户 404 带正对照）通过。详见 [证据](evidence/s2ab-probes-2026-09-15.md)。

## 2026-09-15 — S2c：执行面 `/ready` 就绪判定与启动期隔离预检

- **Context：** S2a/S2b 中在运行栈复现执行面 `/ready` 与 `/health` 共用恒 ok 的处理器；`preflightCheck()` 只有测试调用，
  生产启动链没有隔离预检。design §9.2 要求 VM exec 的 LB 用 `/ready` 或同等预检状态。用户确认按「S2c → nginx 模板 → slim facade → VM release」顺序推进。
- **Decision：** `/ready` 每次实时检查数据库与四个数据根（各 2s），隔离只读启动期结果、不按请求 spawn bwrap；未接线的装配 503（fail-closed）。
  启动链在 schema 核对后、孤儿回收前建出数据根并真跑 bwrap 探针，失败拒启（exec 没有「隔离可选」开关，与既有 fail-closed 一致）。
  Agent / BFF 依赖检查继续打 `/health`，不随之收紧。删除 `api.md` 中不存在的 `/metrics` 与 Prometheus 指标描述。
- **Action：** exec `http/readiness.ts`、`app.ts` 接线与 `ExecRuntime.preflight` / `markShuttingDown`、`main.ts` 启动顺序；
  `main.test.ts` 两处断言按新语义修改并新增 `readiness.test.ts`；`api.md`、`deployment.md`、design §9.2、CHANGELOG。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 G1、G7；VM 与 LB 目标环境验收未做）。
- **验证：** 修改后的回归断言在还原的修复前代码上 2 例失败；就绪单测 27/27、exec 384 / 1 skip、tsc、`uv run pytest` 123 passed（宿主 Node v23.11.0）。
  重建 sandbox 镜像并换新容器：停双 UPDRDB Proxy → exec `/ready` 503 `database`、facade 503，`/health` 200；`chmod 000` control 根 → 503 `storage.control`；
  恢复后 200；缺失 bwrap 的一次性容器以 preflight 失败拒启（退出码 1）；真实链路通过。agent / api-server / contract / frontend 无改动未重跑。
  详见 [证据](evidence/s2c-exec-readiness-2026-09-15.md)。

## 2026-09-15 — S2d：frontend nginx 上游 `API_UPSTREAM` 模板化

- **Context：** design §2.2 / §7 要求 frontend 上游可配置（K8s 中指向 api-server 内部 LB），且 envsubst 只替换明确允许的变量。
  此前 `frontend/nginx.conf` 写死 `http://api-server:4000`。
- **Decision：** 复用官方 nginx 镜像的 templates + `NGINX_ENVSUBST_FILTER`，不自写渲染。只接受 `http://host[:port]`；
  官方渲染在 `conf.d` 不可写时只记日志继续，因此加渲染前校验、渲染后核对两个钩子并删除官方 `default.conf`，失败拒启。
  BFF 不读取客户端转发头，暂保留 `$proxy_add_x_forwarded_for`。生产 Compose 边缘 nginx 不在范围。
- **Action：** 模板、Dockerfile、两个钩子、开发 Compose、`tests/test_frontend_nginx_template.py`；`.env.example`、`deployment.md`
  （新增 frontend 上游小节，删除不存在的 exec Prometheus 指标）、`architecture.md`、`webui.md`、README、design §2.2、CHANGELOG。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 G1；目标环境 LB / HTTPS 未验证）。
- **验证：** 卫生测试 150 passed（首轮模板注释导致核对误报，已修）；重建 frontend 镜像：非法值 / https / 注入 / 非 root 下 `conf.d`
  不可写均退出码 1，合法自定义上游 `nginx -T` 正确且 nginx 变量保留；开发栈经 3000 端口 `/`、SPA fallback、`/api` 与直连一致；
  经 `frontend:80` 的真实链路（含 SSE 首块、进程 logs / SIGTERM、跨租户 404）通过。SSE 为 Run 结束后的回放，未测进行中推送。
  详见 [证据](evidence/s2d-frontend-api-upstream-2026-09-15.md)。

## 2026-09-15 — S2e：sandbox-mcp slim 镜像

- **Context：** design §2.1 要求对外 facade 使用 slim 镜像。此前 facade 与执行面共用 2.84GB 镜像（含 bwrap、chromium、Python、
  curl、`mysql2`、dsh-*），且静态 import 图显示 facade 入口经 `startup-credentials.ts` 间接加载 `db/client.ts` 与 `mysql2`。
- **Decision：** 同一份 `exec/Dockerfile` 新增 `facade` 阶段而不是新 Dockerfile；只复制 facade import 图里的文件，依赖按 lockfile
  `npm ci --omit=dev` 后移除执行面包。拆出 `mcp/startup-credentials.ts` 切断 facade → db 的依赖，并用测试同时约束 import 图与
  Dockerfile 复制清单，防止两者漂移。基础镜像不换。
- **Action：** 新文件与测试、Dockerfile 两阶段、Compose `sandbox-mcp` target / image / healthcheck；AGENTS.md §1 / §4、`architecture.md`、
  `sandbox-mcp.md`、`development.md`、README、`.env.example`、design §2.1、CHANGELOG。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 G1；K8s 部署与镜像扫描未做）。
- **验证：** 边界测试在改动前代码上失败（`db/client.ts`、contract `endpoint-failover`）；facade 相关 38/38、exec 390 / 1 skip、tsc、
  `uv run pytest` 150 passed（宿主 Node v23.11.0）。镜像构建首次因 OrbStack 代理 EOF 失败，重试通过：facade 302MB、uid 10001、无 bwrap / Python /
  curl / `mysql2` / dsh-*、发布文件只读。换新容器后 facade healthy、`/ready` 200；经 slim facade 的真实 MCP 调用（写文件 → Python 读回、
  错误 / 缺失 token 401）与经 BFF 的真实链路通过。详见 [证据](evidence/s2e-slim-facade-2026-09-15.md)。

## 2026-09-15 — S2f：VM exec release 与 systemd 部署资产

- **Context：** design §9 要求执行面在单 VM 上以不可变 release + systemd 运行。用户确认本阶段范围：release 包、unit、启动前检查、
  安装 / 切换 / 回滚脚本，在 Linux 容器中验证；工具链安装与目标 VM 验收不在范围。
- **Decision：** 在目标架构 Linux 容器内构建（依赖含 koffi 原生模块），manifest + `SHA256SUMS` 支撑完整性核对；Node 固定
  `/usr/local/bin/node`（bwrap 只暴露 `/usr` 等路径）。env 模板只列 exec 实际读取的变量。安装脚本不自动重启。加固项以 exec 启动期
  bwrap 预检为准逐项实测后取舍；初稿「`/proc` 相关项会使 bwrap 失败」的判断经实测错误，已改为启用实测兼容的三项。
  发现 `EXEC_INTERNAL_ALLOW_CIDR` 为空时内部面不限来源、Compose 的 `SANDBOX_ALLOWED_CLIENT_CIDRS` 无读取方，本次只在 VM 预检要求非空，应用默认值待决定。
- **Action：** `scripts/vm/`（构建脚本、构建器、manifest 生成、开发用 systemd 容器）、`deploy/vm/`（unit、env 模板、预检、安装脚本）、
  `tests/test_vm_release_assets.py`；`deployment.md`（VM exec release 小节）、`module-layout.md`（同时修正 S2e 遗留的「facade 同镜像」表述）、
  design §9、CHANGELOG。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 G7、C4/C6/C7、H4；T6 目标 VM 验收未做）。
- **验证：** 首轮演练因 `/tmp` noexec 引导失败作废；重跑后两处判定（`ss` 缺失、`pgrep` 自匹配）写错，已用 `curl` 与 `ps` 复核。
  特权 systemd 容器内：负对照（缺配置、篡改文件、数据根权限）均在 ExecStartPre 拒绝且未监听；正常启动 uid 997、`/ready` 200；
  最终 unit 下后台作业 `systemctl stop` 无残留进程，重启后孤儿回收收口账本；切换、同 id 拒绝重装、回滚通过；加固项逐项实测。
  amd64 产物只核对清单与原生模块架构。`uv run pytest` 166 passed。详见 [证据](evidence/s2f-vm-release-2026-09-15.md)。

## 2026-09-15 — exec 内部面来源白名单空值改为拒绝

- **Context：** S2f 发现 exec 在 `EXEC_INTERNAL_ALLOW_CIDR` 为空时不限制内部面来源，而各部署从未传入该变量（Compose 传的是
  无读取方的 Python 时代变量），内部面实际只靠 HMAC。用户决定空值改为拒绝，同时决定 Worker 未就绪时暂停取任务（另一提交）。
- **Decision：** 空列表与取不到对端地址一律拒绝，放行全部须显式 `0.0.0.0/0,::/0`；非法条目拒启（不静默跳过）；空白名单不拒启但启动告警
  （公共面、窄桥与探针仍可用）。开发 Compose 给默认私网白名单，生产 overlay 必填并由校验器拒绝 `/0`。顺带修正
  `createExecAppFromEnv` 忽略传入 env、IPv4-mapped IPv6 不匹配与畸形 IPv6 被接受三处相邻缺陷。
- **Action：** `exec/src/security/cidr.ts`、`http/app.ts`、`main.ts`、`router.ts` 注释；exec 测试；Compose / prod overlay / CI /
  `verify_compose_prod_config.py` 与其测试 / `smoke-cross-service.mjs`；`deployment.md`、`architecture.md`、`development.md`、
  `.env.example`、`deploy/vm/exec.env.example`、design §9、CHANGELOG。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 C1 内部面鉴权、G1）。
- **验证：** exec CIDR / 路由单测 44/44、exec 398 / 1 skip、tsc、`uv run pytest` 171 passed（宿主 Node v23.11.0）；prod overlay 以 CI
  占位环境渲染：设置值通过、缺失被 compose 拒绝、`/0` 被校验器拒绝。重建 sandbox 并换新容器：默认白名单下 agent 内部面调用成功，
  排除 agent 网段时 `ip not allowed`，空白名单一次性实例告警且拒绝，非法 CIDR 拒启；经 BFF 的真实链路通过。
  详见 [证据](evidence/exec-internal-cidr-fail-closed-2026-09-15.md)。

## 2026-09-15 — Agent Worker 依赖不可用时暂停取任务

- **Context：** design §9.2 要求 readiness=false 时应用自己暂停取新任务。S2a 只做了探针，用户决定补上暂停。
- **Decision：** 依赖守卫复用 `/ready` 的 ping，连续 2 次失败 `worker.pause(true)`（不等待在跑任务）、连续 2 次成功 `resume()`，只恢复自己造成的暂停。
  第一版在开发栈实测发现 `pause(true)` 不打断在途的阻塞取任务，暂停中入队的作业仍在 MySQL 不可用时被执行；读 bullmq 5.80.7 源码确认根因后，
  没有改用会等待全部在跑任务的 `pause()`，而是在作业处理外壳执行前检查暂停状态，暂停中 `moveToDelayed` + `DelayedError` 放回队列。
- **Action：** `worker-dependency-guard.ts`、`worker-probe.ts`、`worker-main.ts`、`run-queue.ts`（抽出 `createRunJobHandler`）与单测；
  `deployment.md`、`.env.example`、design §9.2、CHANGELOG。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 B2、G2）。
- **验证：** 单测 30/30；agent 1325 pass / 3 cancelled（已知组，不记为通过）、typecheck（宿主 Node v23.11.0）。重建 agent 镜像并换新容器：
  停双 UPDRDB Proxy 约 11s 后暂停、`/ready` 503 `consumer: paused`；暂停中入队作业先被在途取任务拿到、随即放回，20s 内持续 `delayed`；
  恢复约 7s 后继续，作业才被执行（失败原因由修复前的数据库不可达变为虚构 Run 的 `Run not found`）；真实链路通过。
  详见 [证据](evidence/worker-dependency-guard-2026-09-15.md)。

## 2026-09-15 — S2f-2：VM 工具链安装脚本（openEuler 24.03 容器演练，未完成）

- **Context：** S2f 未覆盖 VM 上的模型工具链。用户决定先用 openEuler 官方镜像演练安装脚本与 release。
- **Decision：** openEuler 24.03 官方源核对后缺 ripgrep / fd / pandoc / LibreOffice / Chromium，用户选择上游官方包钉版本 + SHA256；
  LibreOffice 验 TDF 签名后钉，Chromium 用 Playwright 分发的 Chrome for Testing 按下载钉。全部装到 bwrap 可见的 `/usr/local` 与 venv。
- **Action：** `deploy/vm/toolchain/`（安装脚本、制品清单）、release 构建器带工具链资产、openEuler 演练镜像、卫生测试；演练中修复 tesseract
  语言数据路径（openEuler 打包不一致）与校验函数 SIGPIPE 误报两处；exec 在 systemd 255 上因 `ProtectKernelTunables` / `ProtectKernelLogs`
  挂不上 procfs 而拒启，逐项实测后从 unit 移除。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 G7、T6；目标 VM 未验证）。
- **验证：** 14 个制品文件按清单核对通过；openEuler 容器内 release 安装、工具链安装与校验通过；加固项逐项实测。`uv run pytest` 199 passed。
  **bwrap 内完整工具 smoke 尚未在修正后的 unit 下跑通**。详见 [证据](evidence/s2f2-openeuler-toolchain-2026-09-15.md)。

## 2026-09-15 — S2f-2 续：修正 unit 下的 exec 启动与 bwrap 内工具链 smoke

- **Context：** 上一条 S2f-2 记录留下「修正 unit 后未启动、bwrap 内完整工具 smoke 未跑通」。上一轮演练环境（缓存、release、容器）不在本机，按提交的资产重建。
- **Decision：** 演练用专用库 `pi_vm_sim` 与专用假 DBPM，不碰开发栈 `sandbox` 库；服务间凭据现生成，不复用开发栈凭据。Chromium 按产品实际消费者
  `baoyu-chrome-cdp` 的 CDP 路径验收；一次性 `--screenshot` 模式在 bwrap 外同样挂起，记为非产品路径的环境问题，不改 wrapper。
- **Action：** 无代码改动；新增证据文件，同步 `deployment.md` 演练范围、design §9 S2f-2 细化、CHANGELOG。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 G7、T6；目标 VM 未验证）。
- **验证：** 7 个 arm64 制品 SHA256 核对 OK；HEAD release 在全新 openEuler 24.03 容器离线缓存安装、工具链校验通过；exec 在修正 unit 下 `/ready` 全 ok；
  bwrap 内 rg / fd、Python 与 Node 文档生成读回、soffice 转换、pdftotext / qpdf、pandoc、tesseract OCR、两个 BaoYu wrapper、mermaid 经 CDP 渲染全部通过；
  Debian 镜像同一 smoke 作对照。发现沙箱 `/etc` 白名单缺 fontconfig、旧 Debian 镜像 soffice 转换 abort，均未修改。
  详见 [证据](evidence/s2f2-openeuler-toolchain-smoke-2026-09-15.md)。

## 2026-09-15 — VM exec 真实链路（Agent / Worker / BFF / sandbox-mcp 指向 openEuler 容器内 exec）

- **Context：** S2f 与 S2f-2 只用 RPC 客户端直连 VM exec，真实链路未经 VM exec。用户选择先做这一项，并同意临时替换开发栈执行面。
- **Decision：** 不改 Compose：停开发栈 `sandbox`，演练容器以网络别名 `sandbox` 接入；VM exec 改用与 Agent 同一账本库 `sandbox`；
  服务间凭据用演练现生成值同时覆盖消费者与 VM（不复用开发栈凭据）。消费者先按 HEAD 重建镜像。
- **Action：** 无代码改动；新增证据文件，design §9 与 `deployment.md` 演练范围同步。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 G7、T6；目标 VM 未验证）。
- **验证：** 经 BFF：注册 / 登录、`sessions/ensure`、真实模型带工具 Run `SUCCEEDED`（`bash:succeeded` × 3）、进程 logs 有 TICK、SIGTERM 后 `cancelled`、
  B 访问 A 的 run / conversation / tools / sessions.ensure / process 全 404、A 对照 200；工作区落在 VM 数据根、开发 `sandbox` 容器全程停止。
  驱动「输出含 openEuler」判定因沙箱看不到 openEuler 的 `/etc/os-release` 未通过，改以工作区位置等证据判定。
  发现：openEuler 的 `/etc/ssl/certs` 链到 `/etc/pki`，沙箱白名单不含 `/etc/pki`，沙箱内 CA 证书不可读（放开网络后 HTTPS 校验会失败）；网络重连后 exec `/ready` 短暂报数据库不可用（未定位）。详见 [证据](evidence/s2f2-vm-exec-real-chain-2026-09-15.md)。

## 2026-09-15 — 沙箱 /etc 白名单补字体配置与 RHEL 系 CA 信任库

- **Context：** 前两条 VM 演练记录发现：沙箱内 fontconfig 缺配置（镜像与 VM 均有）；openEuler 上 `/etc/ssl/certs` 链到 `/etc/pki`，沙箱内 CA 证书不可读。用户决定先修白名单。
- **Decision：** 按需逐条挂载，不整体挂 `/etc/pki`，避免 `tls/private` 私钥、`nssdb`、`rpm-gpg` 进沙箱；全部 `required: false`，Debian 上不存在即跳过。
- **Action：** `exec/src/isolation/build.ts` 的 `STATIC_ETC_FILES` 追加 `/etc/fonts`、`/etc/pki/tls/certs`、`/etc/pki/tls/cert.pem`、`/etc/pki/tls/openssl.cnf`、
  `/etc/pki/ca-trust/extracted`；`preflight.ts` 注释；三处 isolation 测试；`deployment.md`、design §9、CHANGELOG。
- **STATUS IDs：** 不改变任何 STATUS 行（关联 T6）。
- **验证：** Linux 容器（真实 bwrap，安全选项同 Compose）中新测试修复前失败（`fonts=missing` 等 3 项）、修复后 exec 402/402；重建 sandbox / sandbox-mcp 并换新容器，
  Debian 执行面与 openEuler VM exec（新 release）沙箱内字体配置、CA 文件可读、Python 加载 CA、`tls/private` / `nssdb` 不可见，VM 上 soffice 嵌入 CJK 字体；
  开发栈真实链路通过。Debian 镜像 soffice abort 修复前后均在，另行处理。详见 [证据](evidence/sandbox-etc-allowlist-fonts-ca-2026-09-15.md)。

## 2026-09-15 — 执行面镜像内 soffice 在沙箱里启动即崩溃

- **Context：** VM 演练的 Debian 对照中 soffice 在沙箱内 exit 134，`/etc` 白名单修复前后均出现。用户要求修复。
- **Decision：** 复现为沙箱专属（bwrap 外同一容器转换成功）；根因是 Debian LibreOffice 的注册表在 `/etc/libreoffice/registry`，经 `/usr` 下符号链接读取，
  沙箱内悬空。只挂 LibreOffice 实际经链接读取的两条，不整体挂 `/etc/libreoffice`；同一扫描发现的 `/etc/environment`、system Python sitecustomize、X11 rgb.txt 刻意不挂。
- **Action：** `exec/src/isolation/build.ts` 追加 `/etc/libreoffice/registry`、`/etc/libreoffice/psprint.conf`；isolation-build / preflight 测试；CHANGELOG。
- **STATUS IDs：** 不改变任何 STATUS 行。
- **验证：** 新测试修复前失败 2 项、修复后 exec 403/403（Linux 容器真实 bwrap）；contract 109/109、agent 1325 pass / 3 cancelled（已知组，不记为通过）、
  api-server 159/159、frontend 367/367 + build、各包类型检查（Node 22 容器）。重建 sandbox / sandbox-mcp 并换新容器后沙箱内 docx / xlsx / pptx 转 PDF 成功并读回；
  openEuler VM exec 装新 release 同样成功（挂载跳过）；开发栈真实链路通过。详见 [证据](evidence/sandbox-soffice-libreoffice-registry-2026-09-15.md)。

## 2026-09-16 — 退役 replay Redis 与同族死变量；入口改内网 HTTP（双模式）

- **Context：** design §7 的 D2c 补记留了「replay 实例与配置的去留另行处理」；用户本轮决定内网服务先不上 HTTPS，并要求清理无消费方的配置。
- **Decision：**
  1. 删除 `sandbox-replay-redis`（开发 / 生产 overlay / CI smoke）、数据卷、独立口令，以及 5 个全仓无读取方的
     `SANDBOX_INTERNAL_*` 变量（含被文档与生产校验当成 fail-closed 开关的 `PLANE_ENABLED`）。内部面闸门仍是
     HMAC keyring + `EXEC_INTERNAL_ALLOW_CIDR`，不变。
  2. 边缘 nginx 改双模式：`TLS_ENABLED`（默认 `true` 保持既有行为）选 `sandbox-tls.conf` / `sandbox-http.conf`，
     两者 include 同一份 `locations.conf`，路由与 SSE 语义不随模式漂移；非法值拒启，渲染后跑 `nginx -t`。
     明文模式**不声明 HSTS**（对无加密端口的站点声明 HSTS 会锁死入口）。
  3. 会话 Cookie 去掉 `Secure`（用户选定）：明文入口下带 `Secure` 的 Cookie 浏览器不回传，登录会直接失效；
     `HttpOnly` / `SameSite=Lax` 保留，恢复 HTTPS 时必须同时恢复 `Secure`。
- **Action：** `docker-compose.yml` / `docker-compose.prod.yml`、`.env.example`、`.github/workflows/test.yml`、
  `scripts/smoke-cross-service.mjs`、`scripts/verify_compose_prod_config.py`；`nginx/conf.d/sandbox.conf` 拆为
  `nginx/templates/{locations,sandbox-http,sandbox-tls}.conf` + 重写 `entrypoint.sh` / `Dockerfile`；
  `api-server` 的 `cookies.ts` / `auth.ts`；四份测试改为退役棘轮与双模式契约；
  `deployment.md`、`development.md`、`architecture.md`、`sandbox-mcp.md`、design §1/§2.2/§7/§12、README、CHANGELOG。
  顺带修正 deployment.md 架构图里过期的 `redis:7.2`，以及 TLS 模板里 nginx 1.27 已废弃的 `listen ... http2`。
- **STATUS IDs：** 不改变任何 STATUS 行。design §12 的「HTTPS 域名/证书/终止点」待落实项按用户决定关闭。
- **验证：** 六套测试 + 各包类型检查 + 前端 build 全绿（pytest 206；contract 109；exec 401/2 skipped；
  agent 1325 pass / 3 cancelled；api-server 158 pass / 2 cancelled；frontend 367）——5 例 cancelled 是宿主
  Node v23.11.0 的已知组，不记为通过。prod overlay 渲染 + 校验通过且不再含 replay 服务与卷。
  nginx 两种模式在真实容器中验证渲染、`nginx -t` 与非法值拒启。**重建 BFF 镜像并换新容器后**，
  经 BFF 的真实链路 17/17：Cookie 无 `Secure` 且仅凭 Cookie 认证成功、带工具 Run `SUCCEEDED`、
  进程 logs 有 `TICK`、SIGTERM 后 `cancelled`、6 项跨租户 404 且有本人 200 的拒绝对照。
  过程中自我修正三处（渲染校验放错层、检查容器自我代理回环、`ENTRYPOINT` 覆盖写法）均记在证据里。
  详见 [证据](evidence/replay-redis-retire-and-http-ingress-2026-09-16.md)。

## 2026-09-16 — 接上沙箱资源限额与配额；打通 shell 参数、截止与取消（R1/R2/R4/R5/R6）

- **Context：** `docs/reviews/2026-09-16-agent-worker-sandbox` 的审查发现 6 项问题，
  其中三项 P1。本轮按该目录的执行方案实施 R1、R2、R4、R5、R6；R3（等待子 Run 的父 Run
  会耗尽同队列全部消费槽）另行处理。
- **Decision：**
  1. **R1**：Compose 与 `.env.example` 声明的六个资源变量在 `exec/src` 里没有任何消费者，
     子进程配额的三个函数（`evaluateChildQuota` / `ChildWorkspaceQuotaWatch` /
     `assertProductionQuotaBackend`）也只存在于定义链里。新增 `exec/src/shell/resource-limits.ts`
     统一读取并**严格校验范围**（越界拒启）；in-namespace 包装器从只设 `ulimit -u` 泛化成成对
     下发 `-u/-n/-t/-f/-v`；shell 路由做 spawn 前准入 + 执行中采样；生产启动调用配额闸门。
     **内存刻意不自动接线**——rlimit 里只有 `RLIMIT_AS` 沾边，而地址空间不等于进程树常驻内存；
     `SANDBOX_MAX_MEMORY_MB` 定位为容器兜底并在启动日志说明归属，另给显式的
     `SANDBOX_MAX_ADDRESS_SPACE_MB`。控制面账本默认额度从写死 1024 MB 改取
     `SANDBOX_WORKSPACE_QUOTA_MB`。
  2. **R2**：传输截止改为「执行预算 + 15 秒有界回传余量」（仍有 24 小时硬上界），并与调用方
     `AbortSignal` 融合；exec 监听器把客户端提前断开转成请求的 `AbortSignal`（监听 `res` 的
     `close` + `writableFinished`，不是 `req` 的 `close`——后者在请求体正常读完时也会触发）。
  3. **R4**：新增两侧共用的 `@pi/contract/shell-payload`，越界 workdir 与非法字段执行前拒绝；
     `executor.spawnTargetFor()` 成为 run/start 共用的唯一拼装点；`stdoutMaxBytes` 按字节解释，
     截断落在字符边界。
  4. **R5**：每轮等待退出时摘 abort 监听器；轮询 50 ms 定频 → 200 ms 起、最多 2 s 有界退避。
  5. **R6**：Agent 侧后台输出缓冲有界（保留尾部，截断置 `lossy`）。
- **Action：** `contract/src/shell-payload.ts`（新）+ 导出与 package exports；
  `exec/src/shell/resource-limits.ts`（新）、`executor.ts`、`process-runner.ts`、`output-capture.ts`；
  `exec/src/isolation/{profile,build,render}.ts`；`exec/src/http/{internal-shell,router,app,node-listener}.ts`；
  `agent/src/runtime/providers/{exec-rpc,remote-shell,durable-subagent}.ts`；
  新增回归 `contract/test/shell-payload.test.ts`、`exec/test/internal-shell-wiring.test.ts`、
  `agent/tests/runtime/shell-deadline-buffer.test.ts` 与 `durable-subagent.test.ts` 的 R5 三例；
  `docker-compose.yml`、`.env.example`、`docs/{api,deployment,CHANGELOG,STATUS}.md`。
- **STATUS IDs：** C4、C7 的 notes 补记本次修复与**仍然开放**的部分；两行状态**不变**
  （`unknown` / `partial`）——本次只关闭了「限额和参数根本没接线」这个前提，
  整项验收标准未满足。R3 / R5 没有对应的 §32 条目，不强行套号。
- **验证：** 六套测试 + 各包类型检查 + 前端 build（pytest 206；contract 118；exec 411/2 skipped；
  agent 1339 / 0 cancelled；frontend 367 + build）。api-server 158 pass / **2 cancelled**
  （`file proxy id domain`，与本次无关，未修，不记为通过）。
  重建 agent / agent-worker / api-server / sandbox / sandbox-mcp 五个镜像并逐个核对运行容器的
  image id 已换新。真机：执行面探针 14/14（真实 HMAC + 真实 bwrap，含 20 秒任务、短预算超时、
  取消后无残留写入、workdir/stdin/env/多字节输出上限、越界拒绝 + 合法对照）；
  独立低阈值沙箱上的配额闸门（额度内成功 / 超限执行中被终止 / 越线后 fail-closed /
  另一 owner 不受影响）；四条启动 fail-closed + 一条正对照；经 BFF 的完整链路
  登录 → 建会话 → 带工具 Run `SUCCEEDED` → 进程 logs 有 `TICK` → SIGTERM → `cancelled` →
  四项跨租户 404 且本人 200。详见
  [证据](evidence/exec-resource-limits-and-shell-contract-2026-09-16.md)。

## 2026-09-16 — Run 队列按子任务深度分层，每层保留消费槽（R3）

- **Context：** 审查 R3（P1）：等待子 Run 的父 Run 会耗尽同队列全部消费槽。父子共用
  `agent-runs`，父任务前台等待子任务结果、不让出 BullMQ 槽位；N 个父 Run 占满 N 个槽之后
  子 Run 排不上，父 Run 又在等子 Run。提高并发无效——任何有限 N 都有同样的饱和条件。
- **Decision：** 新增 [ADR 0012](adr/0012-depth-layered-run-queues.md)，按 `subagent_depth`
  分层：深度 0 是 `agent-runs`、深度 n 是 `agent-runs-d{n}`，每个允许的深度一个队列、
  一个消费者、至少一个保留槽。`AGENT_WORKER_CONCURRENCY` 改为**总预算**，按「深层各留 1 个、
  其余给深度 0」切分（默认 4 / maxDepth 2 → 2 / 1 / 1）。**没有**实现通用的 park/replay——
  当前只有 `WAITING_APPROVAL` / `WAITING_INPUT` 两种停泊语义，复用会污染对外状态，
  新增完整 park/replay 涉及状态迁移、持久化 continuation 与模型重放，不该夹在缺陷修复里。
- **Action：** `agent/src/infrastructure/redis/run-queue-topology.ts`（新）、
  `agent/src/bootstrap/container-run-queue.ts`（新，从 `container.ts` 按职责拆出，
  容器 1_065 → 1_058，棘轮预算同步收紧）、`container.ts`、`worker-main.ts`、
  `subagent-spawn-service.ts`（`queue_name` 改为按深度派生，账本与实际目的地同源）；
  新增 `agent/tests/redis/run-queue-topology.unit.test.ts`、
  `agent/tests/bootstrap/run-queue-routing.unit.test.ts`、
  `agent/tests/redis/subagent-slot-starvation.integration.test.js`（真实 BullMQ）；
  `docker-compose.yml`、`.env.example`、`architecture.md`、`deployment.md`、CHANGELOG。
- **STATUS IDs：** **无对应 §32 条目**。R3 不属于现有任何一行的验收标准，按执行方案
  「不得强行套号」处理，只在 ADR、CHANGELOG 与证据里记录。G2（Worker 重启）的 release gate
  未按分层拓扑重跑，状态不变。
- **验证：** 六套测试全绿（pytest 206；contract 118；exec 411/2 skipped；agent 1357；
  api-server 160；frontend 367 + build）+ 各包类型检查 + `docker compose config -q`。
  **先复现再修**：真实 BullMQ 上基线形态 6 秒内 0 子作业被消费、0 父作业完成；分层后同一
  预算下 188 ms 全部完成；深度 0→1→2 的等待链自底向上排空。真机：重建 agent 镜像换容器后
  worker 打出 `budget=4 d0:agent-runsx2 d1:agent-runs-d1x1 d2:agent-runs-d2x1`，`/ready` 200；
  经 BFF 让模型用 `subagent` 工具，父子 Run 均 `SUCCEEDED`，子 Run 的 `subagent_depth=1`、
  `queue_name=agent-runs-d1`，Redis 的 `{bull}:agent-runs-d1:id=1` 证明真的投到了那一层；
  回滚闸门在 d2 有存量时拒启并点名队列与条数，排空后同一配置正常启动（正对照）。
  过程中 fail-closed 校验抓到本机 `.env` 的 `AGENT_WORKER_CONCURRENCY=1`
  （旧代码下 depth-2 链路在这台机器上从来不可能跑通），以及我自己把预算校验放进
  投递方共用路径导致 HTTP 面拒启的设计错误——已拆成「路由」与「槽位分配」两步，
  两处都记在证据里。详见
  [证据](evidence/run-queue-depth-layering-2026-09-16.md)。

## 2026-09-16 — 修复后复核 F1–F3：MCP 执行入口接限额；缩深闸门读失败拒启并查账本

- **Context：** [修复后复核](reviews/2026-09-16-agent-worker-sandbox/follow-up-review.md)确认三处
  阻塞缺口：R1/R2 只接到了内部 Shell 路由，外部 MCP 的 `shell/execute`、`python/execute` 仍是
  裸执行器（F1）；R3 的 Worker 缩深闸门把 Redis 读失败当成空队列（F2），且只查 Redis、不查
  MySQL 中停在 WAITING_APPROVAL / WAITING_INPUT 的超深子 Run（F3）。另有四条口径问题：
  `SANDBOX_MAX_MEMORY_MB` 被写成「内存上限」、「提到 6 维持原吞吐」、旧镜像回滚依赖不存在的闸门、
  缩深步骤里「先把 `AGENT_SUBAGENT_MAX_DEPTH` 降到 0」会同时改掉消费拓扑。
- **Decision：** 限额 / 配额准入与采样 / 取消融合下沉到 `exec/src/shell/guarded-execution.ts`，
  两个执行入口共用，鉴权仍各自独立；窄桥 `timeout_seconds` 上限取桥上限与执行预算的较小者。
  闸门拆到 `agent/src/bootstrap/worker-drain-gate.ts`：只有 key 不存在才算 0，读异常 / 不认识的
  key 类型 / 查库失败一律拒启；同时查 `runs` 中超出目标深度的非终态 Run；前移到恢复扫描、
  cron、outbox 与消费者之前。决策（分层 + 保留槽）不变，ADR 0012 追加修订记录而非改写正文。
- **Action：** exec `internal-shell.ts` / `internal-mcp.ts` / `app.ts`；agent `worker-main.ts`；
  新增 `exec/test/internal-mcp-limits.test.ts`、`agent/tests/bootstrap/worker-drain-gate.unit.test.js`；
  `deployment.md`、`sandbox-mcp.md`、ADR 0012、README、CHANGELOG、STATUS（C4 备注）、复核文档状态说明。
- **STATUS IDs：** C4 只补备注（MCP 入口同步接线），状态仍 `unknown`；R3 无对应 §32 条目。
- **验证：** 新增回归修复前失败（exec 7 例、agent 4 例）、修复后通过。pytest 206、contract 118、
  api-server 160、frontend 367 + build、各包类型检查通过；exec 4 例、agent 5 例失败，在同一
  容器环境的 `a309874a` 干净 worktree 上同样失败（无 bwrap / root capabilities / 插件树加载），
  不记为通过。重建 agent、sandbox、sandbox-mcp 镜像并核对运行容器已换新。真机：外部 MCP
  路径 9/9（rlimit 生效、nproc 拒绝 + 额度内对照、Python 入口、超时拒绝 + 对照、断开后无写入
  无残留进程 + 不断开对照）；真实账本上插入 depth 2 的 WAITING_APPROVAL 子 Run，Redis 队列为空
  时缩深拒启、Run 终态后同配置放行，探针数据已清理；经 BFF 完整链路 12/12。本机 `.env` 的
  `MODEL_ID=deepseek-v4-flash` 已不在模型目录，链路验证期间临时覆盖、验证后恢复。详见
  [证据](evidence/follow-up-f1-f3-2026-09-16.md)。
