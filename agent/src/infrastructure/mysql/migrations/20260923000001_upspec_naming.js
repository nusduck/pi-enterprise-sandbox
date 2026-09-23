/**
 * 库表命名与字段约束按 UPspec《数据库设计规范》落标（库缩写 `agsvc`）。
 *
 * - 表：`<业务名>` → `tbl_agsvc_<业务名>`，一条 `RENAME TABLE` 原子完成；外键、触发器随表迁移。
 * - 索引：`ind_agsvc_<表缩写>_(a|i)<序号>`，≤18 字节；`a` 唯一、`i` 普通，按旧名字典序编号。
 *   `RENAME INDEX` 只改元数据，不重建；外键依附的索引同样可改名，外键约束名不变。
 * - 字段：定长且 ≤16 的 `varchar(16)` 改为 `char(16)`；无默认值的 NOT NULL 列补默认值
 *   （字符串 `''`、整数 `0`、时间 `'1970-01-01 00:00:00.000'`——UPSQL 5.7 的
 *   `ALTER COLUMN … SET DEFAULT` 只接受字面量）。
 *
 * 有意不补默认值（漏写时由数据库拒绝，AGENTS.md §2 fail-closed）：主键列；身份/租户/引用列
 * （`*_id`、`*_subject`、`*_provider`）；操作者（`*_by`）；凭据与完整性（`*_hash`、`*_key`、
 * `*_digest`、`sha256`、`checksum`、`username`）；以及 5.7 不允许默认值的 JSON/TEXT 列。
 * 有业务语义的 NULL（如 `expires_at IS NULL` = 永不过期）保留。
 *
 * 不改：Knex 自身的记账表 `knex_migrations*`（工具所有，改名会让 Knex 认不出已执行的迁移）、
 * 外键约束名与触发器名（规范未约束，改名需 DROP + ADD）。
 *
 * 每张表的索引改名、类型与默认值调整合并为一条 `ALTER TABLE`，单表原子；中途失败按
 * 部分迁移恢复 runbook 处理，已改名的表以 `SHOW TABLES LIKE 'tbl_agsvc_%'` 为准。
 */

export const TABLE_PREFIX = 'tbl_agsvc_';

/** [旧表名, 新表名] */
export const TABLE_RENAMES = Object.freeze([
  ['a2a_api_credentials', 'tbl_agsvc_a2a_api_credentials'],
  ['a2a_audit_events', 'tbl_agsvc_a2a_audit_events'],
  ['a2a_tasks', 'tbl_agsvc_a2a_tasks'],
  ['agent_definitions', 'tbl_agsvc_agent_definitions'],
  ['agent_session_snapshots', 'tbl_agsvc_agent_session_snapshots'],
  ['agent_sessions', 'tbl_agsvc_agent_sessions'],
  ['agent_versions', 'tbl_agsvc_agent_versions'],
  ['approvals', 'tbl_agsvc_approvals'],
  ['artifacts', 'tbl_agsvc_artifacts'],
  ['auth_credentials', 'tbl_agsvc_auth_credentials'],
  ['conversation_external_refs', 'tbl_agsvc_conversation_external_refs'],
  ['conversations', 'tbl_agsvc_conversations'],
  ['cron_job_runs', 'tbl_agsvc_cron_job_runs'],
  ['cron_jobs', 'tbl_agsvc_cron_jobs'],
  ['datasets', 'tbl_agsvc_datasets'],
  ['domain_outbox', 'tbl_agsvc_domain_outbox'],
  ['dsh_session_events', 'tbl_agsvc_dsh_session_events'],
  ['dsh_sessions', 'tbl_agsvc_dsh_sessions'],
  ['exec_artifacts', 'tbl_agsvc_exec_artifacts'],
  ['exec_datasets', 'tbl_agsvc_exec_datasets'],
  ['exec_jobs', 'tbl_agsvc_exec_jobs'],
  ['idempotency_records', 'tbl_agsvc_idempotency_records'],
  ['messages', 'tbl_agsvc_messages'],
  ['organization_external_refs', 'tbl_agsvc_organization_external_refs'],
  ['organization_memberships', 'tbl_agsvc_organization_memberships'],
  ['organizations', 'tbl_agsvc_organizations'],
  ['process_executions', 'tbl_agsvc_process_executions'],
  ['run_events', 'tbl_agsvc_run_events'],
  ['run_interactions', 'tbl_agsvc_run_interactions'],
  ['runs', 'tbl_agsvc_runs'],
  ['sandbox_audit_events', 'tbl_agsvc_sandbox_audit_events'],
  ['sandbox_executions', 'tbl_agsvc_sandbox_executions'],
  ['sandbox_sessions', 'tbl_agsvc_sandbox_sessions'],
  ['task_memories', 'tbl_agsvc_task_memories'],
  ['task_todos', 'tbl_agsvc_task_todos'],
  ['tool_executions', 'tbl_agsvc_tool_executions'],
  ['trace_spans', 'tbl_agsvc_trace_spans'],
  ['user_skill_enablements', 'tbl_agsvc_user_skill_enablements'],
  ['users', 'tbl_agsvc_users'],
  ['workspace_quota_reservations', 'tbl_agsvc_workspace_quota_reservations'],
]);

/** 新表名 → [旧索引名, 新索引名][] */
export const INDEX_RENAMES = Object.freeze({
  tbl_agsvc_a2a_api_credentials: [
    ['uk_a2a_cred_key_id', 'ind_agsvc_aac_a1'],
    ['a2a_api_credentials_agent_id_foreign', 'ind_agsvc_aac_i1'],
    ['a2a_api_credentials_service_user_id_foreign', 'ind_agsvc_aac_i2'],
    ['idx_a2a_cred_org_agent', 'ind_agsvc_aac_i3'],
    ['idx_a2a_cred_org_client', 'ind_agsvc_aac_i4'],
  ],
  tbl_agsvc_a2a_audit_events: [
    ['idx_a2a_audit_owner_client', 'ind_agsvc_aae_i1'],
    ['idx_a2a_audit_task', 'ind_agsvc_aae_i2'],
    ['idx_a2a_audit_trace', 'ind_agsvc_aae_i3'],
  ],
  tbl_agsvc_a2a_tasks: [
    ['uk_a2a_tasks_run_id', 'ind_agsvc_at_a1'],
    ['a2a_tasks_agent_id_foreign', 'ind_agsvc_at_i1'],
    ['a2a_tasks_conversation_id_foreign', 'ind_agsvc_at_i2'],
    ['a2a_tasks_credential_id_foreign', 'ind_agsvc_at_i3'],
    ['a2a_tasks_user_id_foreign', 'ind_agsvc_at_i4'],
    ['idx_a2a_tasks_org_agent', 'ind_agsvc_at_i5'],
    ['idx_a2a_tasks_owner_client', 'ind_agsvc_at_i6'],
    ['idx_a2a_tasks_owner_context', 'ind_agsvc_at_i7'],
  ],
  tbl_agsvc_agent_definitions: [
    ['uk_agent_definitions_org_name', 'ind_agsvc_ad_a1'],
    ['idx_agents_org', 'ind_agsvc_ad_i1'],
  ],
  tbl_agsvc_agent_session_snapshots: [
    ['uk_session_snapshot', 'ind_agsvc_assn_a1'],
  ],
  tbl_agsvc_agent_sessions: [
    ['uk_agent_sessions_sandbox_session_id', 'ind_agsvc_as_a1'],
    ['uk_agent_sessions_workspace_id', 'ind_agsvc_as_a2'],
    ['agent_sessions_agent_version_id_foreign', 'ind_agsvc_as_i1'],
    ['agent_sessions_conversation_id_foreign', 'ind_agsvc_as_i2'],
    ['agent_sessions_user_id_foreign', 'ind_agsvc_as_i3'],
    ['idx_agent_sessions_owner', 'ind_agsvc_as_i4'],
    ['idx_agent_sessions_status_recovery', 'ind_agsvc_as_i5'],
  ],
  tbl_agsvc_agent_versions: [
    ['uk_agent_version', 'ind_agsvc_av_a1'],
  ],
  tbl_agsvc_approvals: [
    ['approvals_run_id_foreign', 'ind_agsvc_appr_i1'],
    ['idx_approvals_org_status', 'ind_agsvc_appr_i2'],
  ],
  tbl_agsvc_artifacts: [
    ['uk_artifact_file', 'ind_agsvc_arti_a1'],
    ['artifacts_user_id_foreign', 'ind_agsvc_arti_i1'],
    ['idx_artifacts_owner', 'ind_agsvc_arti_i2'],
  ],
  tbl_agsvc_auth_credentials: [
    ['uk_auth_credentials_external_user', 'ind_agsvc_ac_a1'],
    ['uk_auth_credentials_username', 'ind_agsvc_ac_a2'],
    ['idx_auth_credentials_org', 'ind_agsvc_ac_i1'],
  ],
  tbl_agsvc_conversation_external_refs: [
    ['conversation_external_refs_user_id_foreign', 'ind_agsvc_cer_i1'],
    ['idx_conv_external_refs_conversation', 'ind_agsvc_cer_i2'],
  ],
  tbl_agsvc_conversations: [
    ['conversations_agent_id_foreign', 'ind_agsvc_conv_i1'],
    ['conversations_user_id_foreign', 'ind_agsvc_conv_i2'],
    ['fk_conversations_parent_run', 'ind_agsvc_conv_i3'],
    ['idx_conversations_owner', 'ind_agsvc_conv_i4'],
    ['idx_conversations_owner_lineage', 'ind_agsvc_conv_i5'],
  ],
  tbl_agsvc_cron_job_runs: [
    ['uk_cron_job_runs_idempotency', 'ind_agsvc_cjr_a1'],
    ['uk_cron_job_runs_scheduled', 'ind_agsvc_cjr_a2'],
    ['cron_job_runs_run_id_foreign', 'ind_agsvc_cjr_i1'],
    ['idx_cron_job_runs_claimed', 'ind_agsvc_cjr_i2'],
    ['idx_cron_job_runs_history', 'ind_agsvc_cjr_i3'],
  ],
  tbl_agsvc_cron_jobs: [
    ['cron_jobs_agent_id_foreign', 'ind_agsvc_cj_i1'],
    ['cron_jobs_user_id_foreign', 'ind_agsvc_cj_i2'],
    ['idx_cron_jobs_claim_token', 'ind_agsvc_cj_i3'],
    ['idx_cron_jobs_due', 'ind_agsvc_cj_i4'],
    ['idx_cron_jobs_owner', 'ind_agsvc_cj_i5'],
  ],
  tbl_agsvc_datasets: [
    ['datasets_agent_session_id_foreign', 'ind_agsvc_dset_i1'],
    ['datasets_conversation_id_foreign', 'ind_agsvc_dset_i2'],
    ['datasets_user_id_foreign', 'ind_agsvc_dset_i3'],
    ['idx_datasets_owner', 'ind_agsvc_dset_i4'],
  ],
  tbl_agsvc_domain_outbox: [
    ['idx_outbox_claim', 'ind_agsvc_dob_i1'],
    ['idx_outbox_claim_token', 'ind_agsvc_dob_i2'],
    ['idx_outbox_stale_claim', 'ind_agsvc_dob_i3'],
  ],
  tbl_agsvc_dsh_session_events: [
    ['idx_dsh_session_events_owner', 'ind_agsvc_dse_i1'],
  ],
  tbl_agsvc_dsh_sessions: [
    ['idx_dsh_sessions_owner', 'ind_agsvc_ds_i1'],
  ],
  tbl_agsvc_exec_artifacts: [
    ['idx_exec_artifacts_owner', 'ind_agsvc_ea_i1'],
    ['idx_exec_artifacts_session', 'ind_agsvc_ea_i2'],
    ['idx_exec_artifacts_workspace', 'ind_agsvc_ea_i3'],
  ],
  tbl_agsvc_exec_datasets: [
    ['uniq_exec_datasets_idem', 'ind_agsvc_ed_a1'],
    ['idx_exec_datasets_owner', 'ind_agsvc_ed_i1'],
    ['idx_exec_datasets_session', 'ind_agsvc_ed_i2'],
    ['idx_exec_datasets_workspace', 'ind_agsvc_ed_i3'],
  ],
  tbl_agsvc_exec_jobs: [
    ['idx_exec_jobs_created', 'ind_agsvc_ej_i1'],
    ['idx_exec_jobs_owner', 'ind_agsvc_ej_i2'],
    ['idx_exec_jobs_run', 'ind_agsvc_ej_i3'],
    ['idx_exec_jobs_status', 'ind_agsvc_ej_i4'],
  ],
  tbl_agsvc_messages: [
    ['uk_message_sequence', 'ind_agsvc_msg_a1'],
    ['uk_messages_session_pi_entry', 'ind_agsvc_msg_a2'],
    ['idx_messages_session', 'ind_agsvc_msg_i1'],
    ['idx_messages_session_pi_kind', 'ind_agsvc_msg_i2'],
  ],
  tbl_agsvc_organization_external_refs: [
    ['idx_org_external_refs_org', 'ind_agsvc_oer_i1'],
  ],
  tbl_agsvc_organization_memberships: [
    ['organization_memberships_user_id_foreign', 'ind_agsvc_om_i1'],
  ],
  tbl_agsvc_process_executions: [
    ['idx_process_executions_execution', 'ind_agsvc_pe_i1'],
    ['idx_process_executions_owner', 'ind_agsvc_pe_i2'],
    ['idx_process_executions_run', 'ind_agsvc_pe_i3'],
    ['idx_process_executions_session', 'ind_agsvc_pe_i4'],
    ['process_executions_user_id_foreign', 'ind_agsvc_pe_i5'],
  ],
  tbl_agsvc_run_events: [
    ['uk_run_event_sequence', 'ind_agsvc_re_a1'],
    ['idx_run_events_created', 'ind_agsvc_re_i1'],
    ['run_events_org_id_foreign', 'ind_agsvc_re_i2'],
  ],
  tbl_agsvc_run_interactions: [
    ['uk_run_interactions_tool_call', 'ind_agsvc_ri_a1'],
    ['idx_run_interactions_owner_run', 'ind_agsvc_ri_i1'],
    ['idx_run_interactions_resume', 'ind_agsvc_ri_i2'],
    ['idx_run_interactions_waiting', 'ind_agsvc_ri_i3'],
    ['run_interactions_agent_session_id_foreign', 'ind_agsvc_ri_i4'],
    ['run_interactions_responded_by_foreign', 'ind_agsvc_ri_i5'],
    ['run_interactions_tool_execution_id_foreign', 'ind_agsvc_ri_i6'],
    ['run_interactions_user_id_foreign', 'ind_agsvc_ri_i7'],
  ],
  tbl_agsvc_runs: [
    ['idx_runs_cancel_requested_at', 'ind_agsvc_run_i1'],
    ['idx_runs_owner', 'ind_agsvc_run_i2'],
    ['idx_runs_parent', 'ind_agsvc_run_i3'],
    ['idx_runs_session', 'ind_agsvc_run_i4'],
    ['idx_runs_status', 'ind_agsvc_run_i5'],
    ['idx_runs_trace', 'ind_agsvc_run_i6'],
    ['runs_agent_version_id_foreign', 'ind_agsvc_run_i7'],
    ['runs_conversation_id_foreign', 'ind_agsvc_run_i8'],
    ['runs_user_id_foreign', 'ind_agsvc_run_i9'],
  ],
  tbl_agsvc_sandbox_audit_events: [
    ['idx_sandbox_audit_execution', 'ind_agsvc_sae_i1'],
    ['idx_sandbox_audit_owner', 'ind_agsvc_sae_i2'],
    ['idx_sandbox_audit_process', 'ind_agsvc_sae_i3'],
    ['idx_sandbox_audit_session', 'ind_agsvc_sae_i4'],
    ['idx_sandbox_audit_trace', 'ind_agsvc_sae_i5'],
    ['sandbox_audit_events_user_id_foreign', 'ind_agsvc_sae_i6'],
  ],
  tbl_agsvc_sandbox_executions: [
    ['uk_sandbox_execution_run_tool_call', 'ind_agsvc_se_a1'],
    ['uk_sandbox_execution_tool_execution', 'ind_agsvc_se_a2'],
    ['idx_sandbox_executions_agent_session', 'ind_agsvc_se_i1'],
    ['idx_sandbox_executions_owner', 'ind_agsvc_se_i2'],
    ['idx_sandbox_executions_run', 'ind_agsvc_se_i3'],
    ['idx_sandbox_executions_session', 'ind_agsvc_se_i4'],
    ['idx_sandbox_executions_status', 'ind_agsvc_se_i5'],
    ['sandbox_executions_user_id_foreign', 'ind_agsvc_se_i6'],
  ],
  tbl_agsvc_sandbox_sessions: [
    ['uk_sandbox_sessions_agent_session_id', 'ind_agsvc_ss_a1'],
    ['uk_sandbox_sessions_workspace_id', 'ind_agsvc_ss_a2'],
    ['idx_sandbox_sessions_owner', 'ind_agsvc_ss_i1'],
    ['idx_sandbox_sessions_status', 'ind_agsvc_ss_i2'],
    ['sandbox_sessions_user_id_foreign', 'ind_agsvc_ss_i3'],
  ],
  tbl_agsvc_task_memories: [
    ['idx_task_memories_owner_key', 'ind_agsvc_tm_i1'],
    ['idx_task_memories_owner_recent', 'ind_agsvc_tm_i2'],
    ['task_memories_user_id_foreign', 'ind_agsvc_tm_i3'],
  ],
  tbl_agsvc_task_todos: [
    ['uk_task_todos_position', 'ind_agsvc_tt_a1'],
    ['idx_task_todos_owner_session', 'ind_agsvc_tt_i1'],
    ['task_todos_user_id_foreign', 'ind_agsvc_tt_i2'],
  ],
  tbl_agsvc_tool_executions: [
    ['uk_tool_call', 'ind_agsvc_te_a1'],
    ['tool_executions_agent_session_id_foreign', 'ind_agsvc_te_i1'],
  ],
  tbl_agsvc_trace_spans: [
    ['idx_trace_spans_owner', 'ind_agsvc_ts_i1'],
    ['idx_trace_spans_parent', 'ind_agsvc_ts_i2'],
    ['idx_trace_spans_run', 'ind_agsvc_ts_i3'],
    ['trace_spans_run_id_foreign', 'ind_agsvc_ts_i4'],
    ['trace_spans_user_id_foreign', 'ind_agsvc_ts_i5'],
  ],
  tbl_agsvc_user_skill_enablements: [
    ['uk_user_skill_enablements_owner_name', 'ind_agsvc_use_a1'],
    ['idx_user_skill_enablements_owner', 'ind_agsvc_use_i1'],
    ['user_skill_enablements_user_id_foreign', 'ind_agsvc_use_i2'],
  ],
  tbl_agsvc_users: [
    ['uk_users_external_subject', 'ind_agsvc_usr_a1'],
  ],
});

/** `varchar(16)` → `char(16)`；`previousDefault` 供 down 还原。 */
export const CHAR_COLUMNS = Object.freeze([
  { table: 'tbl_agsvc_cron_jobs', column: 'concurrency_policy', default: '', previousDefault: null },
  { table: 'tbl_agsvc_cron_jobs', column: 'misfire_policy', default: '', previousDefault: null },
  { table: 'tbl_agsvc_cron_jobs', column: 'schedule_type', default: '', previousDefault: null },
  { table: 'tbl_agsvc_exec_datasets', column: 'status', default: 'uploading', previousDefault: 'uploading' },
  { table: 'tbl_agsvc_exec_jobs', column: 'kind', default: 'bash', previousDefault: 'bash' },
  { table: 'tbl_agsvc_run_interactions', column: 'resume_phase', default: 'NONE', previousDefault: 'NONE' },
  { table: 'tbl_agsvc_run_interactions', column: 'status', default: '', previousDefault: null },
  { table: 'tbl_agsvc_task_todos', column: 'status', default: '', previousDefault: null },
]);

/** 新表名 → [列名, 默认值 SQL 字面量][] */
export const COLUMN_DEFAULTS = Object.freeze({
  tbl_agsvc_a2a_api_credentials: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['status', '\'\''],
    ['updated_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_a2a_audit_events: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['event_type', '\'\''],
  ],
  tbl_agsvc_a2a_tasks: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['updated_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_agent_definitions: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['name', '\'\''],
    ['status', '\'\''],
    ['updated_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_agent_session_snapshots: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['pi_sdk_version', '\'\''],
    ['snapshot_format', '\'\''],
    ['snapshot_version', '0'],
  ],
  tbl_agsvc_agent_sessions: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['status', '\'\''],
    ['updated_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_agent_versions: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['pi_sdk_version', '\'\''],
    ['status', '\'\''],
    ['version_no', '0'],
  ],
  tbl_agsvc_approvals: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['status', '\'\''],
  ],
  tbl_agsvc_artifacts: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['display_name', '\'\''],
    ['relative_path', '\'\''],
    ['size_bytes', '0'],
    ['status', '\'\''],
  ],
  tbl_agsvc_auth_credentials: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['updated_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_conversation_external_refs: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_conversations: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['status', '\'\''],
    ['updated_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_cron_job_runs: [
    ['claimed_at', '\'1970-01-01 00:00:00.000\''],
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['scheduled_at', '\'1970-01-01 00:00:00.000\''],
    ['status', '\'\''],
    ['updated_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_cron_jobs: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['name', '\'\''],
    ['timezone', '\'\''],
    ['updated_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_datasets: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['original_filename', '\'\''],
    ['status', '\'\''],
    ['stored_relative_path', '\'\''],
  ],
  tbl_agsvc_domain_outbox: [
    ['aggregate_type', '\'\''],
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['event_type', '\'\''],
    ['status', '\'\''],
  ],
  tbl_agsvc_dsh_sessions: [
    ['revision', '\'\''],
  ],
  tbl_agsvc_exec_artifacts: [
    ['name', '\'\''],
    ['size_bytes', '0'],
    ['source_path', '\'\''],
  ],
  tbl_agsvc_exec_datasets: [
    ['original_filename', '\'\''],
    ['stored_relative_path', '\'\''],
  ],
  tbl_agsvc_exec_jobs: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['label', '\'\''],
    ['status', '\'\''],
  ],
  tbl_agsvc_idempotency_records: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['expires_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_messages: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['message_type', '\'\''],
    ['role', '\'\''],
    ['sequence_no', '0'],
  ],
  tbl_agsvc_organization_external_refs: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_organization_memberships: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['role', '\'\''],
    ['status', '\'\''],
  ],
  tbl_agsvc_organizations: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['name', '\'\''],
    ['status', '\'\''],
    ['updated_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_process_executions: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['status', '\'\''],
  ],
  tbl_agsvc_run_events: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['event_type', '\'\''],
    ['event_version', '0'],
    ['sequence_no', '0'],
  ],
  tbl_agsvc_run_interactions: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['interaction_type', '\'\''],
  ],
  tbl_agsvc_runs: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['queue_name', '\'\''],
    ['source', '\'\''],
    ['status', '\'\''],
    ['updated_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_sandbox_audit_events: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['event_type', '\'\''],
  ],
  tbl_agsvc_sandbox_executions: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['kind', '\'\''],
    ['status', '\'\''],
  ],
  tbl_agsvc_sandbox_sessions: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['status', '\'\''],
    ['updated_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_task_memories: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_task_todos: [
    ['content', '\'\''],
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['position', '0'],
    ['updated_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_tool_executions: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['risk_level', '\'\''],
    ['status', '\'\''],
    ['tool_name', '\'\''],
    ['tool_source', '\'\''],
  ],
  tbl_agsvc_trace_spans: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['kind', '\'\''],
    ['name', '\'\''],
    ['started_at', '\'1970-01-01 00:00:00.000\''],
    ['status', '\'\''],
    ['updated_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_user_skill_enablements: [
    ['enabled_at', '\'1970-01-01 00:00:00.000\''],
    ['file_count', '0'],
    ['skill_name', '\'\''],
    ['total_bytes', '0'],
    ['updated_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_users: [
    ['created_at', '\'1970-01-01 00:00:00.000\''],
    ['status', '\'\''],
    ['updated_at', '\'1970-01-01 00:00:00.000\''],
  ],
  tbl_agsvc_workspace_quota_reservations: [
    ['bytes', '0'],
  ],
});

const IDENT = /^[a-z0-9_]+$/;

function q(name) {
  if (!IDENT.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `\`${name}\``;
}

function charDefinition(length, defaultValue) {
  const def = defaultValue === null ? '' : ` DEFAULT '${defaultValue.replace(/'/g, "''")}'`;
  return `CHAR(${length}) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL${def}`;
}

function varcharDefinition(defaultValue) {
  const def = defaultValue === null ? '' : ` DEFAULT '${defaultValue.replace(/'/g, "''")}'`;
  return `VARCHAR(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL${def}`;
}

function renamedTables() {
  return TABLE_RENAMES.map(([, to]) => to);
}

/** 每张新表一条 ALTER 的子句（up 方向）。 */
function upClauses(table) {
  const clauses = [];
  for (const [from, to] of INDEX_RENAMES[table] ?? []) {
    clauses.push(`RENAME INDEX ${q(from)} TO ${q(to)}`);
  }
  for (const c of CHAR_COLUMNS.filter((x) => x.table === table)) {
    clauses.push(`MODIFY COLUMN ${q(c.column)} ${charDefinition(16, c.default)}`);
  }
  for (const [column, literal] of COLUMN_DEFAULTS[table] ?? []) {
    clauses.push(`ALTER COLUMN ${q(column)} SET DEFAULT ${literal}`);
  }
  return clauses;
}

function downClauses(table) {
  const clauses = [];
  for (const [column] of COLUMN_DEFAULTS[table] ?? []) {
    clauses.push(`ALTER COLUMN ${q(column)} DROP DEFAULT`);
  }
  for (const c of CHAR_COLUMNS.filter((x) => x.table === table)) {
    clauses.push(`MODIFY COLUMN ${q(c.column)} ${varcharDefinition(c.previousDefault)}`);
  }
  for (const [from, to] of INDEX_RENAMES[table] ?? []) {
    clauses.push(`RENAME INDEX ${q(to)} TO ${q(from)}`);
  }
  return clauses;
}

/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  const pairs = TABLE_RENAMES.map(([from, to]) => `${q(from)} TO ${q(to)}`);
  await knex.raw(`RENAME TABLE ${pairs.join(', ')}`);
  for (const table of renamedTables()) {
    const clauses = upClauses(table);
    if (clauses.length > 0) await knex.raw(`ALTER TABLE ${q(table)} ${clauses.join(', ')}`);
  }
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  for (const table of renamedTables()) {
    const clauses = downClauses(table);
    if (clauses.length > 0) await knex.raw(`ALTER TABLE ${q(table)} ${clauses.join(', ')}`);
  }
  const pairs = TABLE_RENAMES.map(([from, to]) => `${q(to)} TO ${q(from)}`);
  await knex.raw(`RENAME TABLE ${pairs.join(', ')}`);
}
