# Plan acceptance process log

Append-only log for branch `codex/plan-acceptance`.  
Each entry should say **what changed**, **why**, and **which STATUS IDs** it affects.

---

## 2026-07-19 — Branch fork and WIP checkpoint

- **Action:** Created branch `codex/plan-acceptance` from `codex/pi-enterprise-refactor` (`8d0dad41`) and committed the full uncommitted working tree as `6d25783c`.
- **Why:** Preserve refactor follow-up work, then accept against `plan.md` with reviewable process commits instead of continuing on a dirty tree.
- **Excluded:** `.env`, local `.release-gate-*` runtime directories (gitignored).
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
