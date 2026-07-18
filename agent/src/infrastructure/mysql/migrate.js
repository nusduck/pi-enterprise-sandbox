/**
 * Programmatic Knex migration runner (ESM) — up / down for Agent MySQL schema.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMysqlKnex, destroyMysqlKnex, migrationsDirectory } from './client.js';
import { MysqlConfigError } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {import('knex').Knex} knex
 */
function migrationConfig(knex) {
  return {
    directory: migrationsDirectory(),
    tableName: 'knex_migrations',
    extension: 'js',
    loadExtensions: ['.js'],
  };
}

/**
 * Apply all pending migrations.
 *
 * Preflight order (no DDL yet):
 * 1) Orphan/half-migration gate (does not DROP tables).
 * 2) When pending migrations exist: trigger/binlog capability gate
 *    (non-SUPER CREATE TRIGGER vs log_bin_trust_function_creators).
 *
 * Residual schema recovery:
 * docs/runbooks/mysql-partial-migration-recovery.md
 *
 * @param {import('knex').Knex} knex
 * @returns {Promise<[number, string[]]>}
 */
export async function migrateLatest(knex) {
  if (!knex || typeof knex.migrate?.latest !== 'function') {
    throw new Error('migrateLatest requires a knex instance');
  }
  const { assertNoOrphanPartialSchema } = await import('./migrate-orphan-gate.js');
  await assertNoOrphanPartialSchema(knex);

  // Only when work remains — healthy restarts on already-migrated DBs skip
  // CREATE TRIGGER and should not hard-fail solely on remote managed settings.
  let pending = [];
  if (typeof knex.migrate.list === 'function') {
    const listed = await knex.migrate.list(migrationConfig(knex));
    // knex: [completed, pending]
    pending = Array.isArray(listed?.[1]) ? listed[1] : [];
  }
  if (pending.length > 0) {
    const { assertMysqlTriggerMigrationCapability } = await import(
      './migrate-trigger-preflight.js'
    );
    await assertMysqlTriggerMigrationCapability(knex);
  }

  return knex.migrate.latest(migrationConfig(knex));
}

/**
 * Roll back the last batch of migrations.
 * @param {import('knex').Knex} knex
 * @returns {Promise<[number, string[]]>}
 */
export async function migrateRollback(knex) {
  if (!knex || typeof knex.migrate?.rollback !== 'function') {
    throw new Error('migrateRollback requires a knex instance');
  }
  return knex.migrate.rollback(migrationConfig(knex));
}

/**
 * Roll back all migrations (development empty-DB reset).
 * @param {import('knex').Knex} knex
 * @returns {Promise<[number, string[]]>}
 */
export async function migrateRollbackAll(knex) {
  if (!knex || typeof knex.migrate?.rollback !== 'function') {
    throw new Error('migrateRollbackAll requires a knex instance');
  }
  return knex.migrate.rollback(migrationConfig(knex), true);
}

/**
 * Current migration status.
 * @param {import('knex').Knex} knex
 */
export async function migrateStatus(knex) {
  if (!knex || typeof knex.migrate?.list !== 'function') {
    throw new Error('migrateStatus requires a knex instance');
  }
  return knex.migrate.list(migrationConfig(knex));
}

/**
 * Open MySQL from URL, apply pending migrations, then optionally destroy the pool.
 *
 * Semantics:
 * - `destroy` defaults to **true**.
 * - When `destroy === true` (default): destroy the knex pool and return
 *   `{ result }` only (never a live knex — avoids pool leaks).
 * - When `destroy === false`: return `{ knex, result }`; caller owns destroy.
 * - On migrate failure: always destroy the pool, then rethrow.
 *
 * @param {string} connectionUrl
 * @param {{ destroy?: boolean }} [opts]
 * @returns {Promise<{ result: [number, string[]], knex?: import('knex').Knex }>}
 */
export async function migrateLatestFromUrl(connectionUrl, opts = {}) {
  const { runMigrateLatestFromUrl } = await import('./migrate-from-url-core.js');
  return runMigrateLatestFromUrl({
    createKnex: createMysqlKnex,
    destroyKnex: destroyMysqlKnex,
    migrateLatest,
    connectionUrl,
    opts,
  });
}

export { runMigrateLatestFromUrl } from './migrate-from-url-core.js';

/**
 * Resolve connection URL for CLI / integration tests.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveMysqlUrl(env = process.env) {
  const url = env.AGENT_DATABASE_URL || env.TEST_MYSQL_URL || '';
  if (!url) {
    throw new MysqlConfigError(
      'Set AGENT_DATABASE_URL or TEST_MYSQL_URL for migrations (MySQL only).',
    );
  }
  return url;
}

export { migrationsDirectory, __dirname as mysqlInfrastructureDir };
