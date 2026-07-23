# Runbook: Upgrade `@earendil-works/pi-coding-agent`

Use this when bumping the pinned SDK version in `agent/`. Do **not** widen the pin to a semver range (`^` / `~`). The BFF (`api-server/`) must **not** depend on the SDK.

Related: [ADR 0001](../adr/0001-pi-coding-agent-sdk.md), compat suite `agent/tests/sdk-compat/`, SSOT `runtime-versions.json`.

## Preconditions

- [ ] Independent task/PR (no mixed feature work).
- [ ] Note current pin: `npm ls --prefix agent @earendil-works/pi-coding-agent` (must match `runtime-versions.json` → `pi_sdk`)
- [ ] Read upstream changelog / release notes for the candidate version.
- [ ] Confirm license remains MIT (or re-open ADR if not).
- [ ] Confirm `engines.node` still matches runtime images and `runtime-versions.json` → `node.engines` (SDK 0.80.3 declares `>=22.19.0`; repo engines are `>=22.19.0 <23`).

## 1. Local matrix (old vs candidate)

From repo root:

```bash
# Baseline (current pin)
npm ci --prefix agent
npm ls --prefix agent @earendil-works/pi-coding-agent
node --test agent/tests/*.test.js agent/tests/sdk-compat/*.test.js
```

Install candidate (example `0.81.0` — replace with real target):

```bash
# Exact version only
npm install --prefix agent @earendil-works/pi-coding-agent@0.81.0 --save-exact
npm ls --prefix agent @earendil-works/pi-coding-agent

# Compat + unit suite (no live LLM)
node --test agent/tests/*.test.js agent/tests/sdk-compat/*.test.js

# Syntax
find agent -name '*.js' -type f ! -path '*/node_modules/*' -print0 \
  | xargs -0 -n1 node --check
```

Optional: stash `sdk-compat` failure output as PR artifacts for diff review.

### What the suite covers (no live LLM)

| Check | File |
|-------|------|
| Message extract / history helpers | `message-helpers.test.js` |
| SessionManager branch/custom + auth shape | `session-api.test.js` |
| Extension tool_call block / tool_result | `extension-failsafe.test.js` |
| SDK pin + VERSION export | `sdk-surface.test.js` |
| Pi event → durable platform-event projection | `agent/tests/pi/platform-event-projector.unit.test.js` |

If an SDK event shape changes, update the projector and its unit tests only after confirming that the durable platform-event and BFF SSE contracts remain compatible with `tests/fixtures/sse_events.json`.

## 2. Gray check (staging)

1. Build **Agent image** with the candidate pin (do not change production compose defaults in the same PR if possible).
2. Deploy to staging with a single canary replica if available.
3. Smoke (manual or scripted against staging):
   - Multi-turn chat (history restore)
   - `write` + `submit_artifact` → UI `file_ready` + download
   - Workspace `bash` 直接执行，不产生 `approval_required`
   - High-risk external side-effect tool → `approval_required` → approve/reject
   - Client disconnect mid-run → sandbox cancel-active (no orphan runaway)
4. **Do not** run two agent images against the **same** in-flight conversation/run for migration validation (no dual-exec of one Run). Short-lived parallel images for version smoke are OK on **separate** sessions.

## 3. Session migration notes

Current enterprise persistence:

- Conversation messages, Agent-session bindings, and Pi JSONL snapshots → Agent-owned MySQL
- A live SDK session is process-local, but recovery reconstructs it from the durable Agent-session journal after a worker restart

Most SDK bumps therefore need no SQL schema migration, but they must retain
compatibility with already-persisted session entries.

When upstream changes matter:

| Change | Action |
|--------|--------|
| `CURRENT_SESSION_VERSION` or JSONL entry shapes | Copy representative persisted entries; run `parseSessionEntries` / `migrateSessionEntries` offline and prove the new image restores pre-upgrade sessions |
| Tool result / event field renames | Update `agent/src/infrastructure/pi/platform-event-projector.js` and its unit tests; keep durable platform events and BFF SSE types stable for frontend |
| Default built-in tools reintroduced | **Block release** until allowlist + customTools still override host I/O |
| Model / auth storage format | Verify `AuthStorage` + `ModelRegistry` still accept LLMIO key path |

For a session-entry migration, use **copy-then-validate**, keep the previous
Agent image for rollback, and never dual-write one session from two versions.

## 4. PR checklist

- [ ] `runtime-versions.json` `pi_sdk` updated to the new exact versions
- [ ] `agent/package.json` has **exact** version (e.g. `"0.81.0"`, not `^0.81.0`) for both `pi-coding-agent` and `pi-ai`
- [ ] `agent/src/extensions` 仍只装配三类正式 Extension，且 production no-legacy guard 通过
- [ ] `agent/package-lock.json` committed and matches (`npm ci --prefix agent`)
- [ ] `uv run pytest tests/test_runtime_versions.py -q` green
- [ ] ADR inventory updated if imports/events change (`docs/adr/0001-pi-coding-agent-sdk.md`)
- [ ] Compat suite green in CI (`node-agent` job)
- [ ] Staging gray check notes in PR body
- [ ] No production default flips unrelated to the pin (Agent service image/config only)

## 5. Image rollback

If production misbehaves after release:

1. **Roll back the Agent image** to the previous digest/tag (compose/k8s).
2. Confirm `npm ls` inside the rolled-back image shows the previous pin.
3. Leave Agent MySQL records and Sandbox sessions intact.
4. Do **not** delete session snapshots solely because of an Agent rollback; multi-turn reuse still applies.
5. File a follow-up with compat suite gaps that missed the regression.

Rollback does not require re-running LLM evaluation if the previous image was known-good; prioritize restore of SSE/tool path.

## 6. After success

- Update the “Pinned version” row in ADR 0001.
- Archive any temporary candidate `node_modules` experiments.
- If exit criteria in the ADR are approached (license, unfixable API gap, maintenance stop), open a **new** ADR rather than expanding a fork silently.
