# Full regression TODO-01 follow-up (2026-09-20)

## Scope

This additive record covers the browser-executable synthetic branch of
`TODO-01`. It uses no private data and does not change production source.

## Browser execution

- In an administrator Chat session, a new conversation was created through the
  visible New Chat control.
- The task asked the Agent to use the real todo tool to create exactly five
  synthetic W-briefing items, mark only the first complete, and leave the
  remaining four pending. The prompt prohibited files, MCP, and artifacts.
- The run reached `Succeeded` with `1 tool` in roughly three seconds.
- The rendered execution result contained a five-row table:
  1. `Inspect source rows` — `completed`
  2. `Validate duplicates and missing values` — `pending`
  3. `Calculate 2021-2023 changes` — `pending`
  4. `Generate a review checklist` — `pending`
  5. `Record remaining limitations` — `pending`
- A Jev-controlled reload then re-rendered the same conversation and the same
  five-row table, proving the visible todo projection survived reload. Jev
  returned a stale-state/step-limit handback after the reload; the fresh AX
  state, not the handback label, is the verification evidence.

## Result impact

The exact-five-item, one-complete/four-pending, real-tool, and reload-persistence
subassertions are verified for this synthetic branch. `TODO-01` remains
`PARTIAL`: it still lacks the required W-data progress report and broader
five-item persistence/event matrix. The Agent explicitly noted that the first
item's completed state was a requested plan state, not proof that data analysis
had already run.
