/**
 * PR-12: A2A protocol tables — credentials, task↔run mapping, audit.
 *
 * Authority rules:
 * - a2a_tasks maps protocol task id → internal run_id; it does NOT store
 *   authoritative task status (always project from runs).
 * - a2a_api_credentials stores only secret hashes (never plaintext).
 * - a2a_audit_events is append-only caller audit (plan §20.8).
 *
 * Event recovery for SubscribeToTask uses internal run_events projection
 * (plan §20.6 "or internal Run Event"); no separate a2a_task_events table
 * (avoids a second event journal).
 *
 * Partial DDL cleanup: withPartialDdlCleanup drops only this-run tables on failure.
 *
 * @param {import('knex').Knex} knex
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

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

    await tracker.createTable('a2a_api_credentials', (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');
      t.specificType('credential_id', 'CHAR(26)').primary();
      t.specificType('org_id', 'CHAR(26)').notNullable();
      t.specificType('agent_id', 'CHAR(26)').notNullable();
      t.specificType('service_user_id', 'CHAR(26)').notNullable();
      t.string('client_id', 128).notNullable();
      /** Public key id for O(1) lookup (never the secret). */
      t.string('key_id', 64).notNullable();
      /** SHA-256 hex of full bearer token (constant-time verify). */
      t.specificType('secret_hash', 'CHAR(64)').notNullable();
      t.json('scopes_json').notNullable();
      /** active | rotated | revoked */
      t.string('status', 32).notNullable();
      t.specificType('expires_at', 'DATETIME(3)').nullable();
      t.specificType('rotated_from_id', 'CHAR(26)').nullable();
      t.specificType('last_used_at', 'DATETIME(3)').nullable();
      utcMs(t);
      t.unique(['key_id'], { indexName: 'uk_a2a_cred_key_id' });
      t.index(['org_id', 'client_id', 'status'], 'idx_a2a_cred_org_client');
      t.index(['org_id', 'agent_id'], 'idx_a2a_cred_org_agent');
      t.foreign('org_id').references('organizations.org_id');
      t.foreign('agent_id').references('agent_definitions.agent_id');
      t.foreign('service_user_id').references('users.user_id');
    });

    await tracker.createTable('a2a_tasks', (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');
      t.specificType('a2a_task_id', 'CHAR(26)').primary();
      t.specificType('org_id', 'CHAR(26)').notNullable();
      t.specificType('user_id', 'CHAR(26)').notNullable();
      t.string('client_id', 128).notNullable();
      t.specificType('agent_id', 'CHAR(26)').notNullable();
      t.specificType('credential_id', 'CHAR(26)').notNullable();
      t.specificType('run_id', 'CHAR(26)').notNullable();
      t.specificType('conversation_id', 'CHAR(26)').notNullable();
      /** Optional A2A context grouping (opaque to callers). */
      t.specificType('context_id', 'CHAR(26)').nullable();
      t.specificType('trace_id', 'CHAR(32)').notNullable();
      t.specificType('created_at', 'DATETIME(3)').notNullable();
      t.specificType('updated_at', 'DATETIME(3)').notNullable();
      // No status column — project from runs (plan §20.4 / single authority).
      t.unique(['run_id'], { indexName: 'uk_a2a_tasks_run_id' });
      t.index(
        ['org_id', 'client_id', 'created_at'],
        'idx_a2a_tasks_owner_client',
      );
      t.index(['org_id', 'agent_id', 'created_at'], 'idx_a2a_tasks_org_agent');
      t.foreign('org_id').references('organizations.org_id');
      t.foreign('user_id').references('users.user_id');
      t.foreign('agent_id').references('agent_definitions.agent_id');
      t.foreign('credential_id').references('a2a_api_credentials.credential_id');
      t.foreign('run_id').references('runs.run_id');
      t.foreign('conversation_id').references('conversations.conversation_id');
    });

    await tracker.createTable('a2a_audit_events', (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');
      t.specificType('audit_id', 'CHAR(26)').primary();
      t.specificType('org_id', 'CHAR(26)').notNullable();
      t.string('client_id', 128).notNullable();
      t.specificType('credential_id', 'CHAR(26)').nullable();
      t.specificType('agent_id', 'CHAR(26)').nullable();
      t.specificType('a2a_task_id', 'CHAR(26)').nullable();
      t.specificType('run_id', 'CHAR(26)').nullable();
      t.specificType('trace_id', 'CHAR(32)').nullable();
      t.string('event_type', 128).notNullable();
      t.string('method', 128).nullable();
      t.json('payload_json').nullable();
      t.specificType('created_at', 'DATETIME(3)').notNullable();
      t.index(
        ['org_id', 'client_id', 'created_at'],
        'idx_a2a_audit_owner_client',
      );
      t.index(['a2a_task_id', 'created_at'], 'idx_a2a_audit_task');
      t.index(['trace_id'], 'idx_a2a_audit_trace');
      t.foreign('org_id').references('organizations.org_id');
    });
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('a2a_audit_events');
  await knex.schema.dropTableIfExists('a2a_tasks');
  await knex.schema.dropTableIfExists('a2a_api_credentials');
}
