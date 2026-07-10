# Implementation plan

- [x] Inventory feature parity between Node `handleChat` and `sandbox/agent`.
- [x] Close gaps: tools, message restore, approval, trace, artifact, cancellation.
- [x] Add explicit config-selected Node proxy / Python agent route.
- [x] Add shared SSE contract fixtures and parity tests.
- [x] Run multi-turn, tool, approval, artifact, error, abort through selected route.
- [x] Document rollback; only then consider Python-first as production default.

## Validation commands

```bash
uv run pytest tests/test_agent_module.py tests/test_multi_turn_history.py tests/test_approval.py -v
uv run pytest tests/test_isolation_and_delivery.py tests/test_integration.py -v
node --check api-server/**/*.js 2>/dev/null || true
uv run pytest tests/ -q --tb=short
node --test api-server/tests/agent-runtime-config.test.js
```

## Notes

- Default remains `AGENT_RUNTIME=node` until operators explicitly set `python`.
- Rollback: `AGENT_RUNTIME=node` + restart api-server; no frontend redeploy.
