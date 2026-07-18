/**
 * PR-05 slice A: agent_sessions fencing + recovery metadata.
 *
 * Additive, reversible columns only — never rewrite prior migrations.
 *
 * - execution_fence_token  — monotonic BIGINT fencing token; acquire before
 *   side effects so stale workers cannot commit after a newer fence wins.
 * - recovery_reason_code   — optional reason when status is SUSPENDED
 *   (e.g. RECOVERY_REQUIRED). Not a status column; formal status stays plan §11.
 *
 * Does not introduce RECOVERY_REQUIRED as a status value.
 *
 * @param {import('knex').Knex} knex
 */

export const RECOVERY_REASON_CODE_MAX_LEN = 64;

/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.raw('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');

  await knex.schema.alterTable('agent_sessions', (t) => {
    t.bigInteger('execution_fence_token').notNullable().defaultTo(0);
    t.string('recovery_reason_code', RECOVERY_REASON_CODE_MAX_LEN).nullable();
    t.index(
      ['status', 'recovery_reason_code'],
      'idx_agent_sessions_status_recovery',
    );
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('agent_sessions', (t) => {
    t.dropIndex(
      ['status', 'recovery_reason_code'],
      'idx_agent_sessions_status_recovery',
    );
    t.dropColumn('recovery_reason_code');
    t.dropColumn('execution_fence_token');
  });
}
