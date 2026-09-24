# Full regression RUN-01 follow-up (2026-09-20)

## Scope

This additive record covers another real foreground cancellation branch for
`RUN-01`. The command was harmless and synthetic; no files, MCP, network, or
artifacts were used.

## Browser execution

- A fresh administrator conversation started exactly one foreground `sleep 30`
  task with the marker `RUN01_SHOULD_NOT_COMPLETE_20260920` reserved for the
  natural-completion case.
- While the Run was visibly `Running`, the Stop control was activated through
  the current AX state. The live Run did not return the reserved completion
  marker.
- After convergence, the conversation showed `Cancelled · 1 tool · 10s`, an
  `Execution interrupted` card, and a `Resume` affordance. The original user
  message remained exactly once.
- A fresh AX read confirmed the Stop control was gone after cancellation; a
  second Stop action was therefore not available from the UI. No duplicate
  cancellation request is claimed.

## Result impact

This strengthens the real early-stop and interrupted-run convergence branch of
`RUN-01`. The case remains `PARTIAL`: repeated-cancel idempotency, queued-run
cancellation, and the full correction-after-cancel matrix remain open. The
earlier evidence and this capture do not claim a successful natural completion.
