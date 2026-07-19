/** Durable fence for the WAITING_INPUT Worker-to-Pi continuation hand-off. */

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('run_interactions', (t) => {
    t.string('resume_phase', 16).notNullable().defaultTo('NONE');
    t.specificType('resume_claimed_at', 'DATETIME(3)').nullable();
    t.specificType('resume_applied_at', 'DATETIME(3)').nullable();
    t.specificType('cancelled_at', 'DATETIME(3)').nullable();
    t.index(
      ['run_id', 'resume_phase', 'created_at'],
      'idx_run_interactions_resume',
    );
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('run_interactions', (t) => {
    t.dropIndex(
      ['run_id', 'resume_phase', 'created_at'],
      'idx_run_interactions_resume',
    );
    t.dropColumn('cancelled_at');
    t.dropColumn('resume_applied_at');
    t.dropColumn('resume_claimed_at');
    t.dropColumn('resume_phase');
  });
}
