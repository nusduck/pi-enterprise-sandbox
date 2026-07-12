# F4 — Process and Interaction UI

## Goal

Process list + console (live stdout/stderr, stdin, signal, cancel, offset history)；Composer Running mode: Steer / Follow-up / Stop；Budget display；Resume entry for interrupted runs.

## Dependencies

F3 UI; backend B2/B3/B6 APIs (stub if not ready).

## Acceptance Criteria

- [x] Process log realtime display
- [x] Steer / Follow-up / Stop in running mode
- [x] Budget visible when backend provides usage
- [x] Interrupted run shows resume entry
