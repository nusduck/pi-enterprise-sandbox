/**
 * Redis cancel signal for in-flight runs (plan §9.2 run:cancel:{runId}).
 *
 * Signal-only coordination: request / isRequested / clear with TTL.
 * Does not mutate MySQL Run rows — CancelRunService owns fact-source updates.
 */

import { CANCEL_SIGNAL_TTL_MS, runCancelKey } from './constants.js';
import { assertRunId } from './validation.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export type RedisCancelLike = {
  set: (key: string, value: string, ...args: unknown[]) => Promise<string | null>;
  get: (key: string) => Promise<string | null>;
  del: (key: string | string[]) => Promise<number>;
  exists?: (key: string) => Promise<number>;
  pexpire?: (key: string, ms: number) => Promise<number>;
};

export class CancelSignal {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  redis: Loose;
  ttlMs: Loose;

  constructor(redis: RedisCancelLike, options: { ttlMs?: number } = {}) {
    if (!redis || typeof redis.set !== 'function' || typeof redis.get !== 'function') {
      throw new Error('CancelSignal requires a redis client with set() and get()');
    }
    this.redis = redis;
    this.ttlMs = options.ttlMs ?? CANCEL_SIGNAL_TTL_MS;
  }

  /**
   * @param runId
   * @returns {string}
   */
  key(runId: string) {
    return runCancelKey(runId);
  }

  /**
   * Mark cancel requested. Overwrites previous signal and refreshes TTL.
   *
   * @param runId
   * @param [meta]
   * @returns {Promise<void>}
   */
  async request(runId: string, meta: { reason?: string, requestedBy?: string } = {}) {
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
   * @param runId
   * @returns {Promise<boolean>}
   */
  async isRequested(runId: string) {
    const id = assertRunId(runId);
    const value = await this.redis.get(this.key(id));
    return value != null && value !== '';
  }

  /**
   * Remove cancel signal (e.g. after terminal handling). No-op if absent.
   *
   * @param runId
   * @returns {Promise<boolean>} true when a key was deleted
   */
  async clear(runId: string) {
    const id = assertRunId(runId);
    const n = await this.redis.del(this.key(id));
    return Number(n) > 0;
  }
}
