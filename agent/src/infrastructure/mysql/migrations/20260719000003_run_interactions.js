/**
 * Durable user-input requests (WAITING_INPUT continuation).
 *
 * Interaction rows are the source of truth across Agent restarts.  A request
 * is resolved with a status CAS; the response hash makes duplicate retries
 * idempotent while rejecting a second, different answer.
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

export const RUN_INTERACTIONS_TABLE = 'run_interactions';

const ID_TYPE = 'CHAR(26)';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    await tracker.createTable(RUN_INTERACTIONS_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('interaction_id', ID_TYPE).notNullable();
      t.specificType('org_id', ID_TYPE).notNullable();
      t.specificType('user_id', ID_TYPE).notNullable();
      t.specificType('run_id', ID_TYPE).notNullable();
      t.specificType('agent_session_id', ID_TYPE).notNullable();
      t.specificType('tool_execution_id', ID_TYPE).notNullable();
      // Pi tool-call ids are opaque strings, not ULIDs.
      t.string('tool_call_id', 255).notNullable();
      t.string('interaction_type', 32).notNullable();
      t.json('request_json').notNullable();
      t.string('status', 16).notNullable();
      t.json('response_json').nullable();
      t.specificType(
        'response_hash',
        'CHAR(64) CHARACTER SET ascii COLLATE ascii_bin',
      ).nullable();
      t.specificType('responded_by', ID_TYPE).nullable();
      t.specificType('created_at', 'DATETIME(3)').notNullable();
      t.specificType('resolved_at', 'DATETIME(3)').nullable();

      t.primary(['interaction_id'], 'pk_run_interactions');
      // A retried Pi tool call must adopt the original durable request.
      t.unique(['run_id', 'tool_call_id'], 'uk_run_interactions_tool_call');
      t.index(
        ['org_id', 'user_id', 'run_id', 'status', 'created_at'],
        'idx_run_interactions_owner_run',
      );
      t.index(
        ['run_id', 'status', 'created_at'],
        'idx_run_interactions_waiting',
      );
      t.foreign('org_id').references('organizations.org_id');
      t.foreign('user_id').references('users.user_id');
      t.foreign('run_id').references('runs.run_id');
      t.foreign('agent_session_id').references('agent_sessions.agent_session_id');
      t.foreign('tool_execution_id').references('tool_executions.tool_execution_id');
      t.foreign('responded_by').references('users.user_id');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists(RUN_INTERACTIONS_TABLE);
}
