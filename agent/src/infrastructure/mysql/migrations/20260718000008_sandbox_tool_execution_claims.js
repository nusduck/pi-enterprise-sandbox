/**
 * PR-07B batch 2A: safe EXPAND for Sandbox↔Agent tool claim linkage.
 *
 * Additive nullable columns only — never rewrite core schema / prior migrations.
 * No backfill, no NOT NULL, no status ENUM/CHECK, no integrity copying.
 * Legacy NULL request fields remain unclaimable / fail-closed later.
 *
 * tool_executions columns stay nullable: MCP/internal sources may not use the
 * Sandbox request-hash contract.
 *
 * @param {import('knex').Knex} knex
 */

export const UK_SANDBOX_EXECUTION_RUN_TOOL_CALL =
  'uk_sandbox_execution_run_tool_call';
export const UK_SANDBOX_EXECUTION_TOOL_EXECUTION =
  'uk_sandbox_execution_tool_execution';
export const FK_SANDBOX_EXECUTION_TOOL_EXECUTION =
  'fk_sandbox_execution_tool_execution';

/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.raw('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');

  await knex.schema.alterTable('tool_executions', (t) => {
    t.specificType('request_hash', 'CHAR(64)').nullable();
    t.specificType('request_hash_version', 'SMALLINT UNSIGNED').nullable();
    t.bigInteger('execution_fence_token').nullable();
  });

  await knex.schema.alterTable('sandbox_executions', (t) => {
    t.specificType('tool_execution_id', 'CHAR(26)').nullable();
    t.string('tool_call_id', 255).nullable();
    t.specificType('request_hash', 'CHAR(64)').nullable();
    t.specificType('request_hash_version', 'SMALLINT UNSIGNED').nullable();
    t.bigInteger('execution_fence_token').nullable();
  });

  await knex.schema.alterTable('sandbox_executions', (t) => {
    t.unique(['run_id', 'tool_call_id'], {
      indexName: UK_SANDBOX_EXECUTION_RUN_TOOL_CALL,
    });
    t.unique(['tool_execution_id'], {
      indexName: UK_SANDBOX_EXECUTION_TOOL_EXECUTION,
    });
    t.foreign('tool_execution_id', FK_SANDBOX_EXECUTION_TOOL_EXECUTION)
      .references('tool_execution_id')
      .inTable('tool_executions');
  });
}

/**
 * Down order: drop FK → drop both uniques → drop sandbox columns → drop agent tool columns.
 *
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('sandbox_executions', (t) => {
    t.dropForeign(
      ['tool_execution_id'],
      FK_SANDBOX_EXECUTION_TOOL_EXECUTION,
    );
    t.dropUnique(
      ['run_id', 'tool_call_id'],
      UK_SANDBOX_EXECUTION_RUN_TOOL_CALL,
    );
    t.dropUnique(
      ['tool_execution_id'],
      UK_SANDBOX_EXECUTION_TOOL_EXECUTION,
    );
  });

  await knex.schema.alterTable('sandbox_executions', (t) => {
    t.dropColumn('execution_fence_token');
    t.dropColumn('request_hash_version');
    t.dropColumn('request_hash');
    t.dropColumn('tool_call_id');
    t.dropColumn('tool_execution_id');
  });

  await knex.schema.alterTable('tool_executions', (t) => {
    t.dropColumn('execution_fence_token');
    t.dropColumn('request_hash_version');
    t.dropColumn('request_hash');
  });
}
