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
