# Design — B1 Agent Session Persistence

## Data model (ADR §7.1)

- `agent_sessions`: id, conversation_id, sdk_session_id, workspace_id, sandbox_session_id, status, model_id, thinking_level, system_prompt_version, tool_registry_version, timestamps, last_compacted_at
- `agent_session_entries`: id, agent_session_id, sequence, entry_type, entry_payload, parent_entry_id, branch_id, created_at
- entry_type: user_message, assistant_message, tool_call, tool_result, custom, compaction, branch, model_change, system_prompt_change

## Restore flow (ADR §7.2)

Message → resolve conversation.agent_session_id → load entries → materialize JSONL → SessionManager.open → append user message → run → persist new entries.

## Risk controls

- Store `sdk_version` + `session_schema_version`; plan migration.
- Large tool results: summary + external storage hooks (coordinate retention later).
- On restore failure: explicit event, preserve raw data.

## Touch points

- `agent/chat-runner.js`, `agent/run-manager.js`, agent services
- Sandbox DB migrations / repositories as needed for session tables
- APIs: GET session, resume, entries (ADR §10)
