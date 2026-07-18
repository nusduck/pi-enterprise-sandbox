/**
 * Fail-closed preflight: Agent migrations create MySQL triggers without SUPER.
 *
 * When binary logging is enabled and log_bin_trust_function_creators=0,
 * CREATE TRIGGER fails for non-SUPER accounts (MySQL 8.0.x). That used to
 * leave half-migrations after tables were created.
 *
 * This check runs **before** knex applies pending migrations. It never:
 * - grants SUPER
 * - SET GLOBAL on the server
 * - rewrites external/managed MySQL configuration
 *
 * Operators must configure the instance (compose flag or managed-DB panel).
 */

import { MysqlConfigError } from './errors.js';

/** Stable error code for deploy gates and tests. */
export const MYSQL_TRIGGER_BINLOG_BLOCKED = 'MYSQL_TRIGGER_BINLOG_BLOCKED';

export class MysqlTriggerCapabilityError extends MysqlConfigError {
  /**
   * @param {string} message
   * @param {{ logBin?: boolean, trustCreators?: boolean }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'MysqlTriggerCapabilityError';
    this.code = MYSQL_TRIGGER_BINLOG_BLOCKED;
    this.logBin = meta.logBin ?? null;
    this.trustCreators = meta.trustCreators ?? null;
  }
}

/**
 * Normalize mysql2/knex raw SELECT @@var shapes to a single row object.
 * @param {unknown} rawResult
 * @returns {Record<string, unknown> | null}
 */
export function extractFirstRow(rawResult) {
  if (rawResult == null) return null;
  // knex mysql2: [rows, fields]
  if (Array.isArray(rawResult)) {
    const first = rawResult[0];
    if (Array.isArray(first)) {
      return first[0] && typeof first[0] === 'object'
        ? /** @type {Record<string, unknown>} */ (first[0])
        : null;
    }
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      return /** @type {Record<string, unknown>} */ (first);
    }
    return null;
  }
  if (typeof rawResult === 'object') {
    return /** @type {Record<string, unknown>} */ (rawResult);
  }
  return null;
}

/**
 * Coerce MySQL boolean-ish session/global values (0/1, 'ON'/'OFF', true/false).
 * @param {unknown} value
 * @returns {boolean | null} null if unparseable
 */
export function coerceMysqlBool(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const u = value.trim().toUpperCase();
    if (u === 'ON' || u === 'TRUE' || u === 'YES') return true;
    if (u === 'OFF' || u === 'FALSE' || u === 'NO') return false;
  }
  if (typeof value === 'bigint') {
    if (value === 1n) return true;
    if (value === 0n) return false;
  }
  return null;
}

/**
 * Pure decision: can a non-SUPER account create triggers?
 * @param {{ logBin: boolean | null, trustCreators: boolean | null }} vars
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function evaluateTriggerMigrationCapability(vars) {
  if (vars.logBin === null || vars.trustCreators === null) {
    return {
      ok: false,
      reason:
        'Unable to read @@GLOBAL.log_bin / @@GLOBAL.log_bin_trust_function_creators; refuse migrate',
    };
  }
  // No binary log → no SUPER requirement for deterministic triggers.
  if (vars.logBin === false) {
    return { ok: true };
  }
  if (vars.trustCreators === true) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      'MySQL binary logging is enabled (@@GLOBAL.log_bin=1) but ' +
      '@@GLOBAL.log_bin_trust_function_creators=0. Agent migrations create ' +
      'triggers as a non-SUPER application user (CREATE TRIGGER is blocked). ' +
      'Fix BEFORE migrate (do not grant SUPER to the app account): ' +
      '(1) Compose-managed MySQL: set mysqld --log-bin-trust-function-creators=1 ' +
      '(docker-compose.yml / docker-compose.prod.yml). ' +
      '(2) External/managed MySQL: a DBA/platform must set ' +
      'GLOBAL log_bin_trust_function_creators=1 (or equivalent). ' +
      'This process will not SET GLOBAL or rewrite remote MySQL config. ' +
      'See docs/runbooks/mysql-partial-migration-recovery.md#triggers-and-binary-logging',
  };
}

/**
 * Query globals and evaluate (injectable knex.raw for unit tests).
 * @param {import('knex').Knex} knex
 * @returns {Promise<{ logBin: boolean | null, trustCreators: boolean | null, decision: ReturnType<typeof evaluateTriggerMigrationCapability> }>}
 */
export async function inspectMysqlTriggerMigrationCapability(knex) {
  if (!knex || typeof knex.raw !== 'function') {
    throw new Error('inspectMysqlTriggerMigrationCapability requires knex');
  }
  const raw = await knex.raw(`
    SELECT
      @@GLOBAL.log_bin AS log_bin,
      @@GLOBAL.log_bin_trust_function_creators AS trust_creators
  `);
  const row = extractFirstRow(raw) || {};
  // mysql2 may lower-case or preserve aliases
  const logBin = coerceMysqlBool(
    row.log_bin ?? row.LOG_BIN ?? row['@@GLOBAL.log_bin'],
  );
  const trustCreators = coerceMysqlBool(
    row.trust_creators ??
      row.TRUST_CREATORS ??
      row['@@GLOBAL.log_bin_trust_function_creators'],
  );
  const decision = evaluateTriggerMigrationCapability({
    logBin,
    trustCreators,
  });
  return { logBin, trustCreators, decision };
}

/**
 * Fail closed when pending migrations would hit CREATE TRIGGER without capability.
 *
 * @param {import('knex').Knex} knex
 */
export async function assertMysqlTriggerMigrationCapability(knex) {
  const { logBin, trustCreators, decision } =
    await inspectMysqlTriggerMigrationCapability(knex);
  if (decision.ok) return { logBin, trustCreators };

  throw new MysqlTriggerCapabilityError(decision.reason, {
    logBin: logBin === null ? undefined : logBin,
    trustCreators: trustCreators === null ? undefined : trustCreators,
  });
}
