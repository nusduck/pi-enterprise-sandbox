# P1 H5 / H6 offline closeout (2026-07-19)

**Branch:** `codex/plan-acceptance`  
**STATUS IDs:** H5, H6  
**Verdict:** Offline dual-path redaction **strengthened**; remain **`partial`** — production/staging sampling and deploy allowlist still open.

## Offline gap closed

| Gap | Fix |
|-----|-----|
| Dual pattern drift: projector covered `access_token` / `refresh_token` / `client_secret` / `Cookie` / `sk-*` while durable `redactSecretText` did not | Expanded `SECRET_PATTERNS` in `agent/lib/text-redaction.js` |
| Redis log sanitizer ad-hoc only | `sanitizeRedisLogText` calls `redactSecretText` first |
| Drift tests | Extended secret-and-mcp-policy + connection-error-guard units |

H6 structural: MCP via `pi-mcp-adapter` only; sandbox-bridge non-SQL tools; no extension SQL/DSN clients — still green.

## Production sampling (blocks `done`)

- [ ] App logs after secret-bearing MCP fixture  
- [ ] MySQL `run_events` / tool_execution / outbox `last_error` samples  
- [ ] MCP server allowlist deploy audit  

## Suite

```text
agent secret-and-mcp + mcp-seam + projector + redis guard + sanitizer + outbox
→ green (parent re-run in p1-unit-gates.log)
```

## Subagent

`019f79b3-0d44-7931-970c-40f61649bd3b` (P1 H5/H6 remaining gaps).
