/**
 * Fail-closed gate: residual half-migration schema left by a failed MySQL DDL
 * batch that never recorded knex_migrations.
 *
 * Does **not** DROP anything. Operators must follow the recovery runbook.
 */

import { MysqlOrphanSchemaError } from './errors.js';
import { CORE_TABLES_CREATE_ORDER, A2A_TABLES } from './schema-tables.js';

/** Filename stem recorded by knex for the core platform migration. */
export const CORE_MIGRATION_NAME = '20260718000001_core_platform_schema.js';

/** Later createTable migrations that can also leave orphans. */
export const CREATE_TABLE_MIGRATION_SENTINELS = Object.freeze([
  {
    migrationName: '20260718000003_run_authority_compatibility.js',
    tables: Object.freeze([
      'organization_external_refs',
      'conversation_external_refs',
    ]),
  },
  {
    migrationName: '20260718000009_a2a_protocol.js',
    tables: A2A_TABLES,
  },
]);

/**
 * @param {import('knex').Knex} knex
 * @returns {Promise<Set<string>>}
 */
async function loadRecordedMigrationNames(knex) {
  const has = await knex.schema.hasTable('knex_migrations');
  if (!has) return new Set();
  const rows = await knex('knex_migrations').select('name');
  return new Set(rows.map((r) => String(r.name)));
}

/**
 * @param {import('knex').Knex} knex
 * @param {string} table
 */
async function tableExists(knex, table) {
  return knex.schema.hasTable(table);
}

/**
 * Detect orphan tables that exist without their creating migration recorded.
 * Returns a structured report (no throw).
 *
 * @param {import('knex').Knex} knex
 * @returns {Promise<{
 *   orphanTables: string[],
 *   missingMigrations: string[],
 *   recorded: string[],
 * }>}
 */
export async function inspectOrphanPartialSchema(knex) {
  if (!knex || !knex.schema) {
    throw new Error('inspectOrphanPartialSchema requires a knex instance');
  }

  const recorded = await loadRecordedMigrationNames(knex);
  /** @type {string[]} */
  const orphanTables = [];
  /** @type {string[]} */
  const missingMigrations = [];

  const coreRecorded = recorded.has(CORE_MIGRATION_NAME);
  if (!coreRecorded) {
    for (const table of CORE_TABLES_CREATE_ORDER) {
      // eslint-disable-next-line no-await-in-loop
      if (await tableExists(knex, table)) {
        orphanTables.push(table);
      }
    }
    if (orphanTables.length > 0) {
      missingMigrations.push(CORE_MIGRATION_NAME);
    }
  }

  for (const sentinel of CREATE_TABLE_MIGRATION_SENTINELS) {
    if (recorded.has(sentinel.migrationName)) continue;
    /** @type {string[]} */
    const found = [];
    for (const table of sentinel.tables) {
      // eslint-disable-next-line no-await-in-loop
      if (await tableExists(knex, table)) {
        found.push(table);
      }
    }
    if (found.length > 0) {
      orphanTables.push(...found);
      missingMigrations.push(sentinel.migrationName);
    }
  }

  return {
    orphanTables: [...new Set(orphanTables)],
    missingMigrations: [...new Set(missingMigrations)],
    recorded: [...recorded].sort(),
  };
}

/**
 * Fail closed when residual half-migration schema is present.
 * Safe to call before every migrateLatest (empty DB → no-op).
 *
 * @param {import('knex').Knex} knex
 */
export async function assertNoOrphanPartialSchema(knex) {
  const report = await inspectOrphanPartialSchema(knex);
  if (report.orphanTables.length === 0) return report;

  const tableList = report.orphanTables.slice(0, 12).join(', ');
  const more =
    report.orphanTables.length > 12
      ? ` (+${report.orphanTables.length - 12} more)`
      : '';
  const migList = report.missingMigrations.join(', ');

  throw new MysqlOrphanSchemaError(
    `Orphan MySQL schema detected (fail closed): tables exist without recorded ` +
      `migration(s) [${migList}]. Example tables: ${tableList}${more}. ` +
      `MySQL DDL is non-transactional; a prior failed migration left partial schema ` +
      `and knex will not auto-drop production tables. ` +
      `Recovery: docs/runbooks/mysql-partial-migration-recovery.md`,
    {
      orphanTables: report.orphanTables,
      missingMigrations: report.missingMigrations,
    },
  );
}
