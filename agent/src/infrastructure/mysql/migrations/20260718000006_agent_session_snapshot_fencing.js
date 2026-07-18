/**
 * PR-05 slice A fix: snapshot fencing metadata + append-only triggers.
 *
 * Additive, reversible — never rewrite prior migrations.
 *
 * - agent_session_snapshots.captured_fence_token BIGINT NOT NULL
 *   Records the execution_fence_token observed when the snapshot was committed.
 * - BEFORE UPDATE/DELETE triggers forbid mutation of snapshot rows (append-only).
 *
 * @param {import('knex').Knex} knex
 */

export const SNAPSHOTS_FORBID_UPDATE_TRIGGER =
  'trg_agent_session_snapshots_forbid_update';
export const SNAPSHOTS_FORBID_DELETE_TRIGGER =
  'trg_agent_session_snapshots_forbid_delete';

/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.raw('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');

  await knex.schema.alterTable('agent_session_snapshots', (t) => {
    // Default 0 for any pre-existing rows if the table was empty in greenfield.
    t.bigInteger('captured_fence_token').notNullable().defaultTo(0);
  });

  await knex.raw(`
    CREATE TRIGGER ${SNAPSHOTS_FORBID_UPDATE_TRIGGER}
    BEFORE UPDATE ON agent_session_snapshots
    FOR EACH ROW
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'agent_session_snapshots is append-only: UPDATE is forbidden'
  `);
  await knex.raw(`
    CREATE TRIGGER ${SNAPSHOTS_FORBID_DELETE_TRIGGER}
    BEFORE DELETE ON agent_session_snapshots
    FOR EACH ROW
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'agent_session_snapshots is append-only: DELETE is forbidden'
  `);
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.raw(
    `DROP TRIGGER IF EXISTS ${SNAPSHOTS_FORBID_UPDATE_TRIGGER}`,
  );
  await knex.raw(
    `DROP TRIGGER IF EXISTS ${SNAPSHOTS_FORBID_DELETE_TRIGGER}`,
  );
  await knex.schema.alterTable('agent_session_snapshots', (t) => {
    t.dropColumn('captured_fence_token');
  });
}
