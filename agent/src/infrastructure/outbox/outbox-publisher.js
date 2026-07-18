/**
 * Outbox Publisher for RunEventStream (plan §7.2 Redis / §9.3 / PR-03).
 *
 * Claims only eligibility-matched durable rows (default: run aggregates +
 * non-run rows with payload.runId). Unrelated domain_outbox rows stay PENDING
 * for other publishers.
 *
 * Error classification:
 * - Permanent mapping errors (missing/invalid sequence, ids, type, createdAt)
 *   → markFailed once. Never Redis-retry.
 * - Stream/Redis append failures → markPendingForRetry (transient).
 *
 * After a successful Redis append:
 * - markPublished true → PUBLISHED
 * - markPublished false → leave PUBLISHING (stale reclaim recovers). At-least-once:
 *   reclaim may re-append the same stable eventId; consumers must tolerate duplicates.
 * - markPublished throws → propagate DB error; row remains PUBLISHING (recoverable).
 *   Database exceptions are never swallowed.
 *
 * Never mutates Run status or other business state.
 */

import {
  RUN_STREAM_CLAIM_ELIGIBILITY,
  normalizeClaimEligibility,
} from './eligibility.js';
import {
  requirePositiveDurationMs,
  requirePositiveInteger,
  resolveBatchLimit,
} from './options.js';
import {
  isPermanentMappingError,
  mapOutboxToRunStreamEvent,
} from './stream-mapper.js';
import { DEFAULT_CLAIM_BATCH_SIZE } from './outbox-status.js';

/**
 * @typedef {{
 *   append: (
 *     runId: string,
 *     fields: {
 *       eventId: string,
 *       sequence: string,
 *       type: string,
 *       payload: string,
 *       createdAt: string,
 *     },
 *   ) => Promise<unknown>,
 * }} RunEventStreamLike
 */

/**
 * @typedef {import('./eligibility.js').ClaimEligibility} ClaimEligibility
 */

/**
 * @typedef {{
 *   claimBatch: (opts?: {
 *     limit?: number,
 *     eligibility?: ClaimEligibility | null,
 *   }) => Promise<any[]>,
 *   markPublished: (outboxId: string, claimToken: string) => Promise<boolean>,
 *   markPendingForRetry: (
 *     outboxId: string,
 *     claimToken: string,
 *     error: unknown,
 *     opts?: { attempts?: number },
 *   ) => Promise<'retry' | 'failed' | 'noop'>,
 *   markFailed: (
 *     outboxId: string,
 *     claimToken: string,
 *     error: unknown,
 *   ) => Promise<boolean>,
 * }} OutboxRepositoryLike
 */

export class OutboxPublisher {
  /**
   * @param {{
   *   repository: OutboxRepositoryLike,
   *   stream: RunEventStreamLike,
   *   batchSize?: number,
   *   maxPasses?: number,
   *   idleDelayMs?: number,
   *   eligibility?: ClaimEligibility | null,
   *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.repository) {
      throw new Error('OutboxPublisher requires repository');
    }
    if (!deps?.stream || typeof deps.stream.append !== 'function') {
      throw new Error('OutboxPublisher requires stream with append()');
    }
    this.repository = deps.repository;
    this.stream = deps.stream;
    this.batchSize = resolveBatchLimit(
      deps.batchSize,
      DEFAULT_CLAIM_BATCH_SIZE,
      500,
      'batchSize',
    );
    this.maxPasses = requirePositiveInteger(
      'maxPasses',
      deps.maxPasses ?? 100,
      { min: 1, max: 1_000_000 },
    );
    this.idleDelayMs = requirePositiveDurationMs(
      'idleDelayMs',
      deps.idleDelayMs ?? 1_000,
      { min: 1, max: 86_400_000 },
    );
    this.eligibility =
      deps.eligibility === undefined
        ? RUN_STREAM_CLAIM_ELIGIBILITY
        : deps.eligibility === null
          ? null
          : normalizeClaimEligibility(deps.eligibility);
    this.sleep = deps.sleep ?? defaultSleep;

    /** @type {AbortController | null} */
    this._lifecycle = null;
    /** @type {Promise<{ passes: number, totals: PublishTotals }> | null} */
    this._loopPromise = null;
    this._passInFlight = false;
  }

  /**
   * Single claim → map → append → settle pass.
   *
   * @param {{ limit?: number, eligibility?: ClaimEligibility | null }} [opts]
   * @returns {Promise<PassResult>}
   */
  async publishOnce(opts = {}) {
    const limit =
      opts.limit !== undefined
        ? resolveBatchLimit(opts.limit, this.batchSize, 500, 'publishOnce.limit')
        : this.batchSize;
    const eligibility =
      opts.eligibility !== undefined ? opts.eligibility : this.eligibility;

    const claimed = await this.repository.claimBatch({ limit, eligibility });

    /** @type {PassResult} */
    const result = {
      claimed: claimed.length,
      published: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
      noop: 0,
      /**
       * Redis append succeeded but markPublished returned false.
       * Row left PUBLISHING for stale reclaim; stable eventId may duplicate.
       */
      ackMissed: 0,
    };

    for (const row of claimed) {
      const outboxId = row.outboxId;
      const claimToken = row.claimToken;
      if (!outboxId || !claimToken) {
        result.noop += 1;
        continue;
      }

      let mapped;
      try {
        mapped = mapOutboxToRunStreamEvent(row);
      } catch (err) {
        if (isPermanentMappingError(err)) {
          const ok = await this.repository.markFailed(
            outboxId,
            claimToken,
            err,
          );
          if (ok) result.failed += 1;
          else result.noop += 1;
          continue;
        }
        // Unexpected mapper errors are treated as permanent durable defects.
        const ok = await this.repository.markFailed(
          outboxId,
          claimToken,
          err,
        );
        if (ok) result.failed += 1;
        else result.noop += 1;
        continue;
      }

      try {
        await this.stream.append(mapped.runId, mapped.fields);
      } catch (err) {
        // Transient stream/Redis failure only — never markFailed on first error.
        const outcome = await this.repository.markPendingForRetry(
          outboxId,
          claimToken,
          err,
          { attempts: row.attempts },
        );
        if (outcome === 'retry') result.retried += 1;
        else if (outcome === 'failed') result.failed += 1;
        else result.noop += 1;
        continue;
      }

      // Redis append succeeded. Settle outbox; do not re-append on ack issues.
      //
      // At-least-once contract:
      // If markPublished returns false (token lost) or the process crashes before
      // ack, the row stays PUBLISHING until stale reclaim → PENDING → re-claim.
      // Re-publish uses the same stable eventId; stream consumers must dedupe.
      let published;
      try {
        published = await this.repository.markPublished(outboxId, claimToken);
      } catch (err) {
        // Database exception after successful append — leave row PUBLISHING
        // (recoverable via stale reclaim) and surface the error.
        throw err;
      }

      if (published) {
        result.published += 1;
      } else {
        result.ackMissed += 1;
        result.skipped += 1;
      }
    }

    return result;
  }

  /**
   * Bounded multi-pass loop. Stops on stop(), abort, maxPasses, or idle.
   * Does not leak timers: sleep is abortable and cleared on stop().
   *
   * @param {{
   *   maxPasses?: number,
   *   continueOnIdle?: boolean,
   *   limit?: number,
   * }} [opts]
   * @returns {Promise<{ passes: number, totals: PublishTotals }>}
   */
  async runLoop(opts = {}) {
    if (this._loopPromise) {
      throw new Error('OutboxPublisher loop already running');
    }

    const maxPasses =
      opts.maxPasses !== undefined
        ? requirePositiveInteger('maxPasses', opts.maxPasses, {
            min: 1,
            max: 1_000_000,
          })
        : this.maxPasses;
    const continueOnIdle = opts.continueOnIdle === true;
    const lifecycle = new AbortController();
    this._lifecycle = lifecycle;

    this._loopPromise = (async () => {
      /** @type {PublishTotals} */
      const totals = {
        claimed: 0,
        published: 0,
        retried: 0,
        failed: 0,
        skipped: 0,
        noop: 0,
        ackMissed: 0,
      };
      let passes = 0;

      try {
        while (!lifecycle.signal.aborted && passes < maxPasses) {
          this._passInFlight = true;
          let pass;
          try {
            pass = await this.publishOnce({ limit: opts.limit });
          } finally {
            this._passInFlight = false;
          }
          passes += 1;
          accumulate(totals, pass);

          if (lifecycle.signal.aborted) break;
          if (pass.claimed === 0) {
            if (!continueOnIdle) break;
            await this.sleep(this.idleDelayMs, lifecycle.signal);
            continue;
          }
        }
      } finally {
        this._lifecycle = null;
        this._loopPromise = null;
      }

      return { passes, totals };
    })();

    return this._loopPromise;
  }

  /**
   * Request loop stop and wait for in-flight pass to finish.
   * @returns {Promise<void>}
   */
  async stop() {
    const lifecycle = this._lifecycle;
    if (lifecycle && !lifecycle.signal.aborted) {
      lifecycle.abort();
    }
    const loop = this._loopPromise;
    if (loop) {
      try {
        await loop;
      } catch {
        // stop() is best-effort; loop errors surface to runLoop caller.
      }
    }
  }

  /** @returns {boolean} */
  get running() {
    return this._loopPromise != null;
  }
}

/**
 * @typedef {{
 *   claimed: number,
 *   published: number,
 *   retried: number,
 *   failed: number,
 *   skipped: number,
 *   noop: number,
 *   ackMissed: number,
 * }} PassResult
 */

/**
 * @typedef {PassResult} PublishTotals
 */

/**
 * @param {PublishTotals} totals
 * @param {PassResult} pass
 */
function accumulate(totals, pass) {
  totals.claimed += pass.claimed;
  totals.published += pass.published;
  totals.retried += pass.retried;
  totals.failed += pass.failed;
  totals.skipped += pass.skipped;
  totals.noop += pass.noop;
  totals.ackMissed += pass.ackMissed;
}

/**
 * Abortable sleep; no uncleared timer when aborted.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function defaultSleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

Object.freeze(OutboxPublisher.prototype);
