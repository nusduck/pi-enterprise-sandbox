/**
 * PR-04 T2: durable cancel intent on runs (plan §18.5).
 *
 * Additive, reversible columns so CancelRunService can record intent in MySQL
 * (fact source) independent of Redis CancelSignal success:
 *
 * - cancel_requested_at  — when cancel intent was first recorded (UTC)
 * - cancel_reason        — optional sanitized bounded reason (never secrets)
 * - cancel_requested_by  — internal actor ULID (owner user or admin)
 *
 * Index supports recovery scans of intent-with-pending-signal work.
 * Does not introduce a parallel status vocabulary — status still plan §10 only.
 *
 * @param {import('knex').Knex} knex
 */

export const CANCEL_REASON_MAX_LEN = 255;

/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.raw('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');

  await knex.schema.alterTable('runs', (t) => {
    t.specificType('cancel_requested_at', 'DATETIME(3)').nullable();
    t.string('cancel_reason', CANCEL_REASON_MAX_LEN).nullable();
    // Actor is an internal ULID (users.user_id), never an external UUID string.
    t.specificType('cancel_requested_by', 'CHAR(26)').nullable();
    t.index(['cancel_requested_at'], 'idx_runs_cancel_requested_at');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('runs', (t) => {
    t.dropIndex(['cancel_requested_at'], 'idx_runs_cancel_requested_at');
    t.dropColumn('cancel_requested_by');
    t.dropColumn('cancel_reason');
    t.dropColumn('cancel_requested_at');
  });
}
