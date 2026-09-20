# Full regression follow-up: browser reload and run catch-up (2026-09-19)

## Scope

- Case: `CHAT-06` (browser reload / reconnect while a run is active).
- Method: Jev was used for browser acceleration where applicable; CUA was used for the reload and independent accessibility-state verification.
- Data: no private files, no external credentials, no destructive action.

## Reproduction and observation

1. Created a fresh conversation with the harmless prompt: execute foreground `sleep 15`, do not use other tools, and answer `RELOAD_CATCHUP_OK` after natural completion.
2. Confirmed the run was active, then reloaded the browser page while it was running.
3. After reload, the page initially showed the new-conversation shell. The recent-conversations list retained the original prompt.
4. Reopened that recent conversation. The run was still shown as `Running · 1 tool · 8s` at the first post-reload observation.
5. After the expected completion window, the same conversation showed `Succeeded · 1 tool · 17s`.
6. Expanded the execution tree and independently verified the completed sandbox tool call:
   - command: `sleep 15`
   - duration: `15s`
   - output: `(no output)`
   - source: `sandbox`
   - run trace prefix: `7f31841e`
   - sandbox session label: `V851YR`
7. The context inspector showed `Run · Succeeded`, `Artifacts 0`, `Files 0`, `Tools 1`, `Processes 0`, and `Approvals 0`.

## Result

`CHAT-06` is **PARTIAL**, not PASS. The browser reload did not lose the backend run or its active history, and reopening the recent conversation caught up to the final run state. However, the post-reload rendered message area exposed the original prompt and execution tree but did not independently expose the assistant's final response text, so the exact `RELOAD_CATCHUP_OK` response could not be verified from the refreshed UI.

## Additional Jev reload probe (2026-09-20)

- A fresh administrator conversation ran one foreground `sleep 15` probe with
  the reserved marker `CHAT06_RELOAD_DONE_20260920`.
- Jev executed the page reload while the Run was active. After the 15-second
  window, fresh accessibility state showed `Succeeded · 1 tool · 16s`; the
  expanded tree independently showed `bash sleep 15`, `15s`, `(no output)`,
  and source `sandbox`.
- The post-reload conversation still did not render the reserved assistant
  marker. This repeats the earlier projection gap rather than closing it:
  active Run/tool catch-up is evidenced, but final assistant-text catch-up is
  still not independently verifiable in this UI path.
