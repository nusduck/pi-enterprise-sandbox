# Implementation plan

## Phase 0 — Baseline and worker authorization

- [x] Obtain explicit authorization before sending repository code to Grok.
- [ ] Run Grok read-only audit; supervisor verifies every P0/P1 finding against current files.
- [ ] Establish clean install commands for Python, API Server and Frontend.
- [ ] Record baseline results for pytest, Node tests (if any), frontend build and Compose config.
- [ ] Create/link the child tasks below and curate their spec/research context.

## Phase 1 — Backend security and artifact integrity

- [x] Add failing tests for JWT public-path bypass.
- [x] Add failing tests for artifact traversal, missing file, symlink escape and cross-session artifact ID.
- [x] Add failing binary round-trip upload/download and quota tests.
- [x] Fix authentication matching and centralize public route policy.
- [x] Route artifact and upload paths through the shared workspace resolver; add session-scoped artifact lookup.
- [x] Preserve binary bytes and enforce size/quota before durable write.
- [x] Run targeted auth/artifact/file/isolation tests, then full pytest.

## Phase 2 — Request concurrency and execution lifecycle

- [x] Add Node tests that overlap two chat contexts and prove distinct trace/session/approval routing.
- [x] Replace Node module globals with per-request client/tool context.
- [x] Add Python tests for atomic same-session admission and cancel/complete races.
- [x] Track subprocess groups and implement real cancellation/reaping/terminal status.
- [x] Handle browser/SSE disconnect by cancelling or safely detaching work according to documented policy.
- [x] Run Node, Python concurrency and multi-turn integration suites.

## Phase 3 — Python Agent production cutover

- [x] Inventory feature parity between Node `handleChat` and `sandbox/agent`.
- [x] Complete Python tools, message restore, approval, trace, artifact and cancellation behavior.
- [x] Add an explicit config-selected Node proxy/Python agent route.
- [x] Add shared SSE contract fixtures and parity tests.
- [x] Run multi-turn, tool, approval, artifact, error and abort scenarios through the selected production route.
- [x] Document rollback and only then make Python-first the production default. (Default remains `node`; flip via `AGENT_RUNTIME=python` after ops smoke.)

## Phase 4 — Frontend resilience and security

- [x] Introduce a lightweight test runner/DOM environment consistent with the current Vanilla JS stack.
- [x] Extract/test incremental SSE parsing including split UTF-8/chunks, final flush, malformed events and abort.
- [x] Make stream/conversation/approval/artifact state transitions explicit and test stale-state prevention.
- [x] Replace unsafe untrusted `innerHTML`/inline handlers with DOM APIs or narrowly sanitized templates.
- [x] Add accessible live status/error/approval semantics, focus management and keyboard/mobile tests.
- [x] Verify upload retry and artifact-only download behavior.

## Phase 5 — Integrated quality gates and operations

- [x] Configure CI jobs for Python, Node/frontend tests, frontend build and Compose validation.
- [x] Add only the lint/type/format gates that are configured and reproducible; document exact versions.
- [x] Improve readiness to check required dependencies without leaking details.
- [x] Run clean-install full suites and a Compose smoke matrix.
- [x] Update active docs, `.env.example`, Trellis specs and improvement status.
- [x] Supervisor performs the parent requirement-by-requirement completion audit.

## Rollback points

- Security/path fixes: preserve API compatibility while reverting only the affected policy/path changes if necessary.
- Node context: keep old behavior only on a short-lived feature branch; no runtime flag for a known cross-request race.
- Python cutover: retain explicit Node compatibility route/config until parity and production smoke evidence are complete.
