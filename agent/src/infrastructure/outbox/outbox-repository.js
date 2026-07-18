/**
 * Durable MySQL Outbox repository (plan §8.17, PR-03).
 *
 * Authority: MySQL only. No Redis, no Run status mutations.
 *
 * insert(executor) is intended for the same transaction as durable domain writes.
 * claimBatch uses SELECT … FOR UPDATE SKIP LOCKED for concurrent publishers.
 *
 * Eligibility (aggregate/event/payload filters) is required so a RunEventStream
 * publisher never claims unrelated domain_outbox rows.
 */

import { toMysqlDateTime } from '../mysql/row-mappers.js';
import { generateClaimToken } from './claim-token.js';
import {
  buildEligibilitySql,
  hasEligibilityFilter,
  normalizeClaimEligibility,
} from './eligibility.js';
import { mapDomainOutbox } from './map-outbox-row.js';
import {
  requirePositiveDurationMs,
  requirePositiveInteger,
  resolveBatchLimit,
} from './options.js';
import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_CLAIM_BATCH_SIZE,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_STALE_CLAIM_MS,
  LAST_ERROR_MAX_LEN,
  OUTBOX_STATUS,
} from './outbox-status.js';
import { computeRetryDelayMs } from './retry-delay.js';
import { sanitizeOutboxError } from './sanitize-error.js';

/**
 * @typedef {import('knex').Knex | import('knex').Knex.Transaction} DbExecutor
 */

/**
 * @typedef {import('./eligibility.js').ClaimEligibility} ClaimEligibility
 */

/**
 * Parse rows from knex.raw SELECT result (mysql2 shapes).
 * @param {unknown} rawResult
 * @returns {Record<string, unknown>[]}
 */
export function parseRawSelectRows(rawResult) {
  if (rawResult == null) return [];
  if (Array.isArray(rawResult)) {
    if (rawResult.length > 0 && Array.isArray(rawResult[0])) {
      return /** @type {Record<string, unknown>[]} */ (rawResult[0]);
    }
    if (
      rawResult.length === 0 ||
      (rawResult[0] && typeof rawResult[0] === 'object' && !Array.isArray(rawResult[0]))
    ) {
      return /** @type {Record<string, unknown>[]} */ (rawResult);
    }
  }
  return [];
}

/**
 * Parse affectedRows from knex.raw UPDATE result.
 * @param {unknown} rawResult
 * @returns {number}
 */
export function parseAffectedRows(rawResult) {
  if (rawResult == null) return 0;
  if (Array.isArray(rawResult)) {
    const header = rawResult[0];
    if (header && typeof header === 'object') {
      return Number(
        header.affectedRows ?? header.affected_rows ?? header.rowCount ?? 0,
      );
    }
  }
  if (typeof rawResult === 'object') {
    const header = /** @type {Record<string, unknown>} */ (rawResult);
    return Number(
      header.affectedRows ?? header.affected_rows ?? header.rowCount ?? 0,
    );
  }
  return 0;
}

export class OutboxRepository {
  /**
   * @param {DbExecutor} db
   * @param {{
   *   maxAttempts?: number,
   *   staleClaimMs?: number,
   *   baseDelayMs?: number,
   *   maxDelayMs?: number,
   *   now?: () => Date,
   *   generateClaimToken?: () => string,
   *   defaultEligibility?: ClaimEligibility | null,
   * }} [options]
   */
  constructor(db, options = {}) {
    if (!db) throw new Error('OutboxRepository requires a knex executor');
    this.db = db;

    this.maxAttempts = requirePositiveInteger(
      'maxAttempts',
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      { min: 1, max: 1_000_000 },
    );
    this.staleClaimMs = requirePositiveDurationMs(
      'staleClaimMs',
      options.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS,
      { min: 1, max: 86_400_000 },
    );
    this.baseDelayMs = requirePositiveDurationMs(
      'baseDelayMs',
      options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      { min: 1, max: 86_400_000 },
    );
    this.maxDelayMs = requirePositiveDurationMs(
      'maxDelayMs',
      options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      { min: 1, max: 86_400_000 },
    );
    if (this.maxDelayMs < this.baseDelayMs) {
      throw new Error('maxDelayMs must be >= baseDelayMs');
    }

    this.now = options.now ?? (() => new Date());
    if (typeof this.now !== 'function') {
      throw new Error('now must be a function returning Date');
    }
    this.generateClaimToken =
      options.generateClaimToken ?? generateClaimToken;
    if (typeof this.generateClaimToken !== 'function') {
      throw new Error('generateClaimToken must be a function');
    }

    this.defaultEligibility =
      options.defaultEligibility === undefined
        ? null
        : normalizeClaimEligibility(options.defaultEligibility);
  }

  /**
   * Insert a PENDING outbox row. Pass the domain transaction as `executor`
   * so the row commits atomically with durable domain changes.
   *
   * @param {{
   *   outboxId: string,
   *   aggregateType: string,
   *   aggregateId: string,
   *   eventType: string,
   *   payloadJson?: Record<string, unknown>,
   *   createdAt?: Date | string,
   *   nextAttemptAt?: Date | string | null,
   * }} input
   * @param {DbExecutor} [executor]
   */
  async insert(input, executor = this.db) {
    if (!input?.outboxId) throw new Error('insert requires outboxId');
    if (!input.aggregateType) throw new Error('insert requires aggregateType');
    if (!input.aggregateId) throw new Error('insert requires aggregateId');
    if (!input.eventType) throw new Error('insert requires eventType');

    const createdAt = toMysqlDateTime(input.createdAt || this.now());
    const nextAttemptAt =
      input.nextAttemptAt === undefined || input.nextAttemptAt === null
        ? null
        : toMysqlDateTime(input.nextAttemptAt);

    await executor('domain_outbox').insert({
      outbox_id: input.outboxId,
      aggregate_type: input.aggregateType,
      aggregate_id: input.aggregateId,
      event_type: input.eventType,
      payload_json: JSON.stringify(input.payloadJson ?? {}),
      status: OUTBOX_STATUS.PENDING,
      attempts: 0,
      claim_token: null,
      claimed_at: null,
      next_attempt_at: nextAttemptAt,
      last_error: null,
      created_at: createdAt,
      published_at: null,
    });

    const row = await executor('domain_outbox')
      .where({ outbox_id: input.outboxId })
      .first();
    return mapDomainOutbox(row);
  }

  /**
   * Claim up to `limit` due PENDING rows matching eligibility (then mark PUBLISHING).
   *
   * Transactional: SELECT … FOR UPDATE SKIP LOCKED with parameterized filters.
   * Unrelated aggregates are never locked by this claim.
   *
   * @param {{
   *   limit?: number,
   *   now?: Date,
   *   eligibility?: ClaimEligibility | null,
   * }} [opts]
   * @returns {Promise<ReturnType<typeof mapDomainOutbox>[]>}
   */
  async claimBatch(opts = {}) {
    const limit = resolveBatchLimit(
      opts.limit,
      DEFAULT_CLAIM_BATCH_SIZE,
      500,
      'claimBatch.limit',
    );
    const at = opts.now ?? this.now();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      throw new Error('claimBatch.now must be a valid Date');
    }
    const nowSql = toMysqlDateTime(at);
    const eligibility =
      opts.eligibility !== undefined
        ? normalizeClaimEligibility(opts.eligibility)
        : this.defaultEligibility;

    const work = async (trx) => {
      await this.reclaimStalePublishing({
        now: at,
        executor: trx,
        eligibility,
      });

      const elig = buildEligibilitySql(eligibility);
      const eligibilitySql = elig.sql ? ` AND ${elig.sql}` : '';

      const selectResult = await trx.raw(
        `SELECT outbox_id, aggregate_type, aggregate_id, event_type, payload_json,
                status, attempts, claim_token, claimed_at, next_attempt_at,
                last_error, created_at, published_at
         FROM domain_outbox
         WHERE status = ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ${eligibilitySql}
         ORDER BY created_at ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED`,
        [OUTBOX_STATUS.PENDING, nowSql, ...elig.bindings, limit],
      );

      const locked = parseRawSelectRows(selectResult);
      if (locked.length === 0) return [];

      /** @type {ReturnType<typeof mapDomainOutbox>[]} */
      const claimed = [];
      for (const raw of locked) {
        const claimToken = this.generateClaimToken();
        const outboxId = String(raw.outbox_id);
        const prevAttempts = Number(raw.attempts ?? 0);
        const nextAttempts = prevAttempts + 1;

        const updateResult = await trx.raw(
          `UPDATE domain_outbox
           SET status = ?,
               claim_token = ?,
               claimed_at = ?,
               attempts = ?,
               next_attempt_at = NULL
           WHERE outbox_id = ?
             AND status = ?`,
          [
            OUTBOX_STATUS.PUBLISHING,
            claimToken,
            nowSql,
            nextAttempts,
            outboxId,
            OUTBOX_STATUS.PENDING,
          ],
        );

        if (parseAffectedRows(updateResult) !== 1) {
          continue;
        }

        claimed.push(
          mapDomainOutbox({
            ...raw,
            status: OUTBOX_STATUS.PUBLISHING,
            claim_token: claimToken,
            claimed_at: nowSql,
            attempts: nextAttempts,
            next_attempt_at: null,
          }),
        );
      }
      return claimed;
    };

    if (this.db.isTransaction === true) {
      return work(/** @type {import('knex').Knex.Transaction} */ (this.db));
    }
    if (typeof this.db.transaction !== 'function') {
      throw new Error(
        'OutboxRepository.claimBatch requires knex.transaction() or a transaction executor',
      );
    }
    return this.db.transaction(work);
  }

  /**
   * Return stuck PUBLISHING rows to PENDING so they can be reclaimed.
   * When eligibility is set, only matching rows are reclaimed (other publishers
   * keep their in-flight claims).
   *
   * @param {{
   *   now?: Date,
   *   staleClaimMs?: number,
   *   executor?: DbExecutor,
   *   eligibility?: ClaimEligibility | null,
   * }} [opts]
   * @returns {Promise<number>} rows reclaimed
   */
  async reclaimStalePublishing(opts = {}) {
    const executor = opts.executor ?? this.db;
    const at = opts.now ?? this.now();
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      throw new Error('reclaimStalePublishing.now must be a valid Date');
    }
    const staleMs =
      opts.staleClaimMs !== undefined
        ? requirePositiveDurationMs('staleClaimMs', opts.staleClaimMs, {
            min: 1,
            max: 86_400_000,
          })
        : this.staleClaimMs;
    const cutoff = new Date(at.getTime() - staleMs);
    const cutoffSql = toMysqlDateTime(cutoff);
    const nowSql = toMysqlDateTime(at);

    const eligibility =
      opts.eligibility !== undefined
        ? normalizeClaimEligibility(opts.eligibility)
        : this.defaultEligibility;
    const elig = buildEligibilitySql(eligibility);
    const eligibilitySql = elig.sql ? ` AND ${elig.sql}` : '';

    const result = await executor.raw(
      `UPDATE domain_outbox
       SET status = ?,
           claim_token = NULL,
           claimed_at = NULL,
           next_attempt_at = ?
       WHERE status = ?
         AND claimed_at IS NOT NULL
         AND claimed_at < ?
         ${eligibilitySql}`,
      [
        OUTBOX_STATUS.PENDING,
        nowSql,
        OUTBOX_STATUS.PUBLISHING,
        cutoffSql,
        ...elig.bindings,
      ],
    );
    return parseAffectedRows(result);
  }

  /**
   * Token-guarded mark as PUBLISHED. Returns false on token/status mismatch
   * (row left unchanged). Database errors propagate (never swallowed).
   *
   * @param {string} outboxId
   * @param {string} claimToken
   * @param {{ publishedAt?: Date | string }} [opts]
   * @returns {Promise<boolean>}
   */
  async markPublished(outboxId, claimToken, opts = {}) {
    if (!outboxId || !claimToken) return false;
    const publishedAt = toMysqlDateTime(opts.publishedAt || this.now());
    const result = await this.db.raw(
      `UPDATE domain_outbox
       SET status = ?,
           published_at = ?,
           claim_token = NULL,
           claimed_at = NULL,
           last_error = NULL,
           next_attempt_at = NULL
       WHERE outbox_id = ?
         AND claim_token = ?
         AND status = ?`,
      [
        OUTBOX_STATUS.PUBLISHED,
        publishedAt,
        outboxId,
        claimToken,
        OUTBOX_STATUS.PUBLISHING,
      ],
    );
    return parseAffectedRows(result) === 1;
  }

  /**
   * Token-guarded return to PENDING with exponential/bounded delay and sanitized error.
   * If attempts already reached maxAttempts, delegates to markFailed.
   *
   * @param {string} outboxId
   * @param {string} claimToken
   * @param {unknown} error
   * @param {{ attempts?: number, now?: Date }} [opts]
   * @returns {Promise<'retry' | 'failed' | 'noop'>}
   */
  async markPendingForRetry(outboxId, claimToken, error, opts = {}) {
    if (!outboxId || !claimToken) return 'noop';

    const row = await this.db('domain_outbox')
      .where({ outbox_id: outboxId, claim_token: claimToken })
      .first();
    if (!row || String(row.status) !== OUTBOX_STATUS.PUBLISHING) {
      return 'noop';
    }

    const attempts = opts.attempts ?? Number(row.attempts ?? 0);
    const sanitized = sanitizeOutboxError(error, LAST_ERROR_MAX_LEN);

    if (attempts >= this.maxAttempts) {
      const failed = await this.markFailed(outboxId, claimToken, sanitized);
      return failed ? 'failed' : 'noop';
    }

    const at = opts.now ?? this.now();
    const delayMs = computeRetryDelayMs(attempts, {
      baseDelayMs: this.baseDelayMs,
      maxDelayMs: this.maxDelayMs,
    });
    const nextAttemptAt = toMysqlDateTime(new Date(at.getTime() + delayMs));

    const result = await this.db.raw(
      `UPDATE domain_outbox
       SET status = ?,
           claim_token = NULL,
           claimed_at = NULL,
           next_attempt_at = ?,
           last_error = ?
       WHERE outbox_id = ?
         AND claim_token = ?
         AND status = ?`,
      [
        OUTBOX_STATUS.PENDING,
        nextAttemptAt,
        sanitized,
        outboxId,
        claimToken,
        OUTBOX_STATUS.PUBLISHING,
      ],
    );
    return parseAffectedRows(result) === 1 ? 'retry' : 'noop';
  }

  /**
   * Token-guarded terminal failure (permanent mapping error or max attempts).
   *
   * @param {string} outboxId
   * @param {string} claimToken
   * @param {unknown} error
   * @returns {Promise<boolean>}
   */
  async markFailed(outboxId, claimToken, error) {
    if (!outboxId || !claimToken) return false;
    const sanitized = sanitizeOutboxError(error, LAST_ERROR_MAX_LEN);
    const result = await this.db.raw(
      `UPDATE domain_outbox
       SET status = ?,
           claim_token = NULL,
           claimed_at = NULL,
           last_error = ?,
           next_attempt_at = NULL
       WHERE outbox_id = ?
         AND claim_token = ?
         AND status = ?`,
      [
        OUTBOX_STATUS.FAILED,
        sanitized,
        outboxId,
        claimToken,
        OUTBOX_STATUS.PUBLISHING,
      ],
    );
    return parseAffectedRows(result) === 1;
  }

  /**
   * List PENDING rows due for publish (observability / recovery tools).
   *
   * @param {{ limit?: number, now?: Date, eligibility?: ClaimEligibility | null }} [opts]
   */
  async listPending(opts = {}) {
    const limit = resolveBatchLimit(opts.limit, 100, 1000, 'listPending.limit');
    const nowSql = toMysqlDateTime(opts.now ?? this.now());
    const eligibility =
      opts.eligibility !== undefined
        ? normalizeClaimEligibility(opts.eligibility)
        : this.defaultEligibility;
    const elig = buildEligibilitySql(eligibility);
    const eligibilitySql = elig.sql ? ` AND ${elig.sql}` : '';

    const result = await this.db.raw(
      `SELECT outbox_id, aggregate_type, aggregate_id, event_type, payload_json,
              status, attempts, claim_token, claimed_at, next_attempt_at,
              last_error, created_at, published_at
       FROM domain_outbox
       WHERE status = ?
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ${eligibilitySql}
       ORDER BY created_at ASC
       LIMIT ?`,
      [OUTBOX_STATUS.PENDING, nowSql, ...elig.bindings, limit],
    );
    return parseRawSelectRows(result).map(mapDomainOutbox);
  }

  /**
   * List rows useful for crash recovery inspection: PENDING due + stale PUBLISHING.
   *
   * @param {{
   *   limit?: number,
   *   now?: Date,
   *   staleClaimMs?: number,
   *   eligibility?: ClaimEligibility | null,
   * }} [opts]
   */
  async listForRecovery(opts = {}) {
    const limit = resolveBatchLimit(
      opts.limit,
      100,
      1000,
      'listForRecovery.limit',
    );
    const at = opts.now ?? this.now();
    const nowSql = toMysqlDateTime(at);
    const staleMs =
      opts.staleClaimMs !== undefined
        ? requirePositiveDurationMs('staleClaimMs', opts.staleClaimMs, {
            min: 1,
            max: 86_400_000,
          })
        : this.staleClaimMs;
    const cutoffSql = toMysqlDateTime(new Date(at.getTime() - staleMs));
    const eligibility =
      opts.eligibility !== undefined
        ? normalizeClaimEligibility(opts.eligibility)
        : this.defaultEligibility;
    const elig = buildEligibilitySql(eligibility);
    const eligibilitySql = elig.sql ? ` AND ${elig.sql}` : '';

    const result = await this.db.raw(
      `SELECT outbox_id, aggregate_type, aggregate_id, event_type, payload_json,
              status, attempts, claim_token, claimed_at, next_attempt_at,
              last_error, created_at, published_at
       FROM domain_outbox
       WHERE (
         (
           status = ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ) OR (
           status = ?
           AND claimed_at IS NOT NULL
           AND claimed_at < ?
         )
       )
       ${eligibilitySql}
       ORDER BY created_at ASC
       LIMIT ?`,
      [
        OUTBOX_STATUS.PENDING,
        nowSql,
        OUTBOX_STATUS.PUBLISHING,
        cutoffSql,
        ...elig.bindings,
        limit,
      ],
    );
    return parseRawSelectRows(result).map(mapDomainOutbox);
  }

  /**
   * @param {string} outboxId
   */
  async getById(outboxId) {
    const row = await this.db('domain_outbox').where({ outbox_id: outboxId }).first();
    return row ? mapDomainOutbox(row) : null;
  }
}

Object.freeze(OutboxRepository.prototype);

// re-export for tests that inspect filter presence
export { hasEligibilityFilter, normalizeClaimEligibility };
