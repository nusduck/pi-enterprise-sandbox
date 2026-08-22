/**
 * Sub-agent Conversation lineage.
 *
 * A child Run must have its own Conversation and AgentSession — the parent
 * holds its session's execution fence for its whole life, so a shared session
 * could never start the child (see `subagent-spawn-service.js`). The side
 * effect was that a fan-out added N rows to the owner's conversation list.
 *
 * This column is what lets the list leave them out while `getById` still
 * returns them: a sub-agent transcript stays readable by id, which archiving
 * the conversation at creation would have broken.
 *
 * ALTER-only up: `withPartialDdlCleanup` tracks created tables, not added
 * columns, so the column and its index go in one statement — MySQL applies a
 * single ALTER TABLE atomically, leaving no half-added state.
 */

export const CONVERSATIONS_TABLE = 'conversations';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable(CONVERSATIONS_TABLE, (t) => {
    t.specificType('parent_run_id', 'CHAR(26)').nullable();
    // The owner list filters on this column, so it belongs in that index
    // rather than in one of its own.
    t.index(
      ['org_id', 'user_id', 'parent_run_id', 'updated_at'],
      'idx_conversations_owner_lineage',
    );
    // The parent Run is always an already-committed row (it is the Run whose
    // tool call is spawning this child), so the FK is satisfiable at insert.
    t.foreign('parent_run_id', 'fk_conversations_parent_run').references(
      'runs.run_id',
    );
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable(CONVERSATIONS_TABLE, (t) => {
    t.dropForeign('parent_run_id', 'fk_conversations_parent_run');
    t.dropIndex(
      ['org_id', 'user_id', 'parent_run_id', 'updated_at'],
      'idx_conversations_owner_lineage',
    );
    t.dropColumn('parent_run_id');
  });
}
