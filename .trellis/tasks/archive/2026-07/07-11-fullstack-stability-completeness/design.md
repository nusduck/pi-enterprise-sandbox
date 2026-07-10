# Design: supervised full-stack hardening

## Delivery model

The supervising agent owns architecture, task boundaries, patch review and final evidence. Grok works one child task at a time in a constrained session. Each cycle is:

1. Supervisor provides active task, relevant specs, exact files and acceptance tests.
2. Grok first writes/updates failing regression tests and explains the failure mechanism.
3. Grok implements the smallest coherent cross-layer fix for the full child requirement.
4. Supervisor inspects the diff, runs targeted checks, requests corrections, then runs broader integration checks.
5. Only a reviewed child is eligible for archive; the parent remains open until all children integrate.

Grok may not read `.env` or secret-bearing files. Initial audit sessions are read-only. Implementation sessions use a dedicated worktree when practical so supervisor-owned Trellis/bootstrap changes remain isolated.

## Target boundaries

### Single-user authentication boundary

- Authentication middleware distinguishes auth-disabled access, browser JWT access and trusted service-token access.
- Public-route matching is explicit and exact/prefix semantics are tested so `/` cannot expose every endpoint.
- No owner columns, acting-user propagation or cross-user authorization semantics are introduced in this iteration.

### Workspace and artifact path gate

- One shared resolver maps `(authorized session, user path)` to a physical path under that session workspace.
- Text write, binary upload, read/download, artifact submit/register/download and MCP tool surfaces call this resolver.
- Artifact records include `session_id` in the domain response/internal record. Lookup for download is `(session_id, artifact_id)`, not global artifact ID.
- Submission requires an existing regular file and records its actual size; symlink escape is rejected after resolution.

### Request-scoped Node context

- Replace module-level `_traceId`, `_sessionId` and `_approvalNotifier` with factories/objects created inside `handleChat`.
- A Sandbox client instance carries `traceId` and auth headers.
- A sandbox-tool factory closes over the client, session ID getter and notifier for one chat turn.
- Stateless helpers may stay exported for tests, but concurrent turns share no mutable request values.

### Execution lifecycle

- Per-session admission uses an atomic lock primitive around check-and-set.
- Active execution records hold subprocess/process-group handles and a cancellation signal.
- Cancel sends termination, escalates if necessary, waits/reaps, persists `CANCELLED`, and releases the session lock exactly once.
- Completion racing with cancellation has a deterministic terminal-state rule covered by tests.

### Python Agent transition

- Python runtime exposes a chat orchestration service with the existing SSE event contract.
- Node BFF proxies browser requests/streams during transition rather than hosting core agent state.
- Route selection is explicit through configuration. Compatibility mode remains available until parity tests cover history, tools, approval, trace, artifact and abort.
- Shared protocol fixtures prevent drift between Python producer, Node proxy and browser consumer.

### Frontend protocol and rendering

- SSE parser is an independently testable incremental parser/consumer with explicit flush and abort behavior.
- Rendering creates DOM nodes and assigns `textContent`/safe properties for untrusted values. External URLs are validated against the expected same-origin API shape before assignment.
- State changes are explicit transition helpers for start/token/tool/approval/file/error/done/abort/switch rather than scattered deep mutation where tests cannot observe invariants.
- Authentication is isolated in a client/session module; API helpers attach bearer tokens without storing secrets in markup or logs.

## Compatibility and migrations

- API additions are backward compatible. Security fixes may intentionally turn formerly successful unauthorized requests into 401/403/404.
- Frontend and Node clients are updated in the same child as changed wire behavior.
- Each risky phase documents rollback configuration and data compatibility.

## Verification strategy

- Unit: policy/path/repository/manager/SSE parser/state/render helpers.
- API integration: FastAPI TestClient and Node HTTP handlers with stub Sandbox.
- Concurrency: overlapping promises/threads with distinct trace, session, approval and workspace identities.
- Contract: shared event fixtures consumed by Python/Node/frontend tests.
- Stack: Compose health, one multi-turn conversation, approval, binary upload, cancellation and artifact delivery.
