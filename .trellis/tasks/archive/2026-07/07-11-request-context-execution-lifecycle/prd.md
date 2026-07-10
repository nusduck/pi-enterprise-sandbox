# Node request context and execution lifecycle

## Goal

Eliminate cross-request mutable state in the Node API/agent edge and implement atomic execution admission, real process cancellation, and disconnect cleanup in the Python execution path—without changing the public chat SSE contract.

## Requirements

### R1 — Request-scoped Node context

- Concurrent Node chat requests must not share mutable `traceId`, sandbox `sessionId`, or approval notifier state.
- Replace module-level globals in `api-server/services/sandbox-client.js` and `api-server/sandbox-tools.js` with per-request factories/objects created inside `handleChat` (or equivalent entry).
- A Sandbox client instance carries `traceId` and auth headers for one turn.
- A sandbox-tool factory closes over the client, session ID getter, and notifier for one chat turn only.
- Stateless helpers may remain exported for tests, but concurrent turns share no mutable request values.

### R2 — Atomic execution admission

- Per-session execution admission must be atomic (check-and-set under a lock primitive).
- A second concurrent execution for the same session must be rejected or queued only according to documented policy; default is reject with a clear busy error.
- Session/conversation busy state must remain consistent after admit, complete, cancel, and failure.

### R3 — Real cancellation

- `ExecutionManager.cancel()` (or equivalent) must terminate the real process group, not only flip metadata.
- Cancel must escalate if needed, wait/reap, persist terminal status `CANCELLED`, and release the session lock exactly once.
- Completion racing with cancellation has a deterministic terminal-state rule covered by tests.

### R4 — Disconnect / abort cleanup

- Client disconnect/abort on chat/SSE must stop agent work where supported, release resources, and leave a consistent persisted status.
- Documented policy: cancel in-flight execution on disconnect when the stream owns that execution; otherwise safely detach without leaving orphan locks.

## Acceptance Criteria

- [ ] Two overlapping Node chat turns prove distinct trace/session/approval routing (no cross-talk).
- [ ] Module-level request globals for trace/session/notifier are removed or reduced to non-request defaults with no concurrent mutation.
- [ ] Same-session concurrent admission is atomic; busy session returns a deterministic error.
- [ ] Cancelling a running execution terminates the real process (observed via process exit / group signal); lock and status are correct.
- [ ] Cancel vs complete race has a single terminal status covered by tests.
- [ ] SSE/client abort path releases resources and does not leave abandoned busy sessions indefinitely.
- [ ] Node checks, Python concurrency/execution tests, and multi-turn integration suites pass for the touched surface.

## Out of Scope

- Backend JWT/public-path and artifact path integrity (child `07-11-backend-security-artifact-integrity`).
- Python agent production route cutover (child `07-11-python-agent-production-cutover`).
- Frontend SSE parser and DOM hardening (child `07-11-frontend-resilience-security`).
- Multi-user ownership columns.

## Dependencies

- Prefer landing after security/path fixes so execution tests do not fight unstable auth fixtures; may proceed in parallel on Node-only files if needed.
