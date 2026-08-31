# Documentation map

This directory is the **active** documentation set for Pi Enterprise Sandbox.
`plan.md` is the frozen refactor baseline and final acceptance criteria.

- [`module-layout.md`](./module-layout.md) — conventional source roots per service (agent / api-server / exec / frontend / contract)
- [`design/waves/HANDOFF.md`](./design/waves/HANDOFF.md) — `refactor/dsh-rebuild` 当前进度与剩余项
- [`artifact-module.md`](./artifact-module.md) — Artifact domain boundary, frozen contracts, and cross-conversation Import MVP
- [`sandbox-mcp.md`](./sandbox-mcp.md) — independently deployed Sandbox Streamable HTTP MCP facade
- [`reviews/*`](./reviews/) — dated review / dead-code inventory reports (working papers; conclusions land in `review-deferred-items.md` or code, then the report is archived to `archive/reviews/`)

## Authority order

When documents disagree, use this order:

1. **`plan.md`** — locked architecture decisions + §32 final acceptance.
2. **ADRs in `adr/`** — recorded decisions that refine plan without contradicting it.
3. **Descriptive active docs** — `architecture.md`, `api.md`, `deployment.md`, `development.md`, `webui.md`.
4. **`STATUS.md`** — living gap board vs `plan.md` §32 (must match code reality).
5. **`evidence/`** — dated gate runs; evidence supports STATUS, never replaces it.
6. **Code** — if STATUS and code diverge, code wins and STATUS must be fixed in the same change set.

`review-deferred-items.md` is a **non-blocking debt** board. It must not hide open P0 acceptance items (those belong in STATUS only).

AI agents must read [`../AGENTS.md`](../AGENTS.md) before editing anything in this
directory — it defines the update rules, forbidden actions, and the pre-commit
documentation checklist summarized below.

Out-of-map directories:

- `deliverables/` — gitignored local deliverables; not part of this repo's doc set.

## Document roles

| Path | Role | Update rule |
|------|------|-------------|
| `plan.md` | Normative baseline + §32 acceptance | Rare; treat as frozen unless product re-scopes |
| `CHANGELOG.md` / `CONTRIBUTING.md` | Project history and contribution guide | Keep links aligned with the active tree |
| `architecture.md` | Current system description | Update when merged behavior changes |
| `api.md` / `webui.md` / `deployment.md` / `development.md` | Operator & developer guides | Same PR as the behavior they describe |
| `STATUS.md` | **Only** progress board vs plan §32 | Same commit as the work that changes open/done |
| `PROCESS_LOG.md` | Chronological acceptance process notes | Append-only on this branch |
| `evidence/*` | Dated live-gate / integration proof | Append new files; do not rewrite past verdicts |
| `review-deferred-items.md` | Non-blocking follow-ups | Never park severe P0 here |
| `adr/*` | Architecture Decision Records | New ADR when a plan-compatible decision is locked |
| `runbooks/*` | Operational procedures | Update when ops steps change |
| `security/*` | Security profile provenance and operator notes | Update with the related runtime profile |
| `archive/reviews/*` / `archive/discussions/*` | Historical reviews and unapproved design discussions | Never cite as current state without re-verification |

## Active ADRs

| ADR | Topic |
|-----|-------|
| [0001](./adr/0001-pi-coding-agent-sdk.md) | Adopt upstream `pi-coding-agent` SDK — **Superseded by 0007** |
| [0004](./adr/0004-session-persistent-tmp.md) | Agent Session–private persistent `/tmp` |
| [0005](./adr/0005-pi-session-jsonl-persistence.md) | Pi session JSONL persistence — **Superseded by 0007 D5** |
| [0006](./adr/0006-user-skill-enablement-gate.md) | User skill enablement gate |
| [0007](./adr/0007-agent-runtime-rebuild-on-dsh.md) | Rebuild agent runtime on DeepSeek Harness |
| [0008](./adr/0008-sandbox-isolation-and-fs-seam-redesign.md) | Exec isolation and FS seam（取代 Python sandbox） |

**0002 and 0003 are intentionally absent.** They were 07-12 task specs
(`0002-backend2712`, `0003-fronted0712`) whose decisions `plan.md` superseded;
they were removed on 2026-07-19 in `7370220d`. The numbers are retired — a new
ADR takes the next unused number (**0009**). Recover the originals from git
history if you need the historical reasoning; do not cite them as current.

## How to close an acceptance item

1. Implement and test against the relevant `plan.md` §32 bullet.
2. Update the matching row in `STATUS.md` (`open` → `done` / `partial` / `waived`).
3. Link evidence: test path, `docs/evidence/...` section, or commit SHA.
4. Append a short note to `PROCESS_LOG.md` when the change is part of the acceptance program.
5. Do **not** mark the refactor complete while any §32 row is `open` or `partial` unless explicitly waived with rationale.
