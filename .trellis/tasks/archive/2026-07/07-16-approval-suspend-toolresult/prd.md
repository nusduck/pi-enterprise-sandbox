# PRD — Fix approval suspend toolResult polluting LLM context

## Problem

After a high-risk tool (e.g. `bash curl …`) hits approval:

1. Policy suspends execution (correct).
2. `ApprovalSuspendedError` was thrown from the tool.
3. `pi-agent-core` **caught the throw** and wrote a durable `toolResult` with  
   `isError: true` and text `Approval suspended: <id>`.
4. On approve, resume re-executed the tool successfully and injected weather data
   via a `[system]` user prompt — **without replacing** the failed toolResult.
5. The model saw both “tool failed / needs approval” and the successful payload,
   then re-issued a second bash call (“let me try another way”).

Double bash is therefore a **context pollution bug**, not intentional dual
execution of two distinct tool_call_ids (replay still uses the same id).

## Goals

- [x] Suspend path must not leave an `isError` toolResult that looks like a failed network call.
- [x] Suspend must stop the agent loop (`terminate: true`) so the model does not turn before approve.
- [x] Resume must rewrite the parked toolResult for that `tool_call_id` with the real outcome.
- [x] Unit tests cover placeholder result + session rewrite.

## Non-goals

- Changing policy risk scoring for curl/network.
- Changing UI approval UX.
- Removing the replay-with-same-tool_call_id design (that part is correct).

## Acceptance

- Approving a high-risk bash call after suspend yields **one** successful execution
  and the model continues from the real tool result without re-issuing the same call
  solely because of a residual “approval suspended” message.
