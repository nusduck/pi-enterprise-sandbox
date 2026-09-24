# Full regression 2026-09-19 — CRON-03 failure-recovery follow-up

Date: 2026-09-19 (Asia/Singapore)

- Created the synthetic recurring schedule
  `cron03-failure-recovery-20260919` with cron `0 0 1 1 *`, timezone
  `Asia/Singapore`, and a prompt that reads the deliberately missing path
  `/tmp/jev-cron03-missing-20260919.txt`. The schedule was edited once to
  require the missing-file error to terminate the scheduled run.
- Two independent UI `Run now` executions were recorded in History. Both
  remained `SUCCEEDED` (`01M2X53KP4B7…` and `01M2X58RWGH2…`), so no `FAILED`
  history row was produced.
- Opening the second Run from Settings → Runs showed `Succeeded · 1 tool · 2s`.
  Its execution log showed one `read` step, the missing-file error, and the
  model message that it was stopping as instructed. The application still
  finalized the Run as `Succeeded`; this is not evidence of a failure-history
  or post-failure recovery path.
- Restarted only the `agent-worker` service. It returned healthy, and after a
  Jev-driven page refresh the schedule was still present and `Paused`; History
  still contained exactly the same two `SUCCEEDED` rows with no duplicate
  trigger.

Result: CRON-03 is partial. The schedule lifecycle, missing-file tool-error
observation, durable History projection, Worker restart persistence, and final
pause were verified. The required `FAILED` terminal state, correction followed
by a successful Run that preserves that failure row, and waiting
approval/input branches were not verified because this product treats the
missing-file tool error as a successful model-completed Run.
