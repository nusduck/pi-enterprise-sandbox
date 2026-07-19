# Documentation map

This directory is the **active** documentation set for Pi Enterprise Sandbox.
Root `plan.md` is the frozen refactor baseline and final acceptance criteria.

## Authority order

When documents disagree, use this order:

1. **`plan.md` (repo root)** — locked architecture decisions + §32 final acceptance.
2. **ADRs in `docs/adr/`** — recorded decisions that refine plan without contradicting it.
3. **Descriptive active docs** — `architecture.md`, `api.md`, `deployment.md`, `development.md`, `webui.md`.
4. **`docs/STATUS.md`** — living gap board vs `plan.md` §32 (must match code reality).
5. **`docs/evidence/`** — dated gate runs; evidence supports STATUS, never replaces it.
6. **Code** — if STATUS and code diverge, code wins and STATUS must be fixed in the same change set.

`docs/review-deferred-items.md` is a **non-blocking debt** board. It must not hide open P0 acceptance items (those belong in STATUS only).

## Document roles

| Path | Role | Update rule |
|------|------|-------------|
| `../plan.md` | Normative baseline + §32 acceptance | Rare; treat as frozen unless product re-scopes |
| `architecture.md` | Current system description | Update when merged behavior changes |
| `api.md` / `webui.md` / `deployment.md` / `development.md` | Operator & developer guides | Same PR as the behavior they describe |
| `STATUS.md` | **Only** progress board vs plan §32 | Same commit as the work that changes open/done |
| `PROCESS_LOG.md` | Chronological acceptance process notes | Append-only on this branch |
| `evidence/*` | Dated live-gate / integration proof | Append new files; do not rewrite past verdicts |
| `review-deferred-items.md` | Non-blocking follow-ups | Never park severe P0 here |
| `adr/*` | Architecture Decision Records | New ADR when a plan-compatible decision is locked |
| `runbooks/*` | Operational procedures | Update when ops steps change |

## Active ADRs

| ADR | Topic |
|-----|-------|
| [0001](./adr/0001-pi-coding-agent-sdk.md) | Adopt upstream `pi-coding-agent` SDK |
| [0004](./adr/0004-session-persistent-tmp.md) | Agent Session–private persistent `/tmp` |

## How to close an acceptance item

1. Implement and test against the relevant `plan.md` §32 bullet.
2. Update the matching row in `STATUS.md` (`open` → `done` / `partial` / `waived`).
3. Link evidence: test path, `docs/evidence/...` section, or commit SHA.
4. Append a short note to `PROCESS_LOG.md` when the change is part of the acceptance program.
5. Do **not** mark the refactor complete while any §32 row is `open` or `partial` unless explicitly waived with rationale.
