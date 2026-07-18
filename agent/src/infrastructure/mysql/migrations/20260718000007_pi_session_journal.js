/**
 * PR-05 slice B: Pi session journal columns on messages (long-term recovery truth).
 *
 * Additive, reversible — never rewrite prior migrations.
 *
 * - messages.pi_entry_id VARCHAR(128) NULL
 *   Stable Pi SessionEntry / header id for journal rows.
 * - messages.pi_entry_kind VARCHAR(64) NULL
 *   Entry type (message, compaction, branch_summary, custom, …) or "session" header.
 * - UNIQUE (agent_session_id, pi_entry_id)
 *   Idempotent append per session; MySQL allows multiple NULL pi_entry_id rows
 *   (non-journal conversation messages remain unconstrained by this key).
 *
 * Platform messages + run events remain recovery truth; snapshots are acceleration.
 *
 * @param {import('knex').Knex} knex
 */

export const UK_MESSAGES_SESSION_PI_ENTRY = 'uk_messages_session_pi_entry';
export const IDX_MESSAGES_SESSION_PI_KIND = 'idx_messages_session_pi_kind';

/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.raw('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');

  await knex.schema.alterTable('messages', (t) => {
    t.string('pi_entry_id', 128).nullable();
    t.string('pi_entry_kind', 64).nullable();
  });

  // Unique only when both sides are non-NULL (MySQL UNIQUE permits multiple NULLs).
  await knex.schema.alterTable('messages', (t) => {
    t.unique(['agent_session_id', 'pi_entry_id'], {
      indexName: UK_MESSAGES_SESSION_PI_ENTRY,
    });
    t.index(
      ['agent_session_id', 'pi_entry_kind', 'sequence_no'],
      IDX_MESSAGES_SESSION_PI_KIND,
    );
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('messages', (t) => {
    t.dropIndex(
      ['agent_session_id', 'pi_entry_kind', 'sequence_no'],
      IDX_MESSAGES_SESSION_PI_KIND,
    );
    t.dropUnique(['agent_session_id', 'pi_entry_id'], UK_MESSAGES_SESSION_PI_ENTRY);
    t.dropColumn('pi_entry_kind');
    t.dropColumn('pi_entry_id');
  });
}
