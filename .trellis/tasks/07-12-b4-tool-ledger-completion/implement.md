# Implement — B4

## Checklist

- [x] Audit all tool paths for ledger gaps
- [x] Wire process/skill/artifact/mcp paths
- [x] Idempotency key + unknown state handling
- [x] edit multi-match + apply_patch + diff
- [x] Tests: ledger completeness, retry idempotency, edit reject

## Validation

```bash
uv run python -m pytest tests/ -q --tb=short -k 'tool or ledger or edit or patch'
node --test agent/tests/*.test.js agent/tests/sdk-compat/tool-overrides.test.js
```

## Agent Run Notes

### What landed

1. **Schema (ADR §4.4)** — Migration `0004_tool_ledger_fields` + expand helper
   `migrate_tool_ledger_schema` add: `session_id`, `conversation_id`,
   `workspace_id`, `tool_name`, `arguments`, `execution_id`, `started_at`,
   `finished_at`, `result_summary`, `error`, `result_json`.

2. **Repository / API** — Full prepare → waiting_approval → executing → terminal
   lifecycle; sticky terminal (esp. `unknown`); `GET /tool-executions/{id}`,
   list by `run_id` / `idempotency_key`; terminal body stores `result_json` for
   lost-response replay. `can_auto_retry` is false for executing / waiting /
   terminal.

3. **Agent wrapExecute** — All sandbox tools (read/write/edit/apply_patch/bash/
   process_*/artifact/ls/find/grep) prepare ledger rows with idempotency keys;
   write-class tools mark waiting_approval during policy; then executing; then
   terminal with cached result. Retry with same key replays without re-running
   side effects.

4. **Skill tools** — `createSkillTools` accepts sandbox `client` and wraps
   skill_install/edit/reload with the same ledger lifecycle.

5. **Edit hardening (ADR §9)** — Sandbox `FileEditService` +
   `POST .../files/edit` and `.../files/apply_patch`: unique old_string required;
   multi-match returns `match_count` + `match_lines`; unified diff + before/after
   SHA-256; optional `expected_hash` race check. Agent `edit` / new `apply_patch`
   tools call these endpoints.

6. **MCP** — Not building full registry (B5). Existing MCP file tools remain;
   ledger hooks exist for agent-side tools. No new MCP registry work.

### Out of scope (B5/B6)

- MCP Tool Registry / discovery
- Steer / budget / follow-up

### Verification (this run)

```text
uv run python -m pytest tests/ -q --tb=short -k 'tool or ledger or edit or patch or agent_events or database_baseline or persistence'
→ 61 passed, 4 skipped

node --test agent/tests/tool-ledger.test.js agent/tests/sdk-compat/tool-overrides.test.js agent/tests/process-tools.test.js agent/tests/request-context.test.js
→ all passed
```
