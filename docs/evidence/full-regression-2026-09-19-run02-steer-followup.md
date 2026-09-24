# Full regression browser evidence — RUN-02 Steer follow-up

Date: 2026-09-19 (Asia/Singapore)

## Observed run

- Started a fresh browser conversation with the user-authored synthetic probe:
  run only the foreground harmless command `sleep 60`, make no files or other
  tool calls, and wait for Steer.
- The UI showed `Running · 1 tool` before intervention.
- Used the visible `Steer` control and sent:
  `Steer now: abort the sleep immediately and only answer STEER_HARD_OK. Do not
  run any other command or tool.`
- The final UI showed `Succeeded · 1 tool · 1m 03s`, with 0 artifacts,
  0 processes, and 0 approvals. Run ID prefix `01M2WW3T8W751P…`; workspace
  prefix `01M2WW3T8JZYC4…`; conversation prefix `01M2WW3T8FB793…`; trace
  prefix `c063c3a4a67463…`.
- The actual final response was `STEER_HARD_OK`.

## Interpretation

This proves the Steer control was accepted and the run eventually completed
with the requested response. It does **not** prove hard interruption of the
foreground process: the observed 1m03s duration is consistent with the
requested 60-second sleep completing naturally before the model responded.
RUN-02 therefore remains `PARTIAL`, not `PASS`.

No files, artifacts, external services, or persistent cleanup operations were
used in this run.
