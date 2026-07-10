# Full-stack stability and completeness optimization

## Goal

Bring the current three-service project to a production-coherent state by improving backend security, concurrency, lifecycle and persistence; completing the Python-first agent path; hardening frontend protocol handling and UX; and adding repeatable automated quality gates. The supervising agent directs Grok task-by-task, reviews every patch, and owns final integration verification.

## Scope

- Python Sandbox and optional Python Agent runtime under `sandbox/`.
- Node API/Agent edge under `api-server/`.
- Vanilla JavaScript SPA under `frontend/`.
- Cross-service REST/SSE contracts, Docker/Compose, tests, CI and active docs.
- Existing Trellis architecture/spec conventions and the non-negotiable principles in `IMPROVEMENT_PLAN.md`.

## Requirements

### R1 — Security and resource integrity

- JWT authentication must actually protect non-public routes when enabled; public path matching must not accidentally bypass all requests.
- Browser JWT and trusted service-token authentication must remain distinguishable and testable in the current single-user deployment model.
- Artifact registration/submission/download must use the same workspace-boundary resolver as file APIs, reject missing/non-files, and verify the artifact belongs to the path session.
- Conversation/workspace identifiers and all user-supplied paths must be traversal-safe.
- CORS, request sizes, upload sizes, auth error responses and logs must have production-safe defaults without exposing secrets.

### R2 — Concurrency and lifecycle correctness

- Concurrent Node chat requests must not share mutable trace ID, sandbox session ID or approval notifier state.
- Execution admission must be atomic per session; cancellation must terminate the real process group rather than only changing metadata.
- Client disconnect/abort must stop agent work where supported, release resources and leave a consistent persisted status.
- Session/conversation/workspace creation, reuse, TTL, deletion and busy-session cleanup must follow a documented lifecycle model without deleting active work or leaking abandoned resources.

### R3 — File and artifact completeness

- Binary upload must preserve bytes exactly; text APIs must remain compatible.
- Workspace and per-file quotas must apply consistently to text and binary writes.
- Explicit artifact submission remains the only user-delivery path; raw workspace file download is limited to authorized input inspection and cannot become an alternate artifact bypass.
- Artifact metadata, source execution and download behavior must remain persistent and auditable.

### R4 — Python-first Agent production path

- Resolve the current dual runtime state: Node remains a thin edge/BFF while Python owns agent orchestration, tool binding, approval, trace and message restore, or document and implement a bounded compatibility transition.
- The selected production chat route must support the same user-visible SSE contract, multi-turn restore, tools, approvals and artifact delivery as the existing route.
- Cutover must be feature-flagged or otherwise reversible until parity tests pass; no silent removal of the known-working path.

### R5 — Frontend resilience and completeness

- SSE consumption must handle fragmented chunks, multiple events, stream errors, trailing buffers, abort and disconnect deterministically.
- State transitions for conversation switching, streaming, approvals, artifacts and retries must not leave stale UI or cross-conversation data.
- Rendering must avoid HTML/attribute injection from model output, tool results, filenames, URLs and server error text; inline event-handler strings must be removed where practical.
- Core flows must be keyboard-usable, provide accessible status/error semantics, and behave on mobile and desktop.

### R6 — Automated quality and operations

- Add executable Node/frontend tests for request-scoped concurrency, SSE parsing/state behavior and rendering security; do not rely only on Python tests or syntax checks.
- Python tests must cover auth enforcement, service-token compatibility, artifact traversal/session mismatch, binary upload, cancellation and concurrency.
- CI must install all required runtimes/dependencies and run Python tests, Node tests, frontend tests/build, syntax/lint/type gates actually configured by the project, and Compose validation.
- Health/readiness must distinguish process alive from dependency-ready; production logs and traces must remain useful without leaking secrets.

### R7 — Compatibility and documentation

- Existing documented public REST/SSE behavior remains compatible unless a deliberate migration is documented with frontend and tests updated in the same phase.
- Update `README.md`, active `docs/`, `.env.example`, Compose and `.trellis/spec/` whenever behavior or conventions change.
- Remove or clearly mark stale claims in active audit/plan documents; archived design history remains history.

## Constraints

- Grok must never read or transmit `.env`, credentials, tokens, private keys, local databases or other secret-bearing runtime files; use `.env.example` only.
- Do not weaken sandbox isolation, approval policy or artifact-only delivery to make tests easier.
- Do not perform a big-bang rewrite. Each child deliverable must be independently reviewable, testable and reversible.
- Multi-user ownership, owner-column migrations, cross-user authorization and login-account UX are explicitly out of scope for this iteration.
- No commit, push, deployment or external message without explicit supervising-agent/user authorization.
- Current business-code changes from other authors must be preserved.

## Acceptance Criteria

- [x] P0 auth bypass, artifact traversal/session mismatch and binary corruption have regression tests that fail on the baseline and pass after fixes.
- [x] Two concurrent chat turns prove trace/session/tool/approval context cannot cross requests.
- [x] A running execution can be cancelled and the real process is observed terminated; lock and persisted status are correct.
- [x] Production chat uses the approved Python-first route or a documented reversible compatibility mode, with SSE/tool/approval/artifact parity tests.
- [x] Frontend automated tests cover SSE fragmentation/abort/error, state reset/switching, approval actions, artifact download and injection attempts.
- [x] Full Python, Node and frontend test suites, frontend production build and `docker compose config -q` pass from a clean dependency install.
- [x] Relevant Docker health/readiness checks pass with the stack running and no credentials appear in logs/test artifacts.
- [x] Active architecture/API/development/deployment docs and Trellis specs match implemented behavior.
- [x] Supervising agent completes a requirement-by-requirement audit and records evidence before this parent task is archived.

## Child Deliverables

1. Backend security and artifact integrity.
2. Node request-context concurrency and execution lifecycle.
3. Python Agent production cutover and parity.
4. Frontend resilience, security and accessibility.
5. Integrated quality gates, operations and documentation.

## Confirmed Baseline Findings

- `sandbox/main.py` currently includes `"/"` in JWT public prefixes, so every absolute request path matches the bypass.
- `sandbox/routers/artifacts.py` joins untrusted artifact paths directly and fetches artifacts globally by ID without session ownership verification.
- `sandbox/routers/files.py` decodes binary upload bytes as UTF-8 with replacement before writing.
- `api-server/services/sandbox-client.js` and `api-server/sandbox-tools.js` keep per-request trace/session/notifier values in module globals.
- `ExecutionManager.cancel()` explicitly changes metadata only; it does not terminate the process.
- Conversations have no persisted owner field; this is recorded for a future multi-user iteration and is not a completion criterion here.

## Notes

- The user explicitly authorized sending repository content to Grok. Secret-bearing files remain excluded unless they are strictly required for a later, separately reviewed step.
- `AUDIT.md` and `PLAN.md` contain stale v2 findings; current code and tests outrank them.
