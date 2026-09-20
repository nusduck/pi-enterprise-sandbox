# Full regression 2026-09-19 — REC-02 browser follow-up

Date: 2026-09-19 (Asia/Singapore)

- A fresh admin conversation started one harmless background Bash job and
  returned immediately with `REC02_JOB_STARTED_20260919`. The UI exposed the
  synthetic job id and showed the run as `Succeeded`; the completion marker
  `REC02_JOB_SHOULD_NOT_COMPLETE_20260919` was not present.
- Before interruption, a read-only process check inside `sandbox` observed the
  expected isolated `bwrap`/Bash/`sleep 45` process tree running as uid 10001.
- The sandbox container was then hard-killed as the in-scope interruption
  action and brought back with Compose. Docker reported the replacement
  `sandbox` container healthy.
- A fresh read-only process check in the recovered container showed only the
  normal `docker-init`, `node`, and probe processes; no prior `bwrap`, Bash, or
  `sleep` process remained.
- A new Jev-driven browser conversation completed successfully with the exact
  marker `REC02_RECOVERED_20260919` and no tool, file, network, or artifact
  side effects.

This is evidence for the hard-kill → container recovery → no residual process →
normal new Run branch of `REC-02`. A durable orphan-ledger/lease assertion and
concurrent-job accounting variant remain open; the first Run's UI status alone
does not prove those invariants.
