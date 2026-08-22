/**
 * Sub-agent Run lineage.
 *
 * A Run spawned by `spawn_subagent` is an ordinary Run on the same queue: the
 * only new facts are who spawned it, how deep the chain already is, and the
 * label the parent gave it. Depth is stored rather than derived so the spawn
 * check is one row read instead of a recursive walk, and so a depth cap cannot
 * be defeated by a broken parent chain.
 *
 * ALTER-only up: `withPartialDdlCleanup` tracks created tables, not added
 * columns, so this migration adds the three columns in one statement — MySQL
 * applies a single ALTER TABLE atomically, leaving no half-added state.
 */

export const RUNS_TABLE = 'runs';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable(RUNS_TABLE, (t) => {
    t.specificType('parent_run_id', 'CHAR(26)').nullable();
    t.integer('subagent_depth').notNullable().defaultTo(0);
    t.string('subagent_label', 128).nullable();
    // Children of one parent, newest first: the check_subagent read path.
    t.index(['parent_run_id', 'created_at'], 'idx_runs_parent');
    t.foreign('parent_run_id', 'fk_runs_parent_run').references('runs.run_id');
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable(RUNS_TABLE, (t) => {
    t.dropForeign('parent_run_id', 'fk_runs_parent_run');
    t.dropIndex(['parent_run_id', 'created_at'], 'idx_runs_parent');
    t.dropColumn('parent_run_id');
    t.dropColumn('subagent_depth');
    t.dropColumn('subagent_label');
  });
}
