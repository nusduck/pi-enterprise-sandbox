# Partial closeout — B3 residual Run Map audit (2026-07-19)

**Branch:** `codex/plan-acceptance`  
**STATUS ID:** B3  
**Verdict:** **`done`** — residual transient Maps inventoried and proven non-authoritative.

## Proof

Structural walk of shipped `agent/src` via `agent/tests/bootstrap/no-authoritative-run-map.unit.test.js`:

- No `class RunManager`, `this.runs = new Map`, module-level `new Map(`, or process-global run authority
- **11 residual `new Map(` sites** whitelisted as instance/local/literal only (dedupe, steer working set, MCP registry, JSONL parent graph, trace materialize helpers, HMAC keyring)
- Fail-closed: unknown Map sites or module-scope Maps fail the suite
- Legacy `agent/services/approval-waiter` Maps stay outside `agent/src` production graph

## Suite

```bash
cd agent && node --test tests/bootstrap/no-authoritative-run-map.unit.test.js
# 5 pass
```

## Subagent

`019f79ce-4719-7dd1-8444-b22af9d390d1`
