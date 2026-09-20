# Full regression 2026-09-19 — RUN-02 hard Steer follow-up

Date: 2026-09-19 (Asia/Singapore)

- A first fresh Run started `sleep 60`, accepted a Steer request, but the
  foreground command completed naturally before the change took effect. The
  Run returned `RUN02_STEER_OK_20260919`, without the base completion marker;
  this is not hard-interrupt evidence.
- A second fresh Run started `sleep 180` and was visibly `Running · 1 tool`.
  A Steer request was submitted immediately, but after 30 seconds the
  authoritative container process check still showed a live `sleep` process
  and the UI still showed Running. The Steer request did not interrupt the
  tool within that observation window.
- The active Run was then stopped through the visible Stop control as cleanup.
  The UI converged to `Cancelled · 1 tool`; a fresh sandbox process check showed
  only the normal `docker-init`, `node`, and `ps` probe processes, with no
  residual sleep process.

This strengthens RUN-01 cancellation and cleanup, but does not establish
RUN-02's required “Steer interrupts an active tool and changes subsequent
output” assertion. RUN-02 remains partial.
