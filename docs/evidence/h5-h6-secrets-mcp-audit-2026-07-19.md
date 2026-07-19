# Evidence: H5 secrets + H6 MCP data-plane (structural) — 2026-07-19

**Branch:** `codex/plan-acceptance`  
**STATUS IDs:** H5, H6  
**Verdict:** **`partial`** for both — offline/unit structural proof only.  
**Do not treat as production secrets or deployment policy sign-off.**

## What was proven

### Unit suite (offline)

```text
cd agent && node --test \
  tests/bootstrap/secret-and-mcp-policy.unit.test.js \
  tests/pi/mcp-seam.unit.test.js \
  tests/pi/platform-event-projector.unit.test.js \
  tests/tool-payload-sanitizer.test.js \
  tests/outbox/outbox-repository.unit.test.js \
  tests/skill-paths.test.js
→ 57 pass / 0 fail
```

Coverage includes:

- MCP config rejects plaintext secrets; env `secretRef` / `authTokenRef` only
- MCP results + progress redacted before Pi (`createMcpExtensionsOverride`)
- Platform event projector redacts Bearer / DSN userinfo / sensitive keys
- Tool payload sanitizer + skill path host redaction
- Outbox `last_error` + `status_reason` share `redactSecretText` (Bearer, `token=`, DSN userinfo)
- Structural: sandbox-bridge exact 10 non-SQL tools; no MySQL client in extensions; MCP modules = pi-mcp-adapter only

### Gap closed in this evidence window

1. **`redactSecretText` replace callback bug** — patterns without a capture group passed the match **offset** (number) as the “key”, producing nonsense like `8=[REDACTED]` for credential URIs and mishandling Bearer-style replacements. Fixed: only string captures become `key=[REDACTED]`.
2. **Persistence sanitizers lagged model/event redaction** — `sanitizeStatusReason` / `sanitizeOutboxError` previously used ad-hoc regexes that left bare Bearer tokens and `token=` values intact in outbox errors. Both now call shared `redactSecretText` then collapse DSN schemes.

### Greps (summary)

| Check | Result |
|-------|--------|
| Sandbox-bridge SQL/DSN client | Absent |
| Extension `name: 'sql'\|'execute_sql'|…` tools | Absent |
| Second MCP client (`McpConnectionManager`, `@modelcontextprotocol/sdk`, raw `fetch` in mcp/) | Absent |
| Password/console logging in `infrastructure/mcp` | Absent |

## What is still open (blocks `done`)

| Gap | Why it matters |
|-----|----------------|
| Production / staging log sampling | H5 requires secrets not in real logs — unit redaction ≠ ops proof |
| Durable event row sampling | MySQL `run_events`, tool_execution, outbox under secret-bearing MCP load |
| Deployment MCP allowlist audit | H6 needs ops confirmation that only controlled MCP servers hold business DB credentials |
| Live adversarial gate | Model must not gain a non-MCP SQL/DSN tool at runtime |

## Recommended STATUS

Keep **H5 = partial**, **H6 = partial** with notes pointing at this evidence file and the unit suite above. Promote to `done` only after production sampling + deployment policy checklist pass.
