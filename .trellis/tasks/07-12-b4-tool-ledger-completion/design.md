# Design — B4

## Ledger fields

tool_call_id, run_id, session_id, conversation_id, workspace_id, tool_name, arguments, status, execution_id, idempotency_key, started_at, finished_at, result_summary, error.

## Edit hardening (ADR §9)

unique old_string; multi-match returns count+lines; unified diff; hashes; race check; large files; apply_patch tool.
