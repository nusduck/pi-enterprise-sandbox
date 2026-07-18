/**
 * PR-02 T1: plan §8 core MySQL schema (utf8mb4 / InnoDB) + Sandbox execution domain.
 *
 * Notes:
 * - runs.next_event_sequence allocates run_events.sequence_no (no SELECT MAX+1).
 * - messages are append-only rows (no Conversation messages JSON blob).
 * - DB triggers forbid UPDATE/DELETE on messages (stable names below).
 * - UNIQUE(conversation_id, status) on agent_sessions is omitted (multiple CLOSED
 *   rows would conflict; plan §8.8 allows transactional lock instead).
 * - domain_outbox.published_at is defined exactly once (no duplicate column builders).
 * - Composite primary uses **string** constraint names only. Knex MySQL create-table
 *   primaryKeys() wraps object options via alias SQL → illegal `as indexName`.
 * - up() uses withPartialDdlCleanup: MySQL DDL is non-transactional; on failure
 *   only this-run tables/triggers are dropped, then the error is rethrown.
 *
 * agent_sessions ↔ sandbox_sessions relationship (no cyclic FK):
 * - agent_sessions.sandbox_session_id is NOT NULL and is a **logical unique reference**
 *   (no FK to sandbox_sessions). Sandbox may create the sandbox_sessions row after
 *   Agent already persisted agent_sessions with a pre-allocated sandbox_session_id.
 * - sandbox_sessions.agent_session_id is likewise a **logical unique reference**
 *   (no FK to agent_sessions). Either side may be inserted first without FK cycles.
 * - Child Sandbox rows (process_executions, sandbox_executions) may FK to
 *   sandbox_sessions.sandbox_session_id once that row exists.
 * - 1:1 ownership uniques (PR-07A):
 *   uk_agent_sessions_workspace_id, uk_agent_sessions_sandbox_session_id,
 *   uk_sandbox_sessions_agent_session_id, uk_sandbox_sessions_workspace_id.
 *
 * @param {import('knex').Knex} knex
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

/** Stable trigger names — must match up/down and integration tests. */
export const MESSAGES_FORBID_UPDATE_TRIGGER = 'trg_messages_forbid_update';
export const MESSAGES_FORBID_DELETE_TRIGGER = 'trg_messages_forbid_delete';

/**
 * @param {import('knex').Knex.CreateTableBuilder} table
 */
function utcMs(table) {
  table.specificType('created_at', 'DATETIME(3)').notNullable();
  table.specificType('updated_at', 'DATETIME(3)').notNullable();
}

/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
  await knex.raw('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');

  await tracker.createTable('organizations', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('org_id', 'CHAR(26)').primary();
    t.string('name', 255).notNullable();
    t.string('status', 32).notNullable();
    utcMs(t);
  });

  await tracker.createTable('users', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('user_id', 'CHAR(26)').primary();
    t.string('external_subject', 255).notNullable();
    t.string('display_name', 255).nullable();
    t.string('email', 320).nullable();
    t.string('status', 32).notNullable();
    utcMs(t);
    t.unique(['external_subject'], { indexName: 'uk_users_external_subject' });
  });

  await tracker.createTable('organization_memberships', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('user_id', 'CHAR(26)').notNullable();
    t.string('role', 64).notNullable();
    t.string('status', 32).notNullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.primary(['org_id', 'user_id']);
    t.foreign('org_id').references('organizations.org_id');
    t.foreign('user_id').references('users.user_id');
  });

  await tracker.createTable('agent_definitions', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('agent_id', 'CHAR(26)').primary();
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.string('name', 255).notNullable();
    t.text('description').nullable();
    t.string('status', 32).notNullable();
    t.specificType('active_version_id', 'CHAR(26)').nullable();
    t.specificType('created_by', 'CHAR(26)').notNullable();
    utcMs(t);
    t.index(['org_id', 'status'], 'idx_agents_org');
    t.foreign('org_id').references('organizations.org_id');
  });

  await tracker.createTable('agent_versions', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('agent_version_id', 'CHAR(26)').primary();
    t.specificType('agent_id', 'CHAR(26)').notNullable();
    t.integer('version_no').notNullable();
    t.json('config_json').notNullable();
    t.specificType('config_hash', 'CHAR(64)').notNullable();
    t.string('pi_sdk_version', 64).notNullable();
    t.string('status', 32).notNullable();
    t.specificType('created_by', 'CHAR(26)').notNullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.unique(['agent_id', 'version_no'], { indexName: 'uk_agent_version' });
    t.foreign('agent_id').references('agent_definitions.agent_id');
  });

  await tracker.createTable('conversations', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('conversation_id', 'CHAR(26)').primary();
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('user_id', 'CHAR(26)').notNullable();
    t.specificType('agent_id', 'CHAR(26)').notNullable();
    t.string('title', 500).nullable();
    t.string('status', 32).notNullable();
    t.specificType('current_agent_session_id', 'CHAR(26)').nullable();
    utcMs(t);
    t.specificType('archived_at', 'DATETIME(3)').nullable();
    t.index(['org_id', 'user_id', 'updated_at'], 'idx_conversations_owner');
    t.foreign('org_id').references('organizations.org_id');
    t.foreign('user_id').references('users.user_id');
    t.foreign('agent_id').references('agent_definitions.agent_id');
  });

  await tracker.createTable('agent_sessions', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('agent_session_id', 'CHAR(26)').primary();
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('user_id', 'CHAR(26)').notNullable();
    t.specificType('conversation_id', 'CHAR(26)').notNullable();
    t.specificType('agent_version_id', 'CHAR(26)').notNullable();
    t.specificType('sandbox_session_id', 'CHAR(26)').notNullable();
    t.specificType('workspace_id', 'CHAR(26)').notNullable();
    t.string('status', 32).notNullable();
    t.bigInteger('pi_session_version').notNullable().defaultTo(0);
    t.specificType('last_run_id', 'CHAR(26)').nullable();
    utcMs(t);
    t.specificType('closed_at', 'DATETIME(3)').nullable();
    t.index(['org_id', 'user_id', 'conversation_id'], 'idx_agent_sessions_owner');
    // Logical ref to sandbox_sessions (no FK — avoids agent↔sandbox creation cycle).
    // 1:1 ownership: one AgentSession owns exactly one sandbox_session_id and workspace_id.
    t.unique(['sandbox_session_id'], {
      indexName: 'uk_agent_sessions_sandbox_session_id',
    });
    t.unique(['workspace_id'], {
      indexName: 'uk_agent_sessions_workspace_id',
    });
    t.foreign('org_id').references('organizations.org_id');
    t.foreign('user_id').references('users.user_id');
    t.foreign('conversation_id').references('conversations.conversation_id');
    t.foreign('agent_version_id').references('agent_versions.agent_version_id');
  });

  await tracker.createTable('agent_session_snapshots', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('snapshot_id', 'CHAR(26)').primary();
    t.specificType('agent_session_id', 'CHAR(26)').notNullable();
    t.bigInteger('snapshot_version').notNullable();
    t.string('snapshot_format', 32).notNullable();
    t.json('snapshot_json').nullable();
    t.string('workspace_path', 1024).nullable();
    t.specificType('checksum', 'CHAR(64)').notNullable();
    t.string('pi_sdk_version', 64).notNullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.unique(['agent_session_id', 'snapshot_version'], {
      indexName: 'uk_session_snapshot',
    });
    t.foreign('agent_session_id').references('agent_sessions.agent_session_id');
  });

  await tracker.createTable('messages', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('message_id', 'CHAR(26)').primary();
    t.specificType('conversation_id', 'CHAR(26)').notNullable();
    t.specificType('agent_session_id', 'CHAR(26)').nullable();
    t.specificType('run_id', 'CHAR(26)').nullable();
    t.string('role', 32).notNullable();
    t.string('message_type', 64).notNullable();
    t.json('content_json').notNullable();
    t.bigInteger('sequence_no').notNullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.unique(['conversation_id', 'sequence_no'], {
      indexName: 'uk_message_sequence',
    });
    t.index(['agent_session_id', 'sequence_no'], 'idx_messages_session');
    t.foreign('conversation_id').references('conversations.conversation_id');
  });

  await tracker.createTable('runs', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('run_id', 'CHAR(26)').primary();
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('user_id', 'CHAR(26)').notNullable();
    t.specificType('conversation_id', 'CHAR(26)').notNullable();
    t.specificType('agent_session_id', 'CHAR(26)').notNullable();
    t.specificType('agent_version_id', 'CHAR(26)').notNullable();
    t.specificType('triggering_message_id', 'CHAR(26)').notNullable();
    t.string('source', 32).notNullable();
    t.string('status', 32).notNullable();
    t.string('status_reason', 255).nullable();
    t.string('queue_name', 128).notNullable();
    t.integer('attempt').notNullable().defaultTo(0);
    t.specificType('trace_id', 'CHAR(32)').notNullable();
    // Allocates run_events.sequence_no via LAST_INSERT_ID(next_event_sequence + 1).
    t.bigInteger('next_event_sequence').notNullable().defaultTo(0);
    t.specificType('started_at', 'DATETIME(3)').nullable();
    t.specificType('completed_at', 'DATETIME(3)').nullable();
    utcMs(t);
    t.index(['agent_session_id', 'created_at'], 'idx_runs_session');
    t.index(['trace_id'], 'idx_runs_trace');
    t.index(['status', 'created_at'], 'idx_runs_status');
    t.index(['org_id', 'user_id', 'created_at'], 'idx_runs_owner');
    t.foreign('org_id').references('organizations.org_id');
    t.foreign('user_id').references('users.user_id');
    t.foreign('conversation_id').references('conversations.conversation_id');
    t.foreign('agent_session_id').references('agent_sessions.agent_session_id');
    t.foreign('agent_version_id').references('agent_versions.agent_version_id');
  });

  await tracker.createTable('run_events', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('event_id', 'CHAR(26)').primary();
    t.specificType('run_id', 'CHAR(26)').notNullable();
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.bigInteger('sequence_no').notNullable();
    t.string('event_type', 128).notNullable();
    t.integer('event_version').notNullable();
    t.json('payload_json').notNullable();
    t.specificType('trace_id', 'CHAR(32)').notNullable();
    t.specificType('span_id', 'CHAR(16)').nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.unique(['run_id', 'sequence_no'], { indexName: 'uk_run_event_sequence' });
    t.index(['run_id', 'created_at'], 'idx_run_events_created');
    t.foreign('run_id').references('runs.run_id');
    t.foreign('org_id').references('organizations.org_id');
  });

  await tracker.createTable('tool_executions', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('tool_execution_id', 'CHAR(26)').primary();
    t.specificType('run_id', 'CHAR(26)').notNullable();
    t.specificType('agent_session_id', 'CHAR(26)').notNullable();
    t.string('tool_call_id', 255).notNullable();
    t.string('tool_name', 255).notNullable();
    t.string('tool_source', 32).notNullable();
    t.string('risk_level', 32).notNullable();
    t.json('arguments_json').notNullable();
    t.json('result_json').nullable();
    t.string('status', 32).notNullable();
    t.string('error_code', 128).nullable();
    t.specificType('trace_id', 'CHAR(32)').notNullable();
    t.specificType('started_at', 'DATETIME(3)').nullable();
    t.specificType('completed_at', 'DATETIME(3)').nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.unique(['run_id', 'tool_call_id'], { indexName: 'uk_tool_call' });
    t.foreign('run_id').references('runs.run_id');
    t.foreign('agent_session_id').references('agent_sessions.agent_session_id');
  });

  // Sandbox Session lifecycle (plan §4.8). Created before process_executions so
  // child rows can FK sandbox_session_id. No FK to agent_sessions (see file header).
  await tracker.createTable('sandbox_sessions', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('sandbox_session_id', 'CHAR(26)').primary();
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('user_id', 'CHAR(26)').notNullable();
    // Logical ref to agent_sessions (no FK — avoids agent↔sandbox creation cycle).
    t.specificType('agent_session_id', 'CHAR(26)').notNullable();
    t.specificType('workspace_id', 'CHAR(26)').notNullable();
    t.string('status', 32).notNullable();
    utcMs(t);
    t.specificType('closed_at', 'DATETIME(3)').nullable();
    t.index(['org_id', 'user_id', 'updated_at'], 'idx_sandbox_sessions_owner');
    t.index(['status', 'updated_at'], 'idx_sandbox_sessions_status');
    // 1:1 ownership: one SandboxSession binds exactly one AgentSession and workspace.
    t.unique(['agent_session_id'], {
      indexName: 'uk_sandbox_sessions_agent_session_id',
    });
    t.unique(['workspace_id'], {
      indexName: 'uk_sandbox_sessions_workspace_id',
    });
    t.foreign('org_id').references('organizations.org_id');
    t.foreign('user_id').references('users.user_id');
  });

  await tracker.createTable('process_executions', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('process_id', 'CHAR(26)').primary();
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('user_id', 'CHAR(26)').notNullable();
    t.specificType('sandbox_session_id', 'CHAR(26)').notNullable();
    t.specificType('run_id', 'CHAR(26)').notNullable();
    t.specificType('execution_id', 'CHAR(26)').notNullable();
    t.json('command_json').notNullable();
    t.string('status', 32).notNullable();
    t.integer('pid').nullable();
    t.integer('exit_code').nullable();
    t.string('stdout_path', 1024).nullable();
    t.string('stderr_path', 1024).nullable();
    t.specificType('started_at', 'DATETIME(3)').nullable();
    t.specificType('ended_at', 'DATETIME(3)').nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.index(['org_id', 'user_id', 'created_at'], 'idx_process_executions_owner');
    t.index(['sandbox_session_id', 'created_at'], 'idx_process_executions_session');
    t.index(['run_id'], 'idx_process_executions_run');
    t.index(['execution_id'], 'idx_process_executions_execution');
    t.foreign('org_id').references('organizations.org_id');
    t.foreign('user_id').references('users.user_id');
    t.foreign('sandbox_session_id').references(
      'sandbox_sessions.sandbox_session_id',
    );
    t.foreign('run_id').references('runs.run_id');
  });

  // Concrete Sandbox tool executions (plan §4.9). Distinct from tool_executions.
  await tracker.createTable('sandbox_executions', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('execution_id', 'CHAR(26)').primary();
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('user_id', 'CHAR(26)').notNullable();
    t.specificType('sandbox_session_id', 'CHAR(26)').notNullable();
    t.specificType('run_id', 'CHAR(26)').notNullable();
    // Logical ref (indexed); not FK to agent_sessions.
    t.specificType('agent_session_id', 'CHAR(26)').notNullable();
    t.string('kind', 64).notNullable();
    t.string('status', 32).notNullable();
    t.integer('exit_code').nullable();
    t.string('error_code', 128).nullable();
    t.specificType('trace_id', 'CHAR(32)').nullable();
    t.json('result_json').nullable();
    t.specificType('started_at', 'DATETIME(3)').nullable();
    t.specificType('completed_at', 'DATETIME(3)').nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.index(['org_id', 'user_id', 'created_at'], 'idx_sandbox_executions_owner');
    t.index(
      ['sandbox_session_id', 'created_at'],
      'idx_sandbox_executions_session',
    );
    t.index(['run_id', 'created_at'], 'idx_sandbox_executions_run');
    t.index(['agent_session_id'], 'idx_sandbox_executions_agent_session');
    t.index(['status', 'created_at'], 'idx_sandbox_executions_status');
    t.foreign('org_id').references('organizations.org_id');
    t.foreign('user_id').references('users.user_id');
    t.foreign('sandbox_session_id').references(
      'sandbox_sessions.sandbox_session_id',
    );
    t.foreign('run_id').references('runs.run_id');
  });

  // Sandbox-side audit trail (not domain_outbox).
  await tracker.createTable('sandbox_audit_events', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('audit_id', 'CHAR(26)').primary();
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('user_id', 'CHAR(26)').notNullable();
    t.string('event_type', 128).notNullable();
    t.specificType('sandbox_session_id', 'CHAR(26)').nullable();
    t.specificType('execution_id', 'CHAR(26)').nullable();
    t.specificType('process_id', 'CHAR(26)').nullable();
    t.specificType('trace_id', 'CHAR(32)').nullable();
    t.json('payload_json').nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.index(['org_id', 'user_id', 'created_at'], 'idx_sandbox_audit_owner');
    t.index(
      ['sandbox_session_id', 'created_at'],
      'idx_sandbox_audit_session',
    );
    t.index(['trace_id', 'created_at'], 'idx_sandbox_audit_trace');
    t.index(['execution_id'], 'idx_sandbox_audit_execution');
    t.index(['process_id'], 'idx_sandbox_audit_process');
    t.foreign('org_id').references('organizations.org_id');
    t.foreign('user_id').references('users.user_id');
  });

  await tracker.createTable('datasets', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('dataset_id', 'CHAR(26)').primary();
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('user_id', 'CHAR(26)').notNullable();
    t.specificType('conversation_id', 'CHAR(26)').notNullable();
    t.specificType('agent_session_id', 'CHAR(26)').notNullable();
    t.string('original_filename', 1024).notNullable();
    t.string('stored_relative_path', 1024).notNullable();
    t.string('mime_type', 255).nullable();
    t.bigInteger('size_bytes').nullable();
    t.specificType('sha256', 'CHAR(64)').nullable();
    t.string('status', 32).notNullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.specificType('completed_at', 'DATETIME(3)').nullable();
    t.index(['org_id', 'user_id'], 'idx_datasets_owner');
    t.foreign('org_id').references('organizations.org_id');
    t.foreign('user_id').references('users.user_id');
    t.foreign('conversation_id').references('conversations.conversation_id');
    t.foreign('agent_session_id').references('agent_sessions.agent_session_id');
  });

  await tracker.createTable('artifacts', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('artifact_id', 'CHAR(26)').primary();
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('user_id', 'CHAR(26)').notNullable();
    t.specificType('conversation_id', 'CHAR(26)').notNullable();
    t.specificType('agent_session_id', 'CHAR(26)').notNullable();
    t.specificType('run_id', 'CHAR(26)').notNullable();
    // Full workspace-relative path (plan §8.15). NOT indexed raw: utf8mb4
    // VARCHAR(1024) alone is 4096 bytes and exceeds InnoDB 3072-byte key limit
    // when combined with run_id + sha256.
    t.string('relative_path', 1024).notNullable();
    // Full-path identity for UNIQUE: SHA-256 hex of entire relative_path
    // (not a path prefix). Preserves plan §8.15 idempotent semantics for
    // distinct full paths; prefix unique indexes are forbidden here.
    // ascii_bin keeps the key short and comparison binary-stable.
    t.specificType(
      'relative_path_hash',
      "CHAR(64) CHARACTER SET ascii COLLATE ascii_bin GENERATED ALWAYS AS (LOWER(SHA2(`relative_path`, 256))) STORED NOT NULL",
    );
    t.string('display_name', 1024).notNullable();
    t.string('mime_type', 255).nullable();
    t.bigInteger('size_bytes').notNullable();
    // Content digest; ascii_bin so uk_artifact_file stays well under 3072 bytes.
    t.specificType(
      'sha256',
      'CHAR(64) CHARACTER SET ascii COLLATE ascii_bin',
    ).notNullable();
    t.string('status', 32).notNullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    // Plan §8.15 UNIQUE(run_id, relative_path, sha256) via full-path hash:
    // run_id CHAR(26) utf8mb4 ≤104 + path_hash 64 + sha256 64 ≪ 3072.
    t.unique(['run_id', 'relative_path_hash', 'sha256'], {
      indexName: 'uk_artifact_file',
    });
    t.index(['org_id', 'user_id'], 'idx_artifacts_owner');
    t.foreign('org_id').references('organizations.org_id');
    t.foreign('user_id').references('users.user_id');
    t.foreign('run_id').references('runs.run_id');
  });

  await tracker.createTable('approvals', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('approval_id', 'CHAR(26)').primary();
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('run_id', 'CHAR(26)').notNullable();
    t.specificType('tool_execution_id', 'CHAR(26)').notNullable();
    t.specificType('requested_by', 'CHAR(26)').notNullable();
    t.specificType('decision_by', 'CHAR(26)').nullable();
    t.string('status', 32).notNullable();
    t.json('request_json').notNullable();
    t.text('decision_reason').nullable();
    t.specificType('expires_at', 'DATETIME(3)').nullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.specificType('decided_at', 'DATETIME(3)').nullable();
    t.index(['org_id', 'status'], 'idx_approvals_org_status');
    t.foreign('org_id').references('organizations.org_id');
    t.foreign('run_id').references('runs.run_id');
  });

  // Table present for PR-02 schema completeness; publisher is PR-03.
  // published_at appears exactly once — do not add a second published_at builder.
  await tracker.createTable('domain_outbox', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('outbox_id', 'CHAR(26)').primary();
    t.string('aggregate_type', 64).notNullable();
    t.specificType('aggregate_id', 'CHAR(26)').notNullable();
    t.string('event_type', 128).notNullable();
    t.json('payload_json').notNullable();
    t.string('status', 32).notNullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.specificType('published_at', 'DATETIME(3)').nullable();
    t.index(['status', 'created_at'], 'idx_outbox_pending');
  });

  await tracker.createTable('idempotency_records', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('user_id', 'CHAR(26)').notNullable();
    t.string('idempotency_key', 255).notNullable();
    t.string('operation', 128).notNullable();
    t.specificType('request_hash', 'CHAR(64)').notNullable();
    t.integer('response_status').nullable();
    t.json('response_json').nullable();
    t.specificType('resource_id', 'CHAR(26)').nullable();
    t.specificType('expires_at', 'DATETIME(3)').notNullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    // String constraint name only — object options become illegal "as indexName" SQL.
    t.primary(
      ['org_id', 'user_id', 'idempotency_key', 'operation'],
      'pk_idempotency_records',
    );
  });

  // Append-only enforcement at the storage layer (plan §8.7 / PR-02 acceptance).
  await tracker.createTrigger(
    MESSAGES_FORBID_UPDATE_TRIGGER,
    `
    CREATE TRIGGER ${MESSAGES_FORBID_UPDATE_TRIGGER}
    BEFORE UPDATE ON messages
    FOR EACH ROW
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'messages is append-only: UPDATE is forbidden'
  `,
  );
  await tracker.createTrigger(
    MESSAGES_FORBID_DELETE_TRIGGER,
    `
    CREATE TRIGGER ${MESSAGES_FORBID_DELETE_TRIGGER}
    BEFORE DELETE ON messages
    FOR EACH ROW
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'messages is append-only: DELETE is forbidden'
  `,
  );
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  // Triggers must be dropped before the table.
  await knex.raw(
    `DROP TRIGGER IF EXISTS ${MESSAGES_FORBID_UPDATE_TRIGGER}`,
  );
  await knex.raw(
    `DROP TRIGGER IF EXISTS ${MESSAGES_FORBID_DELETE_TRIGGER}`,
  );

  const tables = [
    'idempotency_records',
    'domain_outbox',
    'approvals',
    'artifacts',
    'datasets',
    'sandbox_audit_events',
    'sandbox_executions',
    'process_executions',
    'sandbox_sessions',
    'tool_executions',
    'run_events',
    'runs',
    'messages',
    'agent_session_snapshots',
    'agent_sessions',
    'conversations',
    'agent_versions',
    'agent_definitions',
    'organization_memberships',
    'users',
    'organizations',
  ];
  for (const table of tables) {
    await knex.schema.dropTableIfExists(table);
  }
}
