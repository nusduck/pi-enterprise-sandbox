# Full regression browser evidence — RUN-02 hard-interrupt attempt

Date: 2026-09-19 (Asia/Singapore)

## Observed run

- Started a fresh browser conversation with the synthetic foreground command:
  `for i in 1 2 3 4 5 6 7 8 9 10; do echo HARD_TICK_$i; sleep 2; done`.
- The run entered `Running · 1 tool` and exposed the visible `Steer` control.
- Sent the user-authored Steer instruction to stop immediately and answer only
  `HARD_INTERRUPTED_OK`.
- The final run was `Succeeded · 1 tool · 23s`; Run ID prefix
  `01M2WW823MA9AY…`; workspace prefix `01M2WW8237ZFJS…`; conversation prefix
  `01M2WW822RNCH1…`; trace prefix `2f7bd9f79fb8bf…`.
- Expanded the actual tool details. The recorded result contained every line
  `HARD_TICK_1` through `HARD_TICK_10`, and the tool was marked completed.
- The model's final response was `HARD_INTERRUPTED_OK`, but the tool output
  proves the process itself was not interrupted before natural completion.

## Interpretation

The UI accepts and surfaces Steer, but this run does not satisfy the hard
interrupt requirement. RUN-02 remains `PARTIAL`, not `PASS`.

No files, artifacts, external services, or persistent cleanup operations were
used in this run.
