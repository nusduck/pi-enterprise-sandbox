# Full regression browser evidence — CHAT-05 parallel conversations

Date: 2026-09-19 (Asia/Singapore)

## Observed behavior

- Started conversation A with a synthetic 10-second foreground loop. The UI
  showed it running with one active tool.
- While A was still running, selected `New Chat` and created conversation B.
- Conversation B independently completed in 1 second with the exact response
  `PARALLEL_SECOND_OK`, without tools, files, or artifacts. Run ID prefix
  `01M2WW…` was visible in its details as `Sandbox · CHTVKC`, trace prefix
  `6bd78a03…`.
- Returned to conversation A through the recent-conversation list. A remained
  intact and completed independently in 12 seconds with the exact response
  `PARALLEL_FIRST_DONE`.
- A's tool details showed a completed 10-second bash loop. Run ID prefix
  `01M2WW…`, sandbox session `68FGV8`, trace prefix `3dfa722c…`.

This is browser evidence for independent conversation state and concurrent
foreground execution. No files, artifacts, external services, or persistent
cleanup operations were used.

## 2026-09-20 Jev continuation

- Started conversation A with a 25-second harmless foreground sleep. While its
  UI showed `Running`, Jev opened a separate blank conversation B; the sidebar
  showed `2 active`.
- B completed independently with `CHAT05_B_DONE_20260920`, one tool, and a
  `Succeeded` terminal state. Its conversation contained no A text.
- Returning to A through the recent-conversation list showed its original Run
  still intact and `Succeeded` with `CHAT05_A_DONE_20260920`; its prompt and
  output were not replaced by B's.
- This strengthens the positive parallel-switch/ownership branch. The full
  case remains partial because the required R/W upload-to-artifact workflow
  was not used in this synthetic probe.
