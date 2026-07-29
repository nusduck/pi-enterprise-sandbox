# 2026-07-29 dead code cleanup

Scope: repo-wide pass across `agent/`, `api-server/`, `sandbox/`, `frontend/`
to find and remove unused, redundant, and deprecated code. Findings were
produced by four independent read-only greps/inventories (one per module),
each finding manually re-verified with whole-repo grep before removal. Only
**high-confidence** items (zero references anywhere, confirmed by search)
were removed; medium/low-confidence items were left in place and are
recorded below instead of acted on.

Every module's test suite (and, for `frontend/`, `tsc --noEmit` + `vite
build`) was run before and after the change; pass/fail counts were
identical except for the removals' own follow-on fixes (see below). No
behavior change was intended or observed.

## What was removed

| Module | Removed | Notes |
| --- | --- | --- |
| `agent/` | Entire `src/runtime/` directory (6 files) + 6 dedicated test files | Superseded by inline vision/attachment handling in `pi-run-executor.js` and redaction in `platform-event-projector.js`; never wired into the composition root after the July dual-tree collapse. |
| `agent/` | `src/infrastructure/mcp/index.js` unused barrel | Guard tests (`secret-and-mcp-policy.unit.test.js`, `mcp-seam.unit.test.js`) hardcoded this file in their expected module-set assertions; those assertions were updated to match the new closed set (`mcp-config-loader.js`, `pi-mcp-adapter-factory.js`). |
| `agent/` | 18 standalone dead exports (constants/functions) across `sandbox-bridge`, `lib`, `infrastructure/telemetry`, `infrastructure/model-registry`, `infrastructure/pi`, `infrastructure/sandbox`, `infrastructure/mysql`, `domain/interaction` | Each verified zero references repo-wide. |
| `agent/` | Dead `_defaultRegistry` cache (`getDefaultRegistry`/`resetDefaultRegistry`) in `model-registry.js` | `resolveModel` never reads the cache; `resetDefaultRegistry`'s only caller was a test `beforeEach` with no observable effect. Test updated to drop the no-op reset. |
| `agent/` | Dead local fn `assertPositiveInt` in `tool-execution-repository.js` | `@deprecated use assertPositiveSafeInt`, zero callers. |
| `agent/` | Unused dependency `@opentelemetry/propagator-b3` | Not imported anywhere; lockfile regenerated. |
| `api-server/` | ~150 lines of dead module-level wrapper functions + unused instance methods in `sandbox-client.js` (session/conversation/execution/file/dataset/approval CRUD) | Left over from the PR-13 migration of Run/conversation fact authority to Agent MySQL; production routes only use `getConversation`, `listArtifacts`, `importArtifact`, `authRegister/Login/Me`, `checkHealth`, `artifactDownloadPath`. |
| `sandbox/` | 4 orphan functions in `security/ownership.py`: `assert_resource_owner`, `assert_session_owner`, `assert_legacy_session_binding_create_allowed`, `session_visible_to_actor` | Zero call sites; stale docstring reference in `require_owned_session` corrected. |
| `sandbox/` | Back-compat aliases: `paths.py:is_logical_workspace_path`, `policy_checker.py:command_requires_approval` | Zero references. |
| `sandbox/` | `child_workspace_quota.py`'s dead `on_exceed` param + branches | Already flagged in a prior team review as CLEANUP; only `on_violation` is ever passed. |
| `sandbox/` | `sandbox/app/domain/internal_artifact_download_contract.py` compat shim | Zero importers (its sibling `internal_artifact_contract.py` is used by tests; this one wasn't). |
| `frontend/` | Unused API client fns: `client.ts: uploadFile/getStatus`, `approvals.ts: getApproval/decideApprovalDecision`, `processes.ts: getProcess/readProcess` | All superseded by other functions already in use (e.g. uploads go through `datasets.ts: uploadDataset`). |
| `frontend/` | Orphan `entities/store.ts` helpers: `EMPTY_ENTITY_STORE`, `createAttachment`, `upsertAttachment`, `getActiveRun`, `getRunDatasets` | Zero references. |
| `frontend/` | Orphan schema exports: `StatusSchema`, `UploadResponseSchema`/`UploadResponse`, `RunListSchema`, `CreateRunRequestSchema`, `ATTACHMENT_STATUSES`, `reducePlatformEventInput` | Became orphaned by the API-client removals above, or were already unreferenced ("used by docs/tests" comment was stale). |
| `frontend/` | 5 dead CSS rules in `app.css`: `.row-pre`, `.sidebar-runtime-hints` block, `.rsb-error`, `.rtc-log-preview` | No matching class in any `.tsx`. `.sr-only` was checked and kept (see deferred list). |

## Deferred — not acted on

These were identified but deliberately left alone: either they are a design/
consolidation call rather than a pure deletion, they touch a security-
sensitive path where consolidating risks behavior change, or removing them
would require coordinated changes to operator-facing config/docs beyond a
pure code cleanup.

| Item | Location | Why deferred |
| --- | --- | --- |
| Duplicate streaming proxy logic | `api-server/src/routes/datasets.js: pipeWithBackpressure` vs. hand-rolled loop in `api-server/src/routes/files.js: handleArtifactDownload` | `pipeWithBackpressure`'s doc comment claims `files.js` reuses it; it doesn't. Fixing this "properly" means either wiring `files.js` to call it (behavior change in a data-streaming path) or deleting it + its dedicated test (`tests/dataset-artifact-proxy.test.js`). Left as a follow-up decision. |
| Exported-but-only-self-used helpers | `api-server/src/application/telemetry.js: requestCarrier/contextFromTraceContext`, `trace-context.js: parseTraceparent`, `http/cookies.js: SESSION_COOKIE` | Not dead code (still invoked internally) — just an unnecessarily wide export surface. Cosmetic; skipped per "high-confidence dead code only" scope. |
| Duplicate hash/auth implementations | `sandbox/artifact/infrastructure/repository.py: relative_path_sha256_hex` vs `store.py: _path_hash_hex`; `sandbox/mcp/app.py: McpBearerAuth.__call__` vs `sandbox/security/mcp_internal_auth.py: _authorization_values` | Both pairs are independently-maintained duplicate logic, not dead code. One must stay in sync with a MySQL generated column and the other guards adjacent trust boundaries — consolidating is a security-relevant refactor, not a cleanup, and needs dedicated review. |
| Repeated quota-check block | `sandbox/services/workspace_quota_ledger.py: reserve / reserve_replacement / try_grow` | Same "measure → sum reservations → project → raise" shape repeated 3x with a slightly different reserved-term computation each time. Collapsing to a shared helper is a refactor with behavioral edge-case risk, not a straight deletion. |
| Seven near-identical single-field validators | `sandbox/config.py:759-824` (`_validate_max_process_count` etc.) | Could collapse into the multi-field-keyed pattern already used by `_validate_mysql_timeouts`/`_validate_mcp_positive_limits` in the same file. Refactor, not dead code. |
| Dead TTL config fields | `sandbox/config.py: draft_ttl_hours`, `conversation_ttl_days`, `audit_ttl_days` | Unread by any code path (the `ttl_cleanup.py` that consumed them was already deleted). Also documented in `.env.example`. Removing needs a coordinated `.env.example`/README pass, not just a code edit. Already flagged as dead in the team's `docs/2026-07-29-code-review.md`. |
| Leftover env-var plumbing for removed feature | `sandbox/config.py: session_ttl_minutes`, `cleanup_interval_minutes` | Read nowhere in Python, but still plumbed through `docker-compose.yml` and documented in `README.md` as if they control session auto-cleanup. Operator-facing; needs a docs/compose pass together. |
| Self-documented unused compat field | `sandbox/config.py: approval_timeout_seconds` | Comment already says `# unused: no sandbox HITL waiter`; kept only so existing `.env`/production validators don't reject an unknown key. Intentionally retained. |
| Deprecated, test-only function | `sandbox/paths.py: to_public_workspace_path()` | Docstring says `Deprecated`; only reference is its own unit test. Low value, left for a future hygiene pass. |
| Legacy wire/DB-compat enum members | `sandbox/models.py: ExecutionStatus.PENDING_APPROVAL/APPROVED/REJECTED`, `PolicyDecision.APPROVAL_REQUIRED` | Comments say "never emitted by formal runtime" but they may still describe historical DB rows. Not safe to remove without confirming no historical data uses these string values. |
| Config flags logged but not read for behavior | `agent/config.js: APPROVAL_MODE/APPROVAL_ENABLED`, `SYSTEM_PROMPT/PRODUCT_SYSTEM_PROMPT`, `AGENT_FORCE_INMEMORY` | Only consumed by the redacted startup log line (`effectiveConfig()`); no code path branches on them. Removing changes the ops startup log shape — flagged for confirmation with whoever owns ops dashboards before deletion. |
| Deprecated repository wrapper | `agent/src/infrastructure/mysql/repositories/tool-execution-repository.js: fingerprintToolArgs` | `@deprecated use integrityFingerprint`; only reachable via the also-test-only `repositories/index.js` barrel. Bundled with the barrel-file question below. |
| Test-only barrel files | `agent/src/application/index.js`, `agent/src/application/a2a/index.js`, `agent/src/domain/session/index.js`, `agent/src/infrastructure/outbox/index.js` | Not imported by production `src/`, but 4+ test files import them directly. Removing requires updating those test imports too; deferred as a separate test-hygiene pass rather than bundling into a dead-code cleanup. |
| Possibly-redundant direct dependency pin | `agent/package.json: @earendil-works/pi-ai` | No direct static import found; already a transitive dependency of `@earendil-works/pi-coding-agent` at the same pinned version. Could be an intentional explicit pin — needs confirmation before removal. |
| `.sr-only` CSS utility | `frontend/src/shared/styles/app.css` | Not currently applied by any component, but is a common a11y infra hook kept in reserve. Left in place rather than removed. |

## Deep investigation (confirmed 2026-07-29)

Whole-repo re-verification of every deferred row that was marked “needs
confirmation” or was otherwise ambiguous. Method: full-tree ripgrep + call-site
reads; no production code changed in this pass.

### Confirmed dead / misleading (safe cleanup candidates)

| Item | Verdict | Evidence | Recommended action |
| --- | --- | --- | --- |
| `draft_ttl_hours` / `conversation_ttl_days` / `audit_ttl_days` | **Dead settings** | Zero `settings.<field>` reads outside `sandbox/config.py`. Consumers lived in deleted `ttl_cleanup.py`. Still listed in `.env.example` (`SANDBOX_DRAFT_TTL_HOURS` etc.). Conversation disk GC is now **delete-on-delete** via Agent → `DELETE /sessions/{id}` (see `conversation-service.js` + `formal_session_runtime.remove_owned`). | Coordinated removal: config fields + `.env.example` + any ops docs that claim background retention. Do **not** reintroduce TTL unless product asks for it. |
| `session_ttl_minutes` / `cleanup_interval_minutes` | **Dead + operator-misleading** | Zero Python readers. Still injected in `docker-compose.yml` (`SANDBOX_SESSION_TTL_MINUTES`, `SANDBOX_CLEANUP_INTERVAL_MINUTES`) and documented in `README.md` as “会话空闲自动清理 / 清理任务运行间隔”. | Same coordinated pass: drop compose env, README rows, config fields. Current real GC is conversation delete/archive only (fail-soft). |
| `approval_timeout_seconds` | **Dead compat knob** | Comment accurate; no HITL waiter. Only present so pydantic/env accept the key. | Keep unless doing a deliberate env-schema break; low cost. |
| `to_public_workspace_path()` | **Test-only dead API** | Sole non-definition refs: `tests/test_paths.py`. Always returns `PUBLIC_WORKSPACE_TOKEN`. | Safe to delete fn + test in a hygiene PR. |
| `fingerprintToolArgs` | **Deprecated alias, zero prod callers** | Only defined in `tool-execution-repository.js`, re-exported from `repositories/index.js`. Production and tests call `integrityFingerprint` directly. | Delete export + barrel re-export; no call-site migrations needed. |
| `ExecutionStatus.PENDING_APPROVAL/APPROVED/REJECTED` | **Never written by formal path** | `execution_manager` / `formal_execution_runtime` only use PENDING/RUNNING/SUCCESS/FAILED/TIMEOUT/CANCELLED. Authoritative formal statuses in `sandbox/app/domain/types.py` are RUNNING→SUCCESS\|FAILED\|TIMEOUT\|CANCELLED\|UNKNOWN — **no approval trio**. Status columns are free-form strings (no MySQL ENUM of these values in migrations). Agent HITL uses a **different** vocabulary (`APPROVAL_STATUS` on Agent MySQL approvals). | Safe to remove from the Python enum for new code; residual historical rows (if any pre-formal DB) would still deserialize as plain strings if code reads `str` not `ExecutionStatus`. Prefer: delete members + grep any remaining switch arms; optional one-off SQL audit on prod `sandbox_executions.status`. |
| `PolicyDecision.APPROVAL_REQUIRED` | **Never emitted** | `policy_checker.check()` only returns ALLOW / HARD_DENY; former approval outcomes map to hard_deny. Enum retained so old strings still parse. Fixture `tests/fixtures/sse_events.json` still documents event type `approval_required` (Agent SSE product event — **not** this enum). | Enum member can go after confirming no JSON/API response still serializes `PolicyDecision` with that value. SSE fixture is unrelated and must stay if Agent still emits the event. |

### Confirmed live-but-narrow (not pure dead code)

| Item | Verdict | Evidence | Recommended action |
| --- | --- | --- | --- |
| Agent `APPROVAL_MODE` / `APPROVAL_ENABLED` | **Not only logged** — also **startup validation** | `validateProductionConfig` forbids `auto_approve` in production; `resolveApprovalMode` maps legacy boolean. **No** branch in `agent/src/` (policy/HITL) reads `config.APPROVAL_MODE` for tool gating — Agent durable approval is independent. Sandbox side: `settings.approval_mode` only used in the same production forbid path (`sandbox/config.py:1013`), not in `policy_checker`. | Treat as **ops/env surface + prod guardrail**, not runtime policy. Removing changes startup log **and** removes the auto_approve production hard-fail unless re-homed. Confirm with ops before dropping from `effectiveConfig()`. |
| Agent `SYSTEM_PROMPT` / `PRODUCT_SYSTEM_PROMPT` | **Config object values unused for LLM** | Built from `AGENT_SYSTEM_PROMPT` / `_FILE` via `composeSystemPrompt`, placed on `config`, appear only in `effectiveConfig()` (redacted). Runtime prompts come from **AgentVersion.systemPrompt** + `enterprise-system-prompt.js` / `pi-runtime-factory.js`. Zero `config.SYSTEM_PROMPT` / `config.PRODUCT_SYSTEM_PROMPT` reads in `agent/src/`. | **Stronger than original note:** env `AGENT_SYSTEM_PROMPT` is currently a **no-op for agent behavior**. Product risk if operators believe it sets the model prompt. Either wire it into enterprise prompt composition or document as deprecated and remove. |
| `AGENT_FORCE_INMEMORY` | **Fully dead flag** | Only set on `config` and logged by `effectiveConfig()`. MySQL client explicitly never falls back to in-memory. | Safe to remove from config + log + compose if present; no behavior change. |
| `@earendil-works/pi-ai` direct pin | **Intentional SSOT pin — keep** | No app static `import` from `@earendil-works/pi-ai`. Direct dep is required by: (1) `runtime-versions.json` + `docs/runbooks/sdk-upgrade.md` dual-pin checklist, (2) `agent/tests/sdk-compat/sdk-surface.test.js` asserts exact pin match, (3) pins top-level install to **0.80.3** while `pi-mcp-adapter` still pulls nested **0.74.2** — without the direct pin, resolution is less controlled. | **Do not remove.** Explicit pin is policy, not dead weight. |
| Test-only barrels (`application/index.js`, `a2a/index.js`, `domain/session/index.js`, `outbox/index.js`) | **Prod `src/` does not import them** (except `application/index.js` re-exports `a2a/index.js` for the barrel itself) | Tests import barrels (`load-concurrency`, `approval-mysql-fail-closed`, session-state-machine, outbox tests, etc.). | Hygiene: point tests at leaf modules, then drop barrels — optional. |
| `.sr-only` | **Unused class, intentional reserve** | Only definition in `app.css`; no TSX/HTML className. | Keep as a11y utility; zero risk. |

### Confirmed refactor / duplicate (not dead; leave or schedule dedicated PR)

| Item | Verdict | Evidence | Recommended action |
| --- | --- | --- | --- |
| `pipeWithBackpressure` vs `handleArtifactDownload` | **Doc lie + unused helper from prod path** | Comment claims “used by files.js”; `files.js` has an **independent** for-await + drain loop (also cancels `sanRes.body` on client close — slightly richer). `pipeWithBackpressure` is only referenced by its unit test; **datasets upload path does not call it either**. | Decision: (A) delete helper + test, or (B) wire `files.js` to shared helper and preserve cancel semantics. Prefer B only with a focused streaming regression test. |
| `relative_path_sha256_hex` vs `_path_hash_hex` | **Duplicate, semantically identical** | Both `sha256(utf-8 path).hexdigest().lower()`. Repo path is production MySQL-aligned; store path is FakeFormalArtifactRepository. | Low-risk: have fake import the real helper. Not urgent. |
| `McpBearerAuth` vs `require_mcp_internal_auth` | **Adjacent trust boundaries, similar code** | MCP public app (`sandbox/mcp/app.py`) vs Sandbox→MCP internal bridge (`mcp_internal_auth.py`). Internal path is stricter on header shape / whitespace. | **Do not casually unify** without a security review; different deployables and token settings (`settings.token` vs `settings.mcp_internal_token`). |
| Quota `reserve` / `reserve_replacement` / `try_grow` | **Live triplication** | Three methods ~lines 200 / 259 / 349 with shared measure→project→raise shape. | Dedicated refactor PR only; add property tests around reserved-term math first. |
| Seven single-field validators in `config.py` | **Live boilerplate** | Lines ~759–824 each wrap `_nonneg_int_field` with different defaults/maxima. | Pure style refactor; optional. |
| Wide exports (`requestCarrier`, `contextFromTraceContext`, `parseTraceparent`, `SESSION_COOKIE`) | **Internally used; export unused for some** | `requestCarrier` / `contextFromTraceContext`: only inside `telemetry.js`. `parseTraceparent`: only inside `trace-context.js` (module imported widely). `SESSION_COOKIE`: **exported but no external importer** — only used inside `cookies.js` via default param. | Can un-export `SESSION_COOKIE` / carrier helpers without behavior change; cosmetic. |

### Doc drift note (related)

Earlier `docs/2026-07-29-code-review.md` claimed `WorkspaceManager.remove_workspace()` had zero call sites. **That is stale:** `FormalSessionRuntime.remove_owned` → `remove_workspace`, exposed as `DELETE /sessions/{session_id}`, triggered by conversation delete. TTL subsystem remains absent; delete-on-delete GC is implemented.

## Follow-up implementation (2026-07-29)

Acted on investigation priorities (P0→P2):

| Priority | Change |
| --- | --- |
| P0 | Removed dead TTL/cleanup settings from `sandbox/config.py`; dropped compose inject + README/`.env.example` claims of idle/session TTL. Documented delete-on-delete GC. |
| P1 | Wired `AGENT_SYSTEM_PROMPT` / `PRODUCT_SYSTEM_PROMPT` into `resolveEnterpriseSystemPrompt` via `pi-runtime-factory` (AgentVersion wins; env product layer is fallback). |
| P2 | Removed `to_public_workspace_path`, `fingerprintToolArgs`, `pipeWithBackpressure` (+ dedicated tests), `AGENT_FORCE_INMEMORY`, legacy `ExecutionStatus` HITL members, `PolicyDecision.APPROVAL_REQUIRED`. Kept `approval_timeout_seconds` + `APPROVAL_MODE` prod guardrails. Kept `@earendil-works/pi-ai` pin. |

Not done (still deferred by design): MCP bearer dual impl, quota reserve collapse, validator collapse, test-only barrels, `.sr-only`, wide export surface cosmetics.

## Verification

- `agent/`: `npm test` → 1125 tests, 1124 pass / 1 fail both before and after
  (the 1 failure, `no-authoritative-run-map.unit.test.js`'s residual-Map
  whitelist check flagging `pi-mcp-adapter-factory.js:621`, pre-dates this
  cleanup and is unrelated to any file touched here).
- `api-server/`: `npm test` → 129/129 pass.
- `sandbox/`: `uv run pytest tests/` → 1008 pass / 15 fail / 6 skip, identical
  before and after (the 15 failures are pre-existing local-environment
  issues — e.g. `SANDBOX_POLICY_PROFILE=balanced` config-matrix and Python
  process-execution tests — reproduced on a clean `git stash` of this
  branch).
- `frontend/`: `npm test` → 217/217 pass; `npm run typecheck` and `npm run
  build` (tsc + vite) both clean.
- Follow-up (this pass): re-run targeted suites after P0–P2 (see command output
  in the implementing session).
