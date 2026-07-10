# Frontend resilience security and accessibility

## Goal

Harden SSE consumption, conversation/stream state transitions, DOM rendering against injection, and core accessibility—backed by automated frontend tests for the Vanilla JS SPA.

## Requirements

### R1 — SSE parsing

- Incremental parser must handle fragmented chunks, multiple events per chunk, stream errors, trailing buffers, abort, and disconnect deterministically.
- Malformed events must not crash the UI or corrupt conversation state.

### R2 — State transitions

- Explicit transitions for conversation switch, streaming start/end, approvals, artifacts, retries, abort, and errors.
- Switching conversations mid-stream must not leave stale tokens, approvals, or artifacts from the previous conversation.

### R3 — Rendering security

- Avoid HTML/attribute injection from model output, tool results, filenames, URLs, and server error text.
- Prefer DOM APIs / `textContent` over untrusted `innerHTML`; remove inline event-handler strings where practical.
- External URLs assigned to links/resources must validate against expected same-origin API shape before use.

### R4 — Accessibility and UX

- Core flows keyboard-usable; accessible status/error/approval semantics (live regions or equivalent).
- Reasonable mobile and desktop layout behavior for chat, approval, and artifact actions.
- Upload retry and artifact-only download behavior remain correct.

## Acceptance Criteria

- [ ] Automated tests cover SSE fragmentation, final flush, malformed events, and abort.
- [ ] Tests cover conversation switch mid-stream and approval/artifact state reset.
- [ ] Injection attempts via model/tool/filename/error text do not execute HTML or inline handlers.
- [ ] Keyboard and live-status checks exist for primary error/approval surfaces.
- [ ] Frontend test suite and production build pass.

## Out of Scope

- Backend auth/path fixes.
- Multi-user login account UX (deferred ownership task).
- Full visual redesign.

## Dependencies

- Shared SSE fixtures from agent cutover are useful but not strictly required; frontend can test against recorded fixtures.
