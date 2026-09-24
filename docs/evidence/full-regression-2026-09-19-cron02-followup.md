# Full regression 2026-09-19 — CRON-02 follow-up

Date: 2026-09-19 (Asia/Singapore)

- Created `cron02-sg-utc-20260919` with `0 0 1 1 *` in
  `Asia/Singapore`. Its next-run projection was `2027/1/1 00:00:00`.
- Created `cron02-ny-utc-20260919` with `0 11 31 12 *` in
  `America/New_York`. The browser-local next-run projection was also
  `2027/1/1 00:00:00`; the two local cron expressions therefore represent the
  same UTC instant (2026-12-31 16:00 UTC). Both schedules were paused.
- Created `cron02-forbid-20260919` with the default
  `Skip while previous run is active` policy and a harmless 12-second
  foreground sleep. Two immediate `Run now` clicks produced one `RUNNING`
  history row and a visible `Cron job already has an active execution`
  notification; after refresh the single row became `SUCCEEDED`. The schedule
  was paused.
- Created `cron02-allow-20260919` with `Allow parallel runs` and a harmless
  10-second foreground sleep. Two immediate `Run now` clicks produced two
  distinct `RUNNING` rows, and after refresh both became `SUCCEEDED`. The
  schedule was paused.

Result: CRON-02's cross-timezone projection and both concurrency policy
branches are verified. Skip-vs-fire-once missed-trigger recovery and a fresh
one-time schedule trigger are not re-run here; the one-time trigger is covered
by the CRON-01 evidence, but the missed-time policies remain open.

Attempted missed-time continuation:

- Switched the create form to `Run Once At Time` and entered a future local
  time. The in-app browser's native `datetime-local` picker opened a
  `data:text/html` crash page; the app returned to no usable schedule page in
  that tab, and the form never created the schedule. A fresh in-app tab
  recovered the application. No schedule, Run, or database state was created
  by this attempt.
- This is recorded as a browser-control blocker for the `skip`/`fire_once`
  missed-trigger subcases, not as an application pass or failure.

## Missed-trigger recovery continuation (2026-09-20, Asia/Singapore)

- The first attempted `skip` window was discarded as invalid: the worker was
  stopped after it had already begun claiming the due occurrence.
- A second `skip` attempt was controlled through the browser UI. The schedule
  `cron02-misfire-skip-20260919` was set to `5 * * * *`, and its Edit view
  confirmed `Skip missed run`. The worker was stopped before `00:05:00` and
  restarted at `00:10:09` local time, more than one minute after the due time.
  After a Jev-driven Refresh, History still contained a `2026/9/20
  00:05:00 · SUCCEEDED` row with a Run ID rather than a skipped occurrence.
  This is negative evidence against the expected skip behavior; it is not
  counted as a pass. The schedule was paused afterward.
- The schedule `cron02-misfire-fire-once-20260919` was set to `9 * * * *`
  with `Run once after recovery`. The same worker stop window covered its
  `00:09:00` occurrence. After recovery and a Jev-driven Refresh, History
  contained exactly one `2026/9/20 00:09:00 · SUCCEEDED` row with a Run ID.
  This verifies one replayed missed occurrence; the schedule was paused
  afterward.
- The worker was healthy after recovery (`recovery scan complete actions=0`,
  BullMQ consumers started), and no test schedule was left enabled.

Result: CRON-02 now has verified timezone projection, both concurrency
branches, and the positive `fire_once` recovery branch. The controlled
`skip` recovery branch remains failed/partial because the persisted skip
policy produced a successful Run instead of a skipped history outcome. The
native `datetime-local` one-time creation path remains blocked by the earlier
in-app browser crash.
