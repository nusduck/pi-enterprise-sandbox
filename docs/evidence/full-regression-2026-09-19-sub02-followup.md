# Full regression 2026-09-19 — SUB-02 browser follow-up

Date: 2026-09-19 (Asia/Singapore)

- In a fresh conversation, a text-only synthetic probe asked for two
  independent subagents and one nested child. No files, network, artifacts, or
  messages were requested.
- The Run reached `Succeeded` with `2 tools` and the structured result reported:
  - child A: `SUB02_CHILD_A_OK`, nested launch succeeded with
    `SUB02_NESTED_OK`;
  - child B: `SUB02_CHILD_B_OK`;
  - no depth-limit diagnostic at depth 2.
- Jev waited for the Run terminal state; CUA provided only the prompt and fresh
  result verification.

This strengthens the allowed depth-2 and sibling-subtask branches of `SUB-02`.
It does not close the case: root-slot saturation, multiple concurrent parents,
depth ceiling, parent cancellation/Worker restart, queue cleanup, and reducing
the configured depth remain untested.
