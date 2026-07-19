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
