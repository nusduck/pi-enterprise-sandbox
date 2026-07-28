/**
 * Durable Cron jobs and their execution history.
 *
 * Cron definitions are tenant-owned facts in MySQL. Redis/BullMQ remains the
 * delivery mechanism for the resulting Agent Run, never the schedule source
 * of truth. `cron_job_runs` gives each scheduled instant a unique durable
 * claim, which is the duplicate-execution guard across worker replicas.
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

/** @param {import('knex').Knex.CreateTableBuilder} table */
function utcMs(table) {
  table.specificType('created_at', 'DATETIME(3)').notNullable();
  table.specificType('updated_at', 'DATETIME(3)').notNullable();
}

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    await knex.raw('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');

    await tracker.createTable('cron_jobs', (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');
      t.specificType('cron_job_id', 'CHAR(26)').primary();
      t.specificType('org_id', 'CHAR(26)').notNullable();
      t.specificType('user_id', 'CHAR(26)').notNullable();
      // Null means "the tenant default agent" at execution time.
      t.specificType('agent_id', 'CHAR(26)').nullable();
      t.string('name', 255).notNullable();
      t.text('prompt').notNullable();
      t.string('schedule_type', 16).notNullable(); // cron | once
      t.string('cron_expression', 128).nullable();
      t.specificType('run_at', 'DATETIME(3)').nullable();
      t.string('timezone', 64).notNullable();
      t.boolean('enabled').notNullable().defaultTo(true);
      t.specificType('next_run_at', 'DATETIME(3)').nullable();
      t.specificType('last_run_at', 'DATETIME(3)').nullable();
      t.string('misfire_policy', 16).notNullable(); // skip | fire_once
      t.string('concurrency_policy', 16).notNullable(); // forbid | allow
      // Scheduler replays this trusted BFF identity through CreateRunService.
      t.string('auth_provider', 64).notNullable();
      t.string('external_org_id', 255).notNullable();
      t.string('external_user_id', 255).notNullable();
      t.specificType('deleted_at', 'DATETIME(3)').nullable();
      utcMs(t);
      t.index(['org_id', 'user_id', 'created_at'], 'idx_cron_jobs_owner');
      t.index(['enabled', 'next_run_at'], 'idx_cron_jobs_due');
      t.foreign('org_id').references('organizations.org_id');
      t.foreign('user_id').references('users.user_id');
      t.foreign('agent_id').references('agent_definitions.agent_id');
    });

    await tracker.createTable('cron_job_runs', (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');
      t.specificType('cron_job_run_id', 'CHAR(26)').primary();
      t.specificType('cron_job_id', 'CHAR(26)').notNullable();
      t.specificType('scheduled_at', 'DATETIME(3)').notNullable();
      t.specificType('claimed_at', 'DATETIME(3)').notNullable();
      t.specificType('run_id', 'CHAR(26)').nullable();
      // CLAIMED | QUEUED | SUCCEEDED | FAILED | CANCELLED | SKIPPED
      t.string('status', 32).notNullable();
      t.string('idempotency_key', 255).notNullable();
      t.string('error_message', 1000).nullable();
      utcMs(t);
      t.unique(['cron_job_id', 'scheduled_at'], {
        indexName: 'uk_cron_job_runs_scheduled',
      });
      t.unique(['idempotency_key'], {
        indexName: 'uk_cron_job_runs_idempotency',
      });
      t.index(['cron_job_id', 'created_at'], 'idx_cron_job_runs_history');
      t.index(['status', 'claimed_at'], 'idx_cron_job_runs_claimed');
      t.foreign('cron_job_id').references('cron_jobs.cron_job_id');
      t.foreign('run_id').references('runs.run_id');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists('cron_job_runs');
  await knex.schema.dropTableIfExists('cron_jobs');
}
