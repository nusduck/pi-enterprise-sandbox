# ADR 0001: Adopt upstream `@earendil-works/pi-coding-agent` SDK

| Field | Value |
|-------|-------|
| Status | Accepted |
| Date | 2026-07-11 |
| Decision owners | Agent runtime / api-server maintainers |
| Related | Agent Runtime, package `agent` |
| Pinned version | `0.80.3` (exact; SSOT `runtime-versions.json` + `agent/package.json`) |

## Context

Pi Enterprise Sandbox runs the agent loop in the independent Node `agent` service. The `api-server` is a thin BFF, while the Python `sandbox` service enforces security, workspace I/O, approvals, artifacts, and durable event persistence. The Agent imports `@earendil-works/pi-coding-agent` to create sessions, stream tokens/tool events, and restore multi-turn history.

We needed an explicit decision on whether to:

1. Use the official Node SDK as-is,
2. Maintain a fork,
3. Build a Python binding / alternate runtime as the primary path, or
4. Fully reimplement the agent product surface.

## Decision

**Use upstream `@earendil-works/pi-coding-agent` directly as the Node agent orchestration library.**

- **No fork** of the SDK repository for product features.
- **No Python binding** as a first-class replacement for the Node SDK.
- **No full reimplementation** of the coding-agent product (CLI, TUI, tool system, Extension host, Session JSONL, model adapters).
- Customize behavior via **public APIs only**: `createAgentSession`, `customTools` + tool allowlist, `SessionManager`, resource loaders, and Agent-side SSE mapping.
- **Sandbox remains the security boundary.** SDK built-in file/exec tools must not run host-local I/O for user work; they are overridden with Sandbox-backed tools.

Version policy: **exact pin** in `agent/package.json` (no `^` / `~` range). Upgrades are deliberate PRs that run the compatibility suite (see [sdk-upgrade runbook](../runbooks/sdk-upgrade.md)).

## Alternatives considered

| Option | Summary | Why not chosen |
|--------|---------|----------------|
| **A. Upstream SDK (chosen)** | Depend on published npm package; override tools; map events in BFF | Fits current architecture; lowest maintenance; MIT license |
| **B. Long-lived fork** | Fork repo, publish private package, cherry-pick upstream | High merge cost; splits security fixes; only justified by exit criteria below |
| **C. Python binding / primary Python agent** | Re-wrap SDK or reimplement loop in Sandbox | Rejected and removed: no official Python entry; dual runtimes diverged; Python is Sandbox-only |
| **D. Full reimplementation** | Build our own agent loop, tools, session, model adapters | Multi-year product work; no clear ROI while public API covers needs |
| **E. Thin compatibility shim over multiple agent engines** | Abstract “any coding agent” behind our interface | Premature; adds indirection without a second engine requirement |

## Non-goals

- Replacing Sandbox path validation, policy/approval, or artifact registry with SDK features.
- Shipping the SDK CLI/TUI as the enterprise UX (browser + BFF SSE remains the product surface).
- Guaranteeing bit-identical behavior with every upstream CLI release beyond contracts covered by `agent/tests/sdk-compat/`.
- Auto-bumping the dependency via Dependabot major upgrades without a human-reviewed PR.
- Reintroducing a Python Agent runtime or dual-runtime switch (removed; use the independent Node Agent service).

## License, engine, maintenance

| Topic | Fact (verified against installed `0.80.3`) |
|-------|-----------------------------------------------|
| Package | `@earendil-works/pi-coding-agent` |
| License | **MIT** |
| Module type | ESM (`"type": "module"`) |
| Node engines (SDK) | **`>=22.19.0`** (declared in package `engines`) |
| Entry | `main` / export `.` → `./dist/index.js` |
| Maintenance ownership (this repo) | **Agent runtime owners** own pin, upgrade PR, compat suite, and runbook |
| Upstream maintenance | Earendil / package publishers; we consume releases only |

**Note:** CI, Docker images, and package `engines` are aligned on **Node 22** via `runtime-versions.json` (`engines`: `>=22.19.0 <23`, images: `node:22-slim`). Runtime images and any environment that *executes* `createAgentSession` must meet the SDK engine requirement (`>=22.19.0`). Do not silently ignore engine bumps on upgrade. Consistency is enforced by `tests/test_runtime_versions.py`.

## Security boundary

```
Browser → api-server (BFF / Run API / SSE relay) → agent (pi-coding-agent)
                                                   ↓ customTools only (allowlist)
                                            sandbox REST (policy, exec, artifacts)
```

**Hard rules:**

1. **SDK is not the sandbox.** Trust boundaries (path jail, safe env, policy, network isolation) live in `sandbox/`.
2. **Built-in host tools must not execute user work on the Agent host.** `createAgentSession` is given:
   - `tools: ['read', 'bash', 'edit', 'write', 'submit_artifact']` (allowlist)
   - `customTools: createSandboxTools(...)` implementing those names via Sandbox HTTP
3. **Approvals** are reserved for external side effects. Ordinary Workspace bash/python/node execution is not approval-gated; BFF emits `approval_required` only for enterprise tools whose policy requires an operator decision.
4. **Secrets** (LLM keys, sandbox tokens) stay server-side (`AuthStorage`, env); never forwarded to the browser.
5. **Artifacts** become user-visible only after `submit_artifact` → Sandbox registry → `file_ready` SSE.

If a future SDK release re-enables default local tools outside the allowlist, the upgrade is a **security regression** and must fail the compat suite / be blocked.

## Exit criteria (when to reconsider fork or reimplementation)

Open a **new ADR** before forking or reimplementing. Reconsider only if one or more hold:

1. **License change** that is incompatible with enterprise distribution (non-MIT/non-permissive, or additional restrictive terms).
2. **Critical security or persistence capability** required by product that **cannot** be implemented via public API (`customTools`, Extension hooks, SessionManager entries, BFF orchestration).
3. **Upstream maintenance stop** (no security releases for an extended period) while we still depend on the package.
4. **Compat cost exceeds approved budget** — e.g. repeated major breaks where adapting via public API + BFF exceeds the cost of a maintained fork/shim (documented estimate + eng lead approval).
5. **Engine or platform constraints** we cannot meet (e.g. mandatory runtime we cannot ship) with no upstream accommodation.

Until those criteria are met, prefer Extension/custom tools, BFF mapping, and version pins.

## API surface inventory (this repo)

Authoritative code: `agent/src/infrastructure/pi/pi-runtime-factory.js`, `agent/src/application/pi-run-executor.js`, `agent/src/extensions/`, and `agent/tests/pi/`.

### Imports from `@earendil-works/pi-coding-agent`

| Symbol | Use |
|--------|-----|
| `createAgentSession` | Create in-memory agent session with model, tools, loaders |
| `SessionManager` | `SessionManager.inMemory()` for turn-scoped transcript |
| `AuthStorage` | `AuthStorage.create()` + `set(provider, key)` for LLMIO |
| `ModelRegistry` | `ModelRegistry.create(authStorage)` |
| `DefaultResourceLoader` | Skills/resources from agent dir + skill paths |
| `SettingsManager` | `SettingsManager.create('/tmp', getAgentDir())` |
| `getAgentDir` | Resolve agent config directory |

Not imported by the BFF today (available upstream, out of scope unless a task adopts them): RPC mode, interactive TUI components, default `createBashTool` / local coding tools, package manager CLI, `ExtensionRunner` / `extensionFactories` (compat suite still pins Extension `tool_call` block + `tool_result` rewrite APIs for upgrade safety).

### `createAgentSession` options we set

- `model` — custom openai-completions-compatible model object (`provider: 'llmio'`)
- `tools` — allowlist: `read`, `bash`, `edit`, `write`, `submit_artifact`
- `customTools` — Sandbox-backed tool defs from `createSandboxTools`
- `cwd` — logical workspace `/home/sandbox/workspace`
- `sessionManager` — `SessionManager.inMemory()`
- `authStorage`, `modelRegistry`, `resourceLoader`, `settingsManager`

### Session / resource behavior

- Multi-turn: prior UI messages → `toAgentHistoryMessages` → `session.agent.state.messages`
- System prompt append for artifact-only delivery policy
- Skills: `additionalSkillPaths` uses only `/home/sandbox/skill`
- Agent-owned MySQL is the enterprise source of truth for conversation messages, Agent-session bindings, and Pi JSONL snapshots. The live SDK session is process-local and is reconstructed from that journal on recovery. `CURRENT_SESSION_VERSION` is asserted in compat tests for upgrade awareness.

### SDK events subscribed → BFF SSE

| SDK event | Condition | BFF SSE |
|-----------|-----------|---------|
| `message_update` | `assistantMessageEvent.type === 'text_delta'` | `token` `{ text }` |
| `tool_execution_start` | always when emitted | `tool_start` `{ id, name, args }` |
| `tool_execution_end` | always when emitted | `tool_end` `{ id, name, result, isError }` |
| `tool_execution_end` | `toolName === 'submit_artifact'` && !error | `file_ready` `{ artifact_id?, path?, name?, mime_type?, size? }` |

### BFF lifecycle SSE (not from SDK subscribe)

`trace`, `session`, `approval_required` (from tool approval notifier), `error`, `done`, `session_closed`.

Shared browser/BFF SSE fixture: `tests/fixtures/sse_events.json`. Pi event projection: `agent/src/infrastructure/pi/platform-event-projector.js`.

### Sandbox tool contract

| Tool name | Sandbox effect |
|-----------|----------------|
| `read` | `readFile` / `readFileWithRange` (skill paths may read local skill files) |
| `write` | `writeFile` private workspace |
| `edit` | read → replace → write |
| `bash` | Sandbox-isolated `executeCommand` without ordinary approval |
| `submit_artifact` | `submitArtifact` → drives `file_ready` |

Tool result shape expected by the Agent runtime: `{ content: [{ type: 'text', text }], details?, isError? }`.

## Compatibility suite

Location: `agent/tests/sdk-compat/`.

- Runs under `node:test` **without live LLM calls**.
- Asserts message helpers, SessionManager branch/custom entries, Extension `tool_call` fail-safe + `tool_result` rewrite, and SDK version pin. Pi event projection is covered by `agent/tests/pi/platform-event-projector.unit.test.js`.
- How to run against a candidate version: see [docs/runbooks/sdk-upgrade.md](../runbooks/sdk-upgrade.md).

## Consequences

**Positive**

- Single maintained orchestration stack; product focus stays on Sandbox security and BFF UX.
- Exact pin + compat suite make upgrades reviewable.
- Clear exit criteria avoid premature fork.

**Negative / risks**

- Coupled to upstream event names and `createAgentSession` option semantics.
- SDK engine (`>=22.19`) may diverge from older CI Node images — track in upgrade PRs.
- SDK session objects are process-local; restart recovery depends on compatibility with the Agent-owned durable Pi session journal.

## References

- `agent/src/infrastructure/pi/pi-runtime-factory.js`
- `agent/src/infrastructure/pi/pi-session-adapter.js`
- `agent/src/application/pi-run-executor.js`
- `agent/src/extensions/`
- `agent/tests/pi/`
- `tests/fixtures/sse_events.json`
- `docs/runbooks/sdk-upgrade.md`
