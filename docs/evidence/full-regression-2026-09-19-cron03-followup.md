# Full regression 2026-09-19 — CRON-03 browser follow-up

Date: 2026-09-19 (Asia/Singapore)

Scope: administrator browser session, synthetic schedule only. Mechanical
navigation/clicks and bounded waits used Jev `jev-1.13.0`; CUA handled form
text entry and fresh-state inspection. No schedule was deleted.

## Observed

- Created `cron-regression-recovery-20260919` with a future-only cron
  expression (`0 0 1 1 *`), Asia/Singapore timezone, and a missing synthetic
  path prompt. The UI showed the schedule enabled with next run 2027-01-01.
- `Run now` queued executions successfully. The first two manual executions
  eventually showed `SUCCEEDED` in refreshed execution history; the prompt did
  not produce a failed Run, so this is not counted as a failure-history pass.
- Editing the schedule with a syntactically valid but nonexistent Agent ID was
  rejected in the UI with `Selected agent is not active for this organization`;
  the schedule was not changed.
- Replaced the prompt with a harmless synthetic recovery marker, cleared the
  optional Agent ID, saved the update, and ran it again. Execution history
  showed the new run `SUCCEEDED`.
- Paused the schedule at the end of the probe; the UI showed `Resume`.

## Boundary

This strengthens the browser CRUD/Run-now/history/update/pause branches of
`CRON-01` and the invalid-agent fail-closed branch related to `CRON-03`. It does
not close `CRON-03`: no genuine failed execution followed by a successful
repair was observed, and Worker restart/WAITING_INPUT or approval linkage for a
scheduled run remains open.
