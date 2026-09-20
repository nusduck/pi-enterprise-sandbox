# Full regression 2026-09-19 — REC-01 browser follow-up

Date: 2026-09-19 (Asia/Singapore)

- A fresh admin conversation entered durable `Waiting input` with one
  `ask_user_question` interaction and two visible synthetic options.
- The `agent-worker` Compose service was restarted in isolation. Docker
  reported the same worker container healthy again (`Up 11 seconds (healthy)`).
- Jev reloaded the browser page. Fresh AX state still showed `Waiting input`
  and both options, proving the interaction was not lost by the worker restart
  or browser reload.
- Selecting `REC01_OPTION_A_20260919` resumed the Run. The final state was
  `Succeeded`, the waiting state disappeared, and the conversation contained
  `REC01_RECOVERED_20260919`.

This is real evidence for the WAITING_INPUT → worker restart → browser reload →
answer recovery branch of `REC-01`. Model-in-flight, tool-in-flight, approval,
and multi-worker takeover variants remain open.
