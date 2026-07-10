# Implementation plan

- [x] Inventory Node module globals in `api-server/services/sandbox-client.js` and `api-server/sandbox-tools.js` (and call sites).
- [x] Add Node tests that overlap two chat contexts and prove distinct trace/session/approval routing.
- [x] Replace globals with per-request factories; update `handleChat` wiring.
- [x] Add Python tests for atomic same-session admission and cancel/complete races.
- [x] Track subprocess groups; implement real cancellation/reaping/terminal status.
- [x] Wire browser/SSE disconnect to cancel or documented detach policy.
- [x] Run Node checks + Python concurrency/execution/multi-turn suites.

## Validation commands

```bash
node --check api-server/services/sandbox-client.js
node --check api-server/sandbox-tools.js
node --test api-server/tests/request-context.test.js
# prefer project venv if `uv` is not on PATH:
.venv/bin/python -m pytest tests/test_execution_manager.py tests/test_multi_turn_history.py -v
.venv/bin/python -m pytest tests/ -q --tb=short
```
