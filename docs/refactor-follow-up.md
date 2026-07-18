# Refactor follow-up

This file tracks the remaining work required before the refactor can satisfy
the final acceptance criteria in `plan.md`. A passing unit-test suite is not a
substitute for these production and integration gates.

## P0 — functional completion

1. **Bind the real `pi-mcp-adapter`.**
   Install and lock the reviewed package, implement one binder against its
   verified public API, connect the secret resolver, and add a real mock-MCP
   integration test. Remove `docs/pr06-mcp-adapter-deferred.md` only after the
   production path can register and invoke an MCP tool.
2. **Finish the A2A delivery surface.**
   Wire `A2A_PUBLIC_BASE_URL` and credential configuration into deployment,
   provide owner-scoped artifact byte streaming, expose credential
   issue/rotate/revoke administration, and add the frontend A2A/API panel
   required by `plan.md`.
3. **Remove the residual Sandbox compatibility persistence.**
   Replace remaining SQLite/PostgreSQL runtime repositories with the MySQL
   control-plane repositories. Keep hermetic test fakes, not a second runtime
   backend.
4. **Align active documentation with the implemented session model.**
   `AgentSession` owns one Workspace. Remove remaining active documentation
   that describes Conversation-derived workspace identity or ordinary Bash
   approval.

## P0 — release gates

Run and preserve evidence for:

- real MySQL migration, rollback, foreign-key, and concurrent event-sequence tests;
- Redis restart, Outbox retry, lease recovery, and live SSE fallback;
- Agent/Sandbox restart during model and tool execution;
- cross-tenant and cross-session isolation;
- 100 concurrent SSE clients, 50 concurrent Runs, and 20 concurrent Sandbox
  executions;
- a large streaming Dataset upload with bounded memory;
- end-to-end Dataset → Run → Python/process → `submit_artifact` → refresh →
  download;
- A2A invoke, stream, reconnect, cancel, audit, and Artifact delivery.

## P1 — cleanup

- Remove legacy `enterprise-agent-kit` after all production imports use only
  the three enterprise extensions.
- Remove compatibility Skill mount paths after callers use
  `/home/sandbox/skill`.
- Resolve the persistent `/tmp` versus `tmpfs /tmp` product decision.
- Add a full distributed trace backend and verify the frontend trace tree.
- Split future work into reviewable commits by subsystem; do not repeat the
  single large PR-02–PR-14 implementation commit.

## Completion rule

Do not mark the refactor complete while any P0 item remains open. Update this
file in the same commit that adds the corresponding implementation and test
evidence.
