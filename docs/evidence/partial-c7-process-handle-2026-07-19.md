# Partial closeout — C7 Process Handle single-instance (2026-07-19)

**Branch:** `codex/plan-acceptance`  
**STATUS ID:** C7  
**Verdict:** **`done`** for single-instance formal Process Handle. Multi-host reclaim remains review-deferred residual (honest LOST on this host only).

## Shipped path

- `ProcessManager.start` with durable `die_with_parent=False`, `as_pid_1=True`
- Formal dual-write `process_executions` via `FormalProcessDualWriter`
- Owned get / stream read / signal kill; kill without live memory → `unavailable` (no multi-host invent)
- Orphan recovery → LOST + identity-verified reclaim (G7 evidence)

## Offline suite

```bash
.venv/bin/python -m pytest \
  tests/test_formal_process_handle.py \
  tests/test_formal_orphan_recovery.py \
  tests/test_process_identity.py \
  tests/test_bubblewrap_isolation.py \
  tests/test_internal_process_contract.py -q
# 30 passed
```

**New:** `tests/test_formal_process_handle.py` — real ProcessManager start/status/read/kill + formal dual-write + durable launch flags + cross-tenant fail-closed.

## Residual (non-blocking)

Cross-container / multi-host process reclaim — see `docs/review-deferred-items.md`. STATUS must not claim multi-host attach.

## Subagent

`019f79ce-471a-7f41-849d-3c22b0bfffbc`
