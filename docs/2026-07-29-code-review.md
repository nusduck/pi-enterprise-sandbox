# Code Review — 2026-07-29

**Scope:** `codex/plan-acceptance` vs `main` (664 non-test files changed, +141944/-31996 lines — a full backend rearchitecture: monolithic `database.py`/`repositories.py` replaced by a `persistence/` + `domain/` layered architecture, new internal-auth/MCP-facade/cron-control-plane subsystems added).

**Method:** 7 parallel finder passes (line-by-line security scan, removed-behavior audit against the deleted legacy modules, cross-file tracer on process/execution, plus reuse/simplification/efficiency/altitude cleanup passes) followed by direct source verification of the highest-severity candidates. No `CLAUDE.md` exists in this repo or at the user level, so no conventions-angle findings apply.

Ranked most severe first.

## 1. Human-in-the-loop approval gate silently dropped for risky tool calls

**File:** `sandbox/services/formal_execution_runtime.py:199`

Only `policy_checker.is_blocked_command(...)` (hard-deny only) is called before dispatch. The three-tier `policy_checker.check()` gate — which used to route `package_install`, `network_request`, `kill_process`, `raw_bash`, etc. through a `pending_approval` state — is never invoked anywhere in the new runtime (confirmed via grep: `formal_execution_runtime.py` imports only `is_blocked_command`). Its counterpart, `sandbox/services/approval_manager.py` (create/get/decide, 300s auto-timeout-to-rejected, idempotency-key mismatch guard), was deleted in this diff with no replacement anywhere in `sandbox/` or `agent/`.

**Failure scenario:** A HIGH-risk tool call (e.g. `pip_install`, `kill_process`) that previously had to pause for human approval now executes immediately with no gate, as long as it isn't on the hard-block list.

## 2. Dead process-repository fallback + new terminal-process eviction can permanently orphan process state

**File:** `sandbox/services/process_manager.py:351` (and read paths at lines 1531, 1629, 1754, 1795, 1921, 2078, 2126, 2196)

`self.repository` is bound once to `_UnconfiguredProcessRepository()` in `__init__` and never reassigned — `set_formal_repository()` (line 489-501) only updates `self._formal`. Verified: `_UnconfiguredProcessRepository.get()` always returns `None`; `list_by_session`/`list_by_run` always return `[]`. This diff also adds `_evict_terminal_if_needed()`, which bounds in-memory terminal entries (default 256 global / 64 per-session) and evicts them from `self._entries`.

**Failure scenario:** Once a terminal process is evicted from memory, `get()`, `logs()`, `write_stdin()`, `signal_process()`, `cancel()`, and `read_stream()` all fall through to the permanently-empty `self.repository` and incorrectly report "not found" — silently losing access to stdout/stderr history and status that still exists in the real MySQL store (only the newer `get_owned()`/`read_stream_owned()`/`signal_process_owned()` API, which uses `self._formal` directly, still works).

## 3. TTL/retention cleanup subsystem removed with no replacement (sessions, workspaces, legal hold)

**Files:** `sandbox/config.py:429-435`, `sandbox/services/formal_session_runtime.py`, `sandbox/services/workspace_manager.py:84`

The deleted `sandbox/services/ttl_cleanup.py` enforced legal-hold protection and TTL purges (24h drafts, 90d inactive conversations, 180d audit/events) and drove `WorkspaceManager.remove_workspace()`. None of this was re-implemented: `session_repository.py` has no expire/cleanup method, `FormalSessionRuntime` only ever transitions sessions to `ACTIVE`, `draft_ttl_hours`/`conversation_ttl_days`/`audit_ttl_days` in `config.py` are now unread dead settings, and `WorkspaceManager.remove_workspace()` has zero call sites anywhere in `sandbox/` (confirmed by grep).

**Failure scenario:** Sessions created via `/internal/v1/sessions/ensure` stay `ACTIVE` forever even after the owning process crashes; workspace directories under `settings.workspaces_path` are created per-session but never removed by any code path — unbounded disk growth on the sandbox host, plus loss of the legal-hold safeguard for compliance-relevant data.

## 4. Reaper thread can crash mid-finalization on a transient persistence error, hanging all waiters

**File:** `sandbox/services/process_manager.py:1310` (pattern repeats at 1320, 1335, 1346, 1356, and `_on_timeout` at 1382)

`self._persist(entry)` is called with no `try`/`except` immediately before `self._done_events[process_id].set()`, `_clear_reader_handles_locked()`, `_evict_terminal_if_needed()`, and `_emit_terminal_for()`. `_persist()` raises `RuntimeError` if the formal writer isn't configured yet, or re-raises any DB exception when `authoritative=True`.

**Failure scenario:** A transient MySQL error (or a request that races ahead of `set_formal_repository()` being wired up at lifespan startup) kills the daemon reaper thread mid-block. The entry's in-memory dict was already mutated to terminal status, but the done-event is never signaled and no terminal SSE event fires — any caller blocked in `wait()` hangs for up to `_DEFAULT_WAIT_SECONDS` (3600s) instead of returning promptly.

## 5. `require_owned_session` always returns 503 when auth is disabled (the default)

**File:** `sandbox/security/ownership.py:264`

`settings.auth_enabled` defaults to `False` (`sandbox/config.py:449`). `require_end_user_actor`'s own docstring states "Auth off → None (caller skips ownership)", and it does return `None` in that mode. But `require_owned_session` treats a `None` actor as fatal: `if actor is None: raise HTTPException(503, "Formal public session access requires owner authentication")`. Confirmed callers: `sandbox/routers/datasets.py`, `sandbox/routers/files.py`, `sandbox/artifact/api/public.py`.

**Failure scenario:** With auth disabled — the normal dev/CI/local mode used throughout this codebase — every route that calls `require_owned_session` (dataset access, file access, public artifact access) permanently 503s instead of getting the open-dev-mode bypass every other ownership function in the same file grants.

## 6. Shared service API token compared with non-constant-time `==`

**File:** `sandbox/security/ownership.py:52`

`_service_token_valid` does `token == settings.api_token` on the attacker-controlled `X-API-Key` header value. This gates `_actor_from_acting_headers`, which the rewritten `resolve_actor`/`require_end_user_actor`/`require_owned_session` chain all depend on. Every other secret comparison touched in this diff (`internal_auth.py`, `internal_http_auth.py`, `mcp_internal_auth.py`) correctly uses `hmac.compare_digest`/`secrets.compare_digest`.

**Failure scenario:** A timing side-channel lets an attacker recover the shared service token byte-by-byte via repeated requests, since Python `==` short-circuits on the first mismatched byte.

## 7. `request_hash` internal-auth claim is format-checked but never actually verified

**File:** `sandbox/security/internal_auth.py:308`

`_validate_claims` only checks `claims["request_hash"]` is a well-formed lowercase SHA-256 hex string (`_require_lower_sha256`); unlike `body_sha256`, which `verify_internal_request` recomputes from the raw body and compares with `hmac.compare_digest`, `request_hash` is never referenced again anywhere in `verify_internal_token`/`verify_internal_request` (confirmed via grep — no second occurrence).

**Failure scenario:** The module docstring claims "request method/path/body ... are all bound before a caller may dispatch work," but a token carrying any well-formed-but-stale/wrong `request_hash` is accepted. Any future code (audit correlation, idempotency checks) that trusts this claim as an authoritative full-request digest would be trusting an unverified value.

## 8. `cancel()` now reports already-completed processes as "cancelled"

**File:** `sandbox/services/process_manager.py:1908`

Previous semantics: `if _is_terminal(status) and process_id not in self._cancel_requested: return False` (terminal-but-not-cancelled = not cancellable). New semantics: `if _is_terminal(status): return True` for *any* terminal process, regardless of whether it succeeded, failed, or was actually cancelled. `cancel_for_session()`/`cancel_for_run()` (lines 2100, 2126, 2177, 2196) build their "cancelled" result list directly from this return value.

**Failure scenario:** A batch cancel over a mix of running and already-successfully-completed processes reports the completed ones as "cancelled," which could mislead a caller (e.g. session-teardown/run-abort logic) that treats the cancelled list as "these were interrupted." No current in-repo caller of the non-owned `cancel`/`cancel_for_session`/`cancel_for_run` API was found, so impact depends on external/future callers.

## 9. Trace-context binding silently skipped instead of failing closed when trace_id is unset

**File:** `sandbox/security/internal_http_auth.py:367`

`if request_trace_id is not None and claim_trace_id != request_trace_id: _deny(...)` only enforces the trace-to-token binding when `get_trace_id()` returns non-`None`. In production this contextvar is populated by the global trace-id middleware, but `authenticate_internal_request` has no explicit dependency on that middleware having run.

**Failure scenario:** Any call path where the trace middleware hasn't executed first (direct unit/integration calls, a future route registered outside the normal middleware stack, a middleware-ordering change) silently bypasses this defense-in-depth check instead of being rejected.

## 10. MCP-internal bounded body reader duplicates and weakens the shared implementation

**File:** `sandbox/routers/mcp_internal.py:68` (`_parse_payload`)

Reimplements a Content-Length-checked, capped streaming body reader instead of reusing `read_bounded_raw_body`/`parse_content_length_from_scope` from `sandbox/security/internal_http_auth.py` (confirmed present, lines 165-251). It is missing several of that helper's fail-closed checks: duplicate Content-Length header rejection, strict ASCII-decimal validation, rejection of a body that exceeds its declared Content-Length, and chunk-type validation.

**Failure scenario:** The two "bounded body read" implementations protecting adjacent internal endpoints have now diverged; this one is laxer, so a request-smuggling/DoS technique the shared helper is hardened against could still reach the MCP internal routes, and future hardening added to `read_bounded_raw_body` won't automatically propagate here.

---

## Additional findings not in the top 10 (lower severity / cleanup)

These were surfaced but did not make the severity cut (correctness bugs above are ranked first per review policy):

- `sandbox/security/replay_redis_config.py:162,179,191` — Redis password isolation check uses `==` instead of constant-time compare (config-validation time only, lower exploitability than #6).
- `sandbox/services/process_manager.py:483` — `_persist()` raises `RuntimeError` (rather than returning an error dict) if called before `set_formal_repository()` wires up at startup; any caller racing app lifespan gets an unhandled exception.
- `sandbox/mcp/app.py:23` (`McpBearerAuth.__call__`) and `sandbox/security/mcp_internal_auth.py:21` (`_authorization_values`) — both reimplement ASGI Authorization-header/Bearer extraction instead of reusing `internal_http_auth.py`'s helpers; two independently-maintained auth parsers for adjacent trust boundaries.
- `sandbox/artifact/infrastructure/store.py:61` vs `sandbox/artifact/infrastructure/repository.py:25` — duplicate `sha256(path)` hashing helper that must stay in sync with a MySQL generated column; a future edit to one without the other breaks idempotent artifact lookups.
- `sandbox/config.py:757-822` — seven near-identical `field_validator` methods for resource-limit fields that could collapse into one keyed validator (the diff's own `_validate_mysql_timeouts`/`_validate_mcp_positive_limits` already demonstrate the pattern).
- `sandbox/config.py:824-931` — `_resolve_bind_host_network_and_policy` is a single ~110-line `model_validator` doing 6+ unrelated jobs (approval mode, deployment env, bind host, network policy, CIDR validation, HMAC keyring parsing); this diff added more concerns into it rather than splitting it up.
- `sandbox/services/workspace_quota_ledger.py:222,296,379` — `reserve()`, `reserve_replacement()`, and `try_grow()` triplicate the same usage/quota-projection-and-raise block, with `reserve_replacement` computing the reserved term slightly differently, buried inside near-duplicate code.
- `sandbox/services/child_workspace_quota.py:299` — `ChildWorkspaceQuotaWatch`'s `on_exceed` parameter and its two `_run()` branches are dead code; every real caller uses `on_violation` only.
- `agent/src/application/cron-job-service.js:405` and `agent/src/infrastructure/mysql/repositories/cron-job-repository.js:320` — two independent hardcoded terminal-run-status lists (one in JS, one in raw SQL) both include a phantom `CRASHED` status that doesn't exist in the canonical `run-status.js` domain enum; if a real terminal status isn't in one of these ad-hoc lists, cron reconciliation can re-scan a finished run forever.

## Notes on scope

Given the diff's size (664 non-test files), this review prioritized the newly-added security/auth, persistence, process/execution, MCP-facade, and cron-control-plane subsystems — the highest-risk areas of a from-scratch backend rearchitecture — over full line-by-line coverage of all 664 files. The removed-behavior audit (finding #3, #1) is the highest-confidence category: it compares the previous monolithic implementation directly against the new modular one and found concrete gaps rather than inferring them.

---

## Follow-up: `agent/` module — agent-version control, MCP tool loading, extension loading

The initial pass above covered the Python `sandbox/` backend only. The entire `agent/` directory (Node.js service) is also new in this diff (confirmed via `git diff main...HEAD --stat`: every file under `agent/src/extensions/`, `agent/src/infrastructure/mcp/`, `agent/src/infrastructure/pi/`, and the agent-catalog/version-binding code is a pure addition, no deletions). This follow-up specifically targeted three areas: whether a run stays durably bound to the agent version it started with, whether MCP tool loading is safe, and whether extension loading (in particular the `enterprise-policy` tool-call gate) can silently fail. All findings below were verified directly against source.

### A1. Extension load-failure gate is skipped on session rebind, letting the policy gate silently vanish mid-run

**Files:** `agent/src/infrastructure/pi/pi-runtime-factory.js:764-811` (`bindSessionExtensions`), `:1029` vs `:1051-1054` (`setRebindSession`); `agent/src/skills/manager.js:194-233` (`reload()`)

`assertExtensionsLoadedClean()` — the only fail-closed check on extension-load errors — is called at lines 989 and 1029, but both call sites live inside the *initial* session-creation path (`createRuntime`, called once from `createAgentSessionRuntime` at line 1016). The separately-defined `bindSessionExtensions` helper (764-811), which only calls `session.bindExtensions(extensionBindings)`, never calls `assertExtensionsLoadedClean`. That helper is exactly what `runtime.setRebindSession(...)` (1051-1054) invokes on every `fork()`/`newSession()`/`switchSession()`, and it's also what `agent/src/skills/manager.js`'s `reload()` tool handler triggers indirectly via `session.reload()`/`session.resourceLoader.reload()` (line 200) — a normal, reachable skill-install/uninstall flow. The underlying Pi SDK's extension loader catches factory errors into `extensionsResult.errors` rather than throwing, so nothing downstream of these two call sites ever inspects that error list.

**Failure scenario:** If the `enterprise-policy` extension factory fails to load on a session rebind or skill reload (any transient error inside `createEnterprisePolicyExtension`), the session proceeds with its `tool_call` handler silently absent — every subsequent sandbox tool call (bash, write, process_*, etc.) executes with zero policy evaluation, arg-guards, or audit, and `skills/manager.js`'s `reload()` still unconditionally reports `result: 'success'` (line ~224-228), so there is no operator-visible signal that the gate is gone. This is the same fail-open pattern as finding #1 in the sandbox review (approval gate silently dropped), recurring in the Node agent's extension system.

### A2. Per-AgentVersion MCP tool allowlist is discarded whenever the deployment-wide MCP registry is non-empty

**File:** `agent/src/infrastructure/mcp/pi-mcp-adapter-factory.js:970-973`

```js
mcpServers:
  defaultMcpServers.length > 0 ? defaultMcpServers : input.mcpServers,
```

`defaultMcpServers` comes from the process-wide `MCP_SERVERS_JSON` registry (`discoverEnabledMcpServers`, which sets `enabledTools: server.toolNames` — literally every tool on every enabled server). This is documented in an adjacent comment as an intentional "Phase 1" choice ("deployment registry is the default MCP authority... AgentVersion need not repeat them"), but the practical effect is that an individual AgentVersion's own `mcpServers`/`enabledTools`/`toolPolicy` allowlist (parsed from its `configJson` by `loadMcpConfigFromAgentVersion`) is used *only* when the deployment registry is empty — in any deployment that configures a shared registry at all, every AgentVersion in that process silently receives the full tool surface instead of its declared subset.

**Failure scenario:** An operator configures one shared MCP server exposing 40 tools (including admin/debug tools) in `MCP_SERVERS_JSON`. Every AgentVersion running in that process — even ones whose `configJson` explicitly restricts `enabledTools` to a small safe subset — silently gets access to all 40 tools instead, because the per-agent allowlist is never consulted once the registry is non-empty. A least-privilege violation across tenants/agents sharing one Agent process.

### A3. Missing DB uniqueness constraint + opt-in-only advisory lock can let two concurrent requests create two different "default" agent versions for the same org

**Files:** `agent/src/infrastructure/mysql/repositories/agent-catalog-repository.js:286` (`ensureTenantDefaultAgent`), `agent/src/application/parent/run-parent-provisioner.js:121` (`#lockOrganization`)

`agent_definitions` has no `UNIQUE(org_id, name)` constraint (only a non-unique `idx_agents_org` on `(org_id, status)`), and `createDefinition()` only throws `ConflictError` on a ULID primary-key collision, never on a duplicate `(org_id, 'default')` pair. The only thing serializing concurrent first-time creation is `#lockOrganization`'s `FOR UPDATE` lock — but that method silently no-ops (`if (!this.db || typeof this.db !== 'function') return;`) if no `db` executor was passed to the `RunParentProvisioner` constructor. Today's production callers happen to always pass `db: trx`, so this is not currently triggered, but nothing enforces that at the constructor.

**Failure scenario:** Two concurrent first-time `CreateRun`/`ensureSession` calls for a brand-new org both observe `getDefinitionByOrgAndName(orgId, 'default') === null` before either commits, and both successfully insert distinct `agent_definitions`/`agent_versions` rows for the same org's "default" agent — a silent split-brain on which version is the org's true default, with sibling conversations binding to two different identities and no error surfaced.

### A4. No JSON-schema argument validation before dispatching to MCP tools; response size is only bounded after full buffering

**File:** `agent/src/infrastructure/mcp/pi-mcp-adapter-factory.js:802` (tool wrapper `parameters: Type.Object({}, { additionalProperties: true })`), `:818` (`redactPayload` applied post-await)

Every projected `mcp__<server>__<tool>` wrapper accepts arbitrary arguments with no schema check against the tool's real `inputSchema` before forwarding to the MCP server, and the full tool response is awaited and parsed into memory before `redactPayload` (32KB string cap / 50-item array cap) is applied.

**Failure scenario:** A malformed tool call surfaces a confusing error deep in the MCP server instead of being rejected early; a buggy or malicious MCP server returning a multi-gigabyte response must be fully buffered and parsed by the Agent process before any truncation applies, risking memory exhaustion.

### A5. Sequential, unbounded MCP server discovery can block Agent process readiness for minutes

**File:** `agent/src/infrastructure/mcp/pi-mcp-adapter-factory.js:352` (`discoverEnabledMcpServers`)

Enabled registry servers are connected to one at a time in a `for...of` loop with no overall discovery timeout; each server's own `connect()` can take up to its configured `requestTimeoutMs` (default 60s, max 300s).

**Failure scenario:** One hung command-based MCP server near its max timeout blocks Agent startup (`preflightMcpServers`, called before the process is marked ready) for minutes, delaying `/ready` and starving unrelated healthy servers queued behind it — a startup-time denial of service.

### Lower-severity / latent (not currently exploited via any production call path found)

- `agent/src/application/session-recovery-service.js:267` — the `agentVersionId` identity check during session recovery only runs `if (args.agentVersionId && ...)`; the field is optional in the JSDoc. Today's one caller (`pi-run-executor.js:567`) always supplies it, but nothing enforces that a future caller must.
- `agent/src/application/create-run-service.js:338` — `RunParentProvisioner.provision()` (which re-validates agent/conversation state) runs before the idempotency-record lookup, so an idempotent retry after the bound conversation was archived throws instead of returning the originally-committed response.
- `agent/src/application/pi-run-executor.js:524` — execution-time re-fetch of the pinned AgentVersion checks the `piSdkVersion` pin but never the version's own `status` field; not exploitable today since no status-mutation API exists yet, but a future deprecate/revoke admin flow would have no enforcement at the executor layer.
- `agent/src/extensions/enterprise-policy/index.js:227-244` — `writeGovernance()`'s audit-required check treats `deps.policyEngine != null` as proof of durable auditing without verifying it; not reachable today since the one production caller always supplies `governanceRecorder`.
- `agent/src/infrastructure/mcp/pi-mcp-adapter-factory.js:926-931` — `cleanup()` only removes the temp `mcp.json` config dir; actual MCP subprocess/connection teardown is delegated entirely to the vendor runtime's best-effort `dispose()`, so a crash before that point can orphan spawned MCP server processes.
