# SDK compatibility suite

Black-box / contract tests for `@earendil-works/pi-coding-agent` as consumed by `api-server`.

- **No live LLM calls**
- Runner: Node built-in test runner (`node:test`)

## Run (current pin)

From repo root:

```bash
npm ci --prefix api-server
npm ls --prefix api-server @earendil-works/pi-coding-agent
node --test api-server/tests/*.test.js api-server/tests/sdk-compat/*.test.js
```

Or from `api-server/`:

```bash
npm test
```

## Run against a candidate version

See [docs/runbooks/sdk-upgrade.md](../../../docs/runbooks/sdk-upgrade.md).

```bash
npm install --prefix api-server @earendil-works/pi-coding-agent@<version> --save-exact
node --test api-server/tests/sdk-compat/*.test.js
```

## Layout

| File | Contract |
|------|----------|
| `message-helpers.test.js` | Agent Run history restore helpers |
| `tool-overrides.test.js` | Sandbox tools override host built-ins / allowlist |
| `session-api.test.js` | SessionManager branch/custom entries + auth factories |
| `extension-failsafe.test.js` | Extension `tool_call` block / `tool_result` rewrite |
| `cancel-resume.test.js` | Disconnect cancel-active + multi-turn resume helpers |
| `sdk-surface.test.js` | Exact pin, MIT, required exports |
| `sse-event-map.test.js` | SDK events → BFF SSE golden + shared fixture |
| `fixtures/sdk-to-sse-golden.json` | Golden vectors for `mapSdkEventToSse` |

Shared browser/BFF SSE types: `tests/fixtures/sse_events.json`.
