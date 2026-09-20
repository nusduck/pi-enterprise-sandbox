# Full regression 2026-09-19 — CHAT-07 two-follow-up queue

## Scope

This is an additive browser record for the positive `CHAT-07` queue branch. It does not rewrite the test design or claim the entire case is complete.

Browser: Codex in-app browser, local UPRC Agent, ordinary synthetic user `root@admin.comrt-20260919-a` (`User`).

## Procedure and observed state

1. Sent a synthetic prompt instructing the agent to run exactly one harmless foreground `sleep 8`, use no other tools, then answer `CHAT07_BASE_DONE`.
2. While the base run was visibly `Running`, sent two separate follow-up messages through the UI:
   - `CHAT07_FOLLOWUP_ONE ... answer exactly CHAT07_FOLLOWUP_ONE_OK`
   - `CHAT07_FOLLOWUP_TWO ... answer exactly CHAT07_FOLLOWUP_TWO_OK`
3. The UI showed both follow-ups as queued while the base run was active. The base execution completed with `CHAT07_BASE_DONE`.
4. A fresh AX snapshot after the queue drained showed:
   - `CHAT07_FOLLOWUP_ONE_OK`
   - `CHAT07_FOLLOWUP_TWO_OK`
   - no `Agent running` or `Running action` state
   - composer returned to a disabled Send state and the conversation state was `Succeeded`.

No file, MCP, artifact, or external-data operation was requested or observed in this probe.

## Interpretation

Confirmed: two follow-ups can be submitted during one foreground run and both are retained and executed after the base run, with the expected order/result visible in the conversation.

Remaining: cancellation while follow-ups are queued, queue behavior across multiple workers, and failure/retry branches are not covered; `CHAT-07` remains partial rather than a full pass.
