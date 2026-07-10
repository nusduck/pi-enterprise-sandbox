# Design: request context and execution lifecycle

## Node request context

### Problem

Module-level `_traceId`, `_sessionId`, and `_approvalNotifier` (or equivalent) are written during one chat turn and read by shared helpers. Overlapping turns can route tools, approvals, and traces to the wrong session.

### Target shape

```
handleChat(req)
  client = createSandboxClient({ traceId, auth })
  tools  = createSandboxTools({ client, getSessionId, notifier })
  // no module mutation of per-request values
```

- `createSandboxClient` returns an object that stamps headers/trace per call.
- `createSandboxTools` closes over that client and session accessors.
- Tests: fire two concurrent `handleChat` stubs with different trace/session IDs and assert tool calls and notifier targets never cross.

## Execution lifecycle (Python)

### Admission

- Hold a per-session lock around busy check + mark-running.
- Store process group id / subprocess handle on the active execution record.

### Cancel

1. Mark cancelling (idempotent).
2. Signal process group (SIGTERM then SIGKILL after timeout).
3. Reap; persist `CANCELLED` if still non-terminal.
4. Release session lock once.

### Disconnect

- When the SSE producer owns the execution, wire `request.is_disconnected` / abort to cancel.
- If policy is detach-only for background jobs, document it; default for interactive chat is cancel.

## Compatibility

- Public REST/SSE event names stay the same.
- New busy/cancel error messages may be more precise but keep stable status codes where possible.
