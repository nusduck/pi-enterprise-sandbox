# Runbook: Upgrade `@earendil-works/pi-coding-agent`

Use this when bumping the pinned SDK version in `api-server`. Do **not** widen the pin to a semver range (`^` / `~`).

Related: [ADR 0001](../adr/0001-pi-coding-agent-sdk.md), compat suite `api-server/tests/sdk-compat/`.

## Preconditions

- [ ] Independent task/PR (no mixed feature work).
- [ ] Note current pin: `npm ls --prefix api-server @earendil-works/pi-coding-agent`
- [ ] Read upstream changelog / release notes for the candidate version.
- [ ] Confirm license remains MIT (or re-open ADR if not).
- [ ] Confirm `engines.node` still matches runtime images (SDK currently declares `>=22.19.0`).

## 1. Local matrix (old vs candidate)

From repo root:

```bash
# Baseline (current pin)
npm ci --prefix api-server
npm ls --prefix api-server @earendil-works/pi-coding-agent
node --test api-server/tests/*.test.js api-server/tests/sdk-compat/*.test.js
```

Install candidate (example `0.81.0` — replace with real target):

```bash
# Exact version only
npm install --prefix api-server @earendil-works/pi-coding-agent@0.81.0 --save-exact
npm ls --prefix api-server @earendil-works/pi-coding-agent

# Compat + unit suite (no live LLM)
node --test api-server/tests/*.test.js api-server/tests/sdk-compat/*.test.js

# Syntax
find api-server -name '*.js' -type f ! -path '*/node_modules/*' -print0 \
  | xargs -0 -n1 node --check
```

Optional: stash `sdk-compat` failure output as PR artifacts for diff review.

### What the suite covers (no live LLM)

| Check | File |
|-------|------|
| Message extract / history helpers | `message-helpers.test.js` |
| Sandbox tool names vs chat allowlist | `tool-overrides.test.js` |
| SessionManager branch/custom + auth shape | `session-api.test.js` |
| Extension tool_call block / tool_result | `extension-failsafe.test.js` |
| Cancel-on-disconnect + multi-turn resume | `cancel-resume.test.js` |
| SDK pin + VERSION export | `sdk-surface.test.js` |
| SDK event → BFF SSE golden vectors | `sse-event-map.test.js` |

If the candidate breaks only golden SSE mapping, update `api-server/tests/sdk-compat/fixtures/sdk-to-sse-golden.json` **only after** confirming intentional upstream event changes and BFF still matches `tests/fixtures/sse_events.json`.

## 2. Gray check (staging)

1. Build **Agent/api-server image** with the candidate pin (do not change production compose defaults in the same PR if possible).
2. Deploy to staging with a single canary replica if available.
3. Smoke (manual or scripted against staging):
   - Multi-turn chat (history restore)
   - `write` + `submit_artifact` → UI `file_ready` + download
   - High-risk `bash` → `approval_required` → approve/reject
   - Client disconnect mid-run → sandbox cancel-active (no orphan runaway)
4. **Do not** run two agent images against the **same** in-flight conversation/run for migration validation (no dual-exec of one Run). Short-lived parallel images for version smoke are OK on **separate** sessions.

## 3. Session migration notes

Current enterprise persistence:

- Conversation messages + `sandbox_session_id` → Sandbox DB
- SDK `SessionManager.inMemory()` → **not** durable across api-server restarts

Therefore most SDK bumps need **no conversation schema migration**.

When upstream changes matter:

| Change | Action |
|--------|--------|
| `CURRENT_SESSION_VERSION` or JSONL entry shapes (if you start persisting SDK sessions) | Copy sample sessions; run `parseSessionEntries` / open-migrate offline; keep rollback image |
| Tool result / event field renames | Update `sdk-sse-map.js` + golden fixtures; keep BFF SSE types stable for frontend |
| Default built-in tools reintroduced | **Block release** until allowlist + customTools still override host I/O |
| Model / auth storage format | Verify `AuthStorage` + `ModelRegistry` still accept LLMIO key path |

If durable SDK session files are introduced later: migrate by **copy-then-validate**, keep previous Agent image for rollback, and never dual-write the same session from two versions.

## 4. PR checklist

- [ ] `api-server/package.json` has **exact** version (e.g. `"0.81.0"`, not `^0.81.0`)
- [ ] `api-server/package-lock.json` committed and matches (`npm ci --prefix api-server`)
- [ ] ADR inventory updated if imports/events change (`docs/adr/0001-pi-coding-agent-sdk.md`)
- [ ] Compat suite green in CI (`node-api` job)
- [ ] Staging gray check notes in PR body
- [ ] No production default flips unrelated to the pin (e.g. `AGENT_RUNTIME`)

## 5. Image rollback

If production misbehaves after release:

1. **Roll back the api-server/Agent image** to the previous digest/tag (compose/k8s).
2. Confirm `npm ls` inside the rolled-back image shows the previous pin.
3. Leave Sandbox DB as-is (conversation text remains valid).
4. Do **not** delete sandbox sessions solely because of an Agent rollback; multi-turn reuse still applies.
5. File a follow-up with compat suite gaps that missed the regression.

Rollback does not require re-running LLM evaluation if the previous image was known-good; prioritize restore of SSE/tool path.

## 6. After success

- Update the “Pinned version” row in ADR 0001.
- Archive any temporary candidate `node_modules` experiments.
- If exit criteria in the ADR are approached (license, unfixable API gap, maintenance stop), open a **new** ADR rather than expanding a fork silently.
