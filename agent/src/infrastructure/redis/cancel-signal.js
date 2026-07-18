/**
 * Redis cancel signal for in-flight runs (plan §9.2 run:cancel:{runId}).
 *
 * Signal-only coordination: request / isRequested / clear with TTL.
 * Does not mutate MySQL Run rows — CancelRunService owns fact-source updates.
 */

import { CANCEL_SIGNAL_TTL_MS, runCancelKey } from './constants.js';
import { assertRunId } from './validation.js';

/**
 * @typedef {object} RedisCancelLike
 * @property {(key: string, value: string, ...args: unknown[]) => Promise<string | null>} set
 * @property {(key: string) => Promise<string | null>} get
 * @property {(key: string | string[]) => Promise<number>} del
 * @property {(key: string) => Promise<number>} [exists]
 * @property {(key: string, ms: number) => Promise<number>} [pexpire]
 */

export class CancelSignal {
  /**
   * @param {RedisCancelLike} redis
   * @param {{ ttlMs?: number }} [options]
   */
  constructor(redis, options = {}) {
    if (!redis || typeof redis.set !== 'function' || typeof redis.get !== 'function') {
      throw new Error('CancelSignal requires a redis client with set() and get()');
    }
    this.redis = redis;
    this.ttlMs = options.ttlMs ?? CANCEL_SIGNAL_TTL_MS;
  }

  /**
   * @param {string} runId
   * @returns {string}
   */
  key(runId) {
    return runCancelKey(runId);
  }

  /**
   * Mark cancel requested. Overwrites previous signal and refreshes TTL.
   *
   * @param {string} runId
   * @param {{ reason?: string, requestedBy?: string }} [meta]
   * @returns {Promise<void>}
   */
  async request(runId, meta = {}) {
    const id = assertRunId(runId);
    const body = JSON.stringify({
      requested: true,
      reason: meta.reason ?? null,
      requestedBy: meta.requestedBy ?? null,
      at: new Date().toISOString(),
    });
    await this.redis.set(this.key(id), body, 'PX', this.ttlMs);
  }

  /**
   * @param {string} runId
   * @returns {Promise<boolean>}
   */
  async isRequested(runId) {
    const id = assertRunId(runId);
    const value = await this.redis.get(this.key(id));
    return value != null && value !== '';
  }

  /**
   * Remove cancel signal (e.g. after terminal handling). No-op if absent.
   *
   * @param {string} runId
   * @returns {Promise<boolean>} true when a key was deleted
   */
  async clear(runId) {
    const id = assertRunId(runId);
    const n = await this.redis.del(this.key(id));
    return Number(n) > 0;
  }
}
