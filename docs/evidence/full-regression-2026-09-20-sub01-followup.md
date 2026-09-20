# Full regression SUB-01 follow-up (2026-09-20)

## Scope

This additive browser record tests the parent/child orchestration branch of
`SUB-01`. It is explicitly not a successful R-release content verification.
No production source or files were changed.

## Browser execution

- A fresh administrator conversation submitted a parent task requesting exactly
  two read-only child tasks: one API/server inspection and one frontend-entry
  inspection. The prompt prohibited writes, MCP, messages, and artifacts.
- The Run exposed a real `Agent Execution Steps` tree and reached a terminal
  parent summary after ten tool steps and about 42 seconds.
- The parent reported two child results, both with explicit `NOT_FOUND`
  verdicts rather than the requested success markers:
  - API child: `SUB01_API_CHILD_NOT_FOUND_20260920`.
  - Frontend child: `SUB01_FRONTEND_CHILD_NOT_FOUND_20260920`.
- The parent independently reported that its permitted sandbox workspace had
  zero files and no API/frontend entry to inspect. It did not fabricate either
  success marker.

## Result impact

The real two-child dispatch and parent aggregation branch is observed, and the
negative/no-fabrication behavior is useful evidence. The required content
assertion is not passed: this Agent session does not expose the R-release
project or the requested API/frontend files. Parent cancellation, structured
IDs, and a positive path/conclusion remain unverified. `SUB-01` therefore stays
`PARTIAL`/blocked for content in this environment.
