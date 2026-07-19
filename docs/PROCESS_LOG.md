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
