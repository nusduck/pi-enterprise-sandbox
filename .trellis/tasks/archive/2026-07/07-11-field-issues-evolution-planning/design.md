# Parent Architecture and Integration Design

## Target

```text
Browser
  → Node BFF (auth, ownership, upload edge, SSE relay)
  → Node Agent Service (official SDK, Run/Session, Extension, Skill/tools)
  → Python Sandbox (policy enforcement, execution, files, artifacts, audit)
  → PostgreSQL + shared POSIX workspace + optional Redis + archive object store
```

## Cross-Cutting Contracts

- Identity: signed user/org context plus independent service authentication.
- Resource: conversation_id/workspace_id/session/run/tool/attachment/artifact IDs; no physical paths.
- Event: append-only versioned events with event_id + monotonic sequence.
- Tool: versioned schema, side-effect class, policy version, trace and idempotency.
- Path: two logical roots materialized inside Session execution environment.
- Recovery: database event log + Sandbox execution ledger; unknown is never auto-replayed.

## Delivery Gates

Identity/SDK contract → attachment P0 and path/network foundations → Extension policy → Session persistence → independent Agent cutover → tools/Skill capabilities → parent integration review.

Each child owns its migration and rollback. The parent only authorizes integration when upstream acceptance is green; tree position does not imply dependency without the explicit list in PRD/child plan.

