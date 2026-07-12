# Implement — B7

## Checklist

- [x] Registry schema + seed known models
- [x] chat-runner/session create consumes registry
- [x] Remove hard-coded context/max tokens as sole source
- [x] Record usage on run
- [x] Tests: capability switch / wrong model disabled

## Validation

```bash
node --test agent/tests/model-registry.test.js
node --test agent/tests/*.test.js
uv run --with pytest python -m pytest tests/test_agent_run_usage.py tests/test_database_baseline.py -q
```

## Agent Run Notes

### What shipped

1. **Enterprise Model Registry** (`agent/services/model-registry.js`)
   - ADR §4.10 fields: provider, model_id, api_protocol, input_modalities,
     context_window, max_output_tokens, supports_tool_call,
     supports_developer_role, supports_reasoning, thinking_levels, pricing, enabled
   - Seed catalog + optional `config/agent/model-registry.json` / `MODEL_REGISTRY_PATH`
   - Fail-closed for unknown and disabled models
   - Env overrides (`MODEL_ID`, `MODEL_CONTEXT_WINDOW`, `MODEL_MAX_TOKENS`) remain
     backward-compatible but are applied *on top of* registry entries

2. **Session create hot path** (`agent/chat-runner.js`)
   - `makeModel()` / `resolveActiveModel()` read registry capabilities
   - Agent run + agent session bind the resolved `model_id`
   - Session SSE event includes model capability snapshot

3. **Run usage persistence**
   - Migration `0006_agent_run_usage` + expand helper `migrate_agent_run_usage_schema`
   - `agent_runs.usage` JSON (tokens + cost + model_id + provider)
   - `POST /agent-runs/{id}/complete` accepts `usage` + `model_id`
   - Turn end aggregates assistant usage from SDK messages and records cost from pricing

4. **Tests**
   - `agent/tests/model-registry.test.js` — capability switch, disabled model, usage/cost
   - `tests/test_agent_run_usage.py` — schema + complete_run usage recording

### Out of scope (per task)

- MCP / steer
- Model fallback routing UI
- DB-admin CRUD for models (config/seed is the source this iteration)

### Rollback

- Revert chat-runner to env-only `makeModel` constants
- Drop or ignore `agent_runs.usage` column (expand-only; safe to leave)
- Unset `MODEL_REGISTRY_PATH` to fall back to in-process seed
