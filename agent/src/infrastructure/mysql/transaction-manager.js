/**
 * Transaction boundary for Agent MySQL repositories.
 */

import { MysqlDependencyError } from './errors.js';

/**
 * @typedef {import('knex').Knex | import('knex').Knex.Transaction} DbExecutor
 */

/**
 * InnoDB contention. The transaction is already rolled back when these
 * surface, so re-running the work function is the documented remedy rather
 * than a gamble: nothing it wrote survived.
 */
const RETRYABLE_MYSQL_CODES = new Set([
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
]);
const RETRYABLE_MYSQL_ERRNOS = new Set([1213, 1205]);

/**
 * The connection died under the transaction. Also rolled back, but retrying
 * inside one request is pointless — the pool needs to reconnect first.
 */
const CONNECTION_ERROR_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'ER_CON_COUNT_ERROR',
  'ER_QUERY_INTERRUPTED',
]);

/** Backoff before each retry, in milliseconds. Length = retry budget. */
const RETRY_BACKOFF_MS = Object.freeze([25, 100]);

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryableMysqlError(error) {
  const code = /** @type {{ code?: string, errno?: number }} */ (error)?.code;
  const errno = /** @type {{ errno?: number }} */ (error)?.errno;
  return (
    (typeof code === 'string' && RETRYABLE_MYSQL_CODES.has(code)) ||
    (typeof errno === 'number' && RETRYABLE_MYSQL_ERRNOS.has(errno))
  );
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isConnectionMysqlError(error) {
  const code = /** @type {{ code?: string }} */ (error)?.code;
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TransactionManager {
  /**
   * @param {import('knex').Knex} knex
   * @param {{ retryBackoffMs?: readonly number[], sleep?: (ms: number) => Promise<void> }} [opts]
   */
  constructor(knex, opts = {}) {
    if (!knex || typeof knex.transaction !== 'function') {
      throw new Error('TransactionManager requires a knex instance with transaction()');
    }
    this.knex = knex;
    this.retryBackoffMs = Array.isArray(opts.retryBackoffMs)
      ? [...opts.retryBackoffMs]
      : [...RETRY_BACKOFF_MS];
    this.sleep = opts.sleep ?? sleep;
  }

  /**
   * Run work inside a single MySQL transaction.
   * The callback receives the transaction-bound executor (use for all repos).
   *
   * Lock contention is retried, then reported as a dependency failure rather
   * than an unlabelled crash. Both matter for writes a user triggers against a
   * Run the Worker is actively touching — cancelling a RUNNING Run is exactly
   * that shape. Without this, a deadlock the transaction already rolled back
   * reaches the browser as a bare 500 and the user's cancel is simply lost.
   *
   * @template T
   * @param {(trx: import('knex').Knex.Transaction) => Promise<T>} work
   * @returns {Promise<T>}
   */
  async run(work) {
    if (typeof work !== 'function') {
      throw new Error('TransactionManager.run requires a work function');
    }
    let attempt = 0;
    for (;;) {
      try {
        return await this.knex.transaction(async (trx) => work(trx));
      } catch (err) {
        if (isRetryableMysqlError(err) && attempt < this.retryBackoffMs.length) {
          await this.sleep(this.retryBackoffMs[attempt]);
          attempt += 1;
          continue;
        }
        if (isRetryableMysqlError(err) || isConnectionMysqlError(err)) {
          throw new MysqlDependencyError(
            `MySQL transaction failed (${/** @type {{ code?: string }} */ (err)?.code ?? 'unknown'}); nothing was committed`,
            { cause: err },
          );
        }
        throw err;
      }
    }
  }

  /**
   * @returns {import('knex').Knex}
   */
  getExecutor() {
    return this.knex;
  }
}
