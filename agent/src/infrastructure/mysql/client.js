/**
 * MySQL-only knex factory. Never falls back to SQLite or in-memory stores.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { MysqlConfigError, MysqlDependencyError } from './errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Classify a rejected URL for error messages without echoing credentials.
 * @param {string} normalized
 * @returns {string}
 */
export function describeRejectedMysqlUrl(normalized) {
  const lower = normalized.toLowerCase();
  const schemeMatch = lower.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeMatch) {
    return `scheme=${schemeMatch[1]}`;
  }
  if (normalized.includes('@')) {
    return 'bare-credential-string';
  }
  return 'bare-string';
}

/**
 * Strict MySQL DSN gate: only `mysql://` or `mysql2://`.
 * Rejects sqlite, postgres, `mysql+…`, and bare `user:pass@host/db` strings.
 * Error messages never include the full URL (avoids credential leakage).
 *
 * @param {string | undefined | null} url
 * @returns {string} trimmed original URL when valid
 */
export function assertMysqlConnectionUrl(url) {
  if (url == null || String(url).trim() === '') {
    throw new MysqlConfigError(
      'MySQL connection URL is required (set AGENT_DATABASE_URL or TEST_MYSQL_URL). ' +
        'Only mysql:// or mysql2:// are accepted; SQLite and in-memory stores are not supported.',
    );
  }
  const normalized = String(url).trim();
  const lower = normalized.toLowerCase();

  if (lower.startsWith('mysql://') || lower.startsWith('mysql2://')) {
    return normalized;
  }

  const kind = describeRejectedMysqlUrl(normalized);
  throw new MysqlConfigError(
    `Unsupported database URL for Agent MySQL (${kind}). ` +
      'Only mysql:// or mysql2:// are accepted; mysql+, PostgreSQL, SQLite, and bare DSNs are rejected.',
  );
}

/**
 * Normalize an Agent MySQL DSN for deterministic DATETIME handling.
 *
 * MySQL DATETIME values have no timezone on the wire.  mysql2 otherwise
 * interprets them in the host's local timezone and returns shifted `Date`
 * objects.  Keep all caller-supplied connection options, but make the two
 * options that control this boundary explicit and non-overridable.
 *
 * @param {string} connectionUrl
 * @returns {string} mysql:// URL with UTC/string date options
 */
export function normalizeMysqlConnectionUrl(connectionUrl) {
  const url = assertMysqlConnectionUrl(connectionUrl);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Do not include the URL: it may contain credentials.
    throw new MysqlConfigError('Invalid MySQL connection URL.');
  }

  // Knex's mysql2 dialect consumes a mysql:// URL.  mysql2:// is accepted at
  // the public boundary for compatibility, then normalized here.
  parsed.protocol = 'mysql:';
  parsed.searchParams.set('timezone', 'Z');
  parsed.searchParams.set('dateStrings', 'true');
  return parsed.toString();
}

/**
 * Load knex at runtime so unit tests that only inject fakes need not install knex.
 * @returns {typeof import('knex')}
 */
export function loadKnexModule() {
  try {
    // knex default export is the knex function
    const mod = require('knex');
    return typeof mod === 'function' ? mod : mod.default;
  } catch (err) {
    throw new MysqlDependencyError(
      'Package "knex" is not installed. Add knex and mysql2 (see agent/package.json), then npm install.',
      { cause: err },
    );
  }
}

/**
 * Ensure mysql2 is resolvable (knex client).
 */
export function assertMysql2Installed() {
  try {
    require.resolve('mysql2');
  } catch (err) {
    throw new MysqlDependencyError(
      'Package "mysql2" is not installed. Add knex and mysql2 (see agent/package.json), then npm install.',
      { cause: err },
    );
  }
}

/**
 * Absolute path to the migrations directory shipped with this package.
 */
export function migrationsDirectory() {
  return path.join(__dirname, 'migrations');
}

/**
 * @param {string} connectionUrl
 * @param {{ pool?: { min?: number, max?: number } }} [options]
 * @returns {import('knex').Knex}
 */
export function createMysqlKnex(connectionUrl, options = {}) {
  const connection = normalizeMysqlConnectionUrl(connectionUrl);
  assertMysql2Installed();
  const knex = loadKnexModule();

  return knex({
    client: 'mysql2',
    connection,
    pool: {
      min: options.pool?.min ?? 0,
      max: options.pool?.max ?? 10,
    },
    migrations: {
      directory: migrationsDirectory(),
      tableName: 'knex_migrations',
      extension: 'js',
      loadExtensions: ['.js'],
    },
  });
}

/**
 * Destroy knex pool (integration tests / CLI).
 * @param {import('knex').Knex | null | undefined} knex
 */
export async function destroyMysqlKnex(knex) {
  if (knex && typeof knex.destroy === 'function') {
    await knex.destroy();
  }
}
