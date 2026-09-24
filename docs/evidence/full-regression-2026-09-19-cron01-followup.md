# Full regression follow-up: scheduled-run lifecycle (2026-09-19)

## Scope

- Case: `CRON-01`.
- Method: browser UI with Jev-browser acceleration where applicable and CUA for form controls/verification.
- Schedule name: `jev-regression-20260919-cron01-once`.
- Prompt was synthetic and side-effect free: do not read files, call MCP, create files, send messages, or modify data; answer `CRON01_ONCE_OK`.

## Observed lifecycle

1. Created a `Run Once At Time` schedule in `Asia/Singapore` for `2026-09-19 21:11:00`.
2. The schedule list showed the new entry as `Enabled` with the expected one-time next-run timestamp.
3. Clicked `Run now`; the UI acknowledged `Run queued successfully.` and History showed a real run ID prefix `01M2WWHVAYQ6…`.
4. History initially showed `RUNNING`. After a bounded wait and list refresh, the same history entry showed `SUCCEEDED`.
5. Clicked `Pause`; the list showed `Paused` and no next run (`—`).
6. Clicked `Resume`; the UI acknowledged `Scheduled run resumed.` and the list returned to `Enabled`. Because the one-time timestamp had already passed, no new future occurrence was scheduled.
7. Paused the completed one-time schedule again to avoid future scheduling while the test resource remains for review.

## Result

The create → run-now → history → pause → resume lifecycle is **PARTIAL/PASS for the exercised subassertions**. The backend produced a real successful scheduled run and the authoritative list/history views reflected the state transitions. The final `CRON-01` deletion subassertion was intentionally not executed: deleting the persistent test schedule is an irreversible cleanup action and was not performed without an action-time confirmation. `CRON-01` therefore remains `PARTIAL` overall.

