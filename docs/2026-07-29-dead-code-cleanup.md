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
