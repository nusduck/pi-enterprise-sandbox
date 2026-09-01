/**
 * Durable exec process ledger.
 *
 * `exec/` owns these facts and is the only runtime writer. Agent owns schema
 * migration for the shared MySQL instance, so the table is created here.
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

export const EXEC_JOBS_TABLE = 'exec_jobs';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    await tracker.createTable(EXEC_JOBS_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.string('process_id', 64).notNullable();
      t.string('kind', 16).notNullable().defaultTo('bash');
      t.string('label', 1024).notNullable();
      t.specificType('org_id', 'CHAR(26)').notNullable();
      t.specificType('user_id', 'CHAR(26)').notNullable();
      t.string('workspace_id', 191).notNullable();
      t.string('run_id', 64).nullable();
      t.string('status', 32).notNullable();
      t.text('detail').nullable();
      t.specificType('output_limit_bytes', 'BIGINT UNSIGNED').nullable();
      t.integer('pid').nullable();
      t.integer('pgid').nullable();
      t.string('start_identity', 512).nullable();
      t.integer('exit_code').nullable();
      t.boolean('reported').notNullable().defaultTo(false);
      t.specificType('started_at', 'DATETIME(3)').nullable();
      t.specificType('finished_at', 'DATETIME(3)').nullable();
      t.specificType('created_at', 'DATETIME(3)').notNullable();

      t.primary(['process_id'], 'pk_exec_jobs');
      t.index(['org_id', 'user_id', 'workspace_id'], 'idx_exec_jobs_owner');
      t.index(['run_id'], 'idx_exec_jobs_run');
      t.index(['status'], 'idx_exec_jobs_status');
      t.index(['created_at'], 'idx_exec_jobs_created');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists(EXEC_JOBS_TABLE);
}
