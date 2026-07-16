# Implementation Plan — Dynamic capability registration and introspection

## 1. Registry Core

- [x] Add a generic session-scoped capability registry and bounded latest-snapshot store under `agent/application/`.
- [x] Cover deterministic register/unregister/reconcile/list/search/describe/version behavior, metadata sanitization, and concurrent isolation with unit tests.

## 2. Profile and Resource Policy

- [x] Add explicit shared-skill policy parsing/copying and fail-closed validation to Agent Profiles.
- [x] Filter effective package/shared skills according to the profile without changing filesystem mounts.
- [x] Test all/allowlist/none modes and backward-compatible coding-profile behavior.

## 3. Enterprise Kit Registration

- [x] Add a profile-controlled `capabilities` extension/tool with bounded `list/search/describe` schemas and results.
- [x] Wire sandbox tools, extension load diagnostics, dynamic resources, MCP discovery, and skill reload into registry reconciliation.
- [x] Reconcile Pi's effective active tools and resource-loader skills after extension binding.
- [x] Strengthen prompt routing for capability inventory questions.

## 4. Runtime Diagnostics

- [x] Publish sanitized run/session snapshots and bounded registry update events.
- [x] Merge the latest compatible live snapshot into Agent extension diagnostics with configured-only fallback.
- [x] Preserve existing BFF response fields and add tests for live/configured/failed projections.

## 5. Frontend Projection

- [x] Extend capability schemas/types for additive registry status and scope fields.
- [x] Render actual configured/active/disabled/failed state and registry metadata without introducing parallel runtime state.
- [x] Add focused frontend tests.

## 6. Documentation

- [x] Document the registry/tool/profile policy in active architecture, API, development, and deployment/config docs.
- [x] Remove stale active claims that `skills/` is empty while preserving the zero-skill-capable runtime statement.

## 7. Verification Gates

- [x] Run focused Agent tests for registry, kit, MCP, skills, diagnostics, runtime/session binding, and fake provider behavior.
- [x] Run BFF capability/diagnostics tests and Node syntax checks for changed Agent/BFF files.
- [x] Run frontend tests and production build.
- [x] Run relevant Python/Compose contract tests if config or cross-service contracts change. *(extension runtime projection: 2/2 passed; final Agent/API/frontend images rebuilt and recreated)*
- [x] Rebuild/recreate the local stack and run a real inventory prompt proving complete skill enumeration through the `capabilities` tool plus live MCP registration. *(run `arun_5e680a92080e406c825f4ed4` completed; model called `capabilities` for 22 skills and 2 active MCP tools; a second user received only the configured fallback view)*
- [x] Review the diff for security, compatibility, concurrency, and unrelated user changes before completion.

## Rollback Points

- Registry/tool wiring is additive; remove profile registration and diagnostics merge to restore old behavior.
- Do not alter Pi SDK pin, database schema, or Sandbox execution security as part of this task.
