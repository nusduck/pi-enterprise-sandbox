# SDK compatibility suite

Black-box / contract tests for `@earendil-works/pi-coding-agent` as consumed by
the Agent service.

- **No live LLM calls**
- Runner: Node built-in test runner (`node:test`)

## Run (current pin)

From repo root:

```bash
npm ci --prefix agent
npm ls --prefix agent @earendil-works/pi-coding-agent
node --test agent/tests/sdk-compat/*.test.js
```

Or from `agent/`:

```bash
npm test
```

## Run against a candidate version

See [docs/runbooks/sdk-upgrade.md](../../../docs/runbooks/sdk-upgrade.md).

```bash
npm install --prefix agent @earendil-works/pi-coding-agent@<version> --save-exact
node --test agent/tests/sdk-compat/*.test.js
```

## Layout

| File | Contract |
|------|----------|
| `message-helpers.test.js` | Agent Run history restore helpers |
| `session-api.test.js` | SessionManager branch/custom entries + auth factories |
| `extension-failsafe.test.js` | Extension `tool_call` block / `tool_result` rewrite |
| `sdk-surface.test.js` | Exact pin, MIT, required exports |

Pi event projection is separately covered by
`agent/tests/pi/platform-event-projector.unit.test.js`; shared browser/BFF
SSE types live in `tests/fixtures/sse_events.json`.
