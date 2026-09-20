# Full regression browser evidence — PROC-01 / JOB-01 continuation

Date: 2026-09-20 (Asia/Singapore)

## Probe

- In an authenticated admin browser session, a harmless background shell loop
  was started through the Chat UI:
  `for i in $(seq 1 20); do echo PROC01_BATCH_$i; sleep 1; done`.
- The Run returned `PROC01_STARTED_20260920` immediately and exposed a
  background job identifier in the conversation. No files, network, MCP, or
  artifacts were used.

## Process Console observations

- The execution tree exposed a `Background Process` card and an `Open Console`
  action. The Process Console showed the same command and the same job ID.
- `Load history` returned the complete stdout sequence
  `PROC01_BATCH_1` through `PROC01_BATCH_20`. The console exposed `both`,
  `stdout`, and `stderr` filters, log search, auto-scroll, history loading,
  and download controls.
- The stdin textbox was present but its `Stdin` button was disabled for this
  background process. `EOF`, `SIGTERM`, `SIGINT`, `SIGKILL`, and `Cancel
  process` controls were visible.
- A `SIGTERM` action was submitted and the console reported `Sent SIGTERM`,
  but the visible process card remained `running` during the observation
  window. A later fresh Runs view showed the associated Run as `Succeeded`,
  and a read-only container process check found no remaining matching loop.
  The UI signal-to-terminal transition was therefore not counted as fully
  proven; the no-residual check is supporting evidence only.
- A direct `Cancel process` click subsequently hit a CDP timeout. No claim is
  made that a second cancel was accepted.

## Result impact

- `PROC-01`: **PARTIAL, strengthened**. Process identity, live console,
  history-backed stdout, filters, search, and explicit non-interactive stdin
  behavior are evidenced. Full stdin/EOF and a conclusively observed live
  signal/cancel convergence remain open.
- `JOB-01`: **PARTIAL, strengthened**. This adds a real Process Console view
  for a background job; the prior browser evidence still covers the separate
  `job_list`/`job_output`/`job_kill` ledger path. A single probe proving every
  ledger and console operation against one job ID remains open.

No persistent resource was deleted and no production source was changed.
