# Design — B6

## SDK maps

session.steer(text), session.followUp(text).

## Approval flow

running → waiting_approval → save checkpoint → release → approve/reject → restore → running/rejected.

## Budget fields

max_steps, max_tool_calls, max_run_duration, max_llm_tokens, max_cost, max_consecutive_tool_failures, max_processes.
