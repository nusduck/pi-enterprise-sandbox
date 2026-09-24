/**
 * Run worker lease coordination (plan §9.5).
 *
 * SET run:lease:{runId} ownerToken NX PX ttl — ownership-token-safe renew/release via Lua.
 * Does not interpret or mutate MySQL Run status.
 */

import { LEASE_TTL_MS, LEASE_RENEW_INTERVAL_MS, runLeaseKey } from './constants.js';
import { LeaseError } from './errors.js';
import { assertOwnerToken, assertRunId } from './validation.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

/** Renew only if current value equals owner token. Returns 1 on success, 0 otherwise. */
const RENEW_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`.trim();

/** Delete only if current value equals owner token. Returns 1 if deleted, 0 otherwise. */
const RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`.trim();

export type RedisLike = {
  set: (key: string, value: string, ...args: unknown[]) => Promise<string | null>;
  get: (key: string) => Promise<string | null>;
  eval: (script: string, numKeys: number, ...args: unknown[]) => Promise<unknown>;
};

export class LeaseManager {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  redis: Loose;
  ttlMs: Loose;
  renewIntervalMs: Loose;

  constructor(redis: RedisLike, options: { ttlMs?: number, renewIntervalMs?: number } = {}) {
    if (!redis || typeof redis.set !== 'function' || typeof redis.eval !== 'function') {
      throw new Error('LeaseManager requires a redis client with set() and eval()');
    }
    this.redis = redis;
    this.ttlMs = options.ttlMs ?? LEASE_TTL_MS;
    this.renewIntervalMs = options.renewIntervalMs ?? LEASE_RENEW_INTERVAL_MS;
  }

  /**
   * @param runId
   * @returns {string}
   */
  key(runId: string) {
    return runLeaseKey(runId);
  }

  /**
   * Acquire lease with SET NX PX. Returns true if this owner won the lease.
   *
   * @param runId
   * @param ownerToken worker identity token stored as lease value
   * @returns {Promise<boolean>}
   */
  async acquire(runId: string, ownerToken: string) {
    const id = assertRunId(runId);
    const owner = assertOwnerToken(ownerToken);
    const result = await this.redis.set(this.key(id), owner, 'PX', this.ttlMs, 'NX');
    return result === 'OK';
  }

  /**
   * Extend TTL only when the caller still owns the lease.
   *
   * @param runId
   * @param ownerToken
   * @returns {Promise<boolean>} true when renewed
   */
  async renew(runId: string, ownerToken: string) {
    const id = assertRunId(runId);
    const owner = assertOwnerToken(ownerToken);
    const result = await this.redis.eval(RENEW_LUA, 1, this.key(id), owner, String(this.ttlMs));
    return Number(result) === 1;
  }

  /**
   * Release lease only when the caller still owns it.
   * Wrong owner cannot delete another worker's lease.
   *
   * @param runId
   * @param ownerToken
   * @returns {Promise<boolean>} true when deleted
   */
  async release(runId: string, ownerToken: string) {
    const id = assertRunId(runId);
    const owner = assertOwnerToken(ownerToken);
    const result = await this.redis.eval(RELEASE_LUA, 1, this.key(id), owner);
    return Number(result) === 1;
  }

  /**
   * Current owner token, or null if no lease.
   * Absence means no coordination lease — not a Run terminal status.
   *
   * @param runId
   * @returns {Promise<string | null>}
   */
  async getOwner(runId: string) {
    const id = assertRunId(runId);
    const value = await this.redis.get(this.key(id));
    return value == null ? null : String(value);
  }

  /**
   * Acquire or throw LeaseError (optional helper for callers that prefer exceptions).
   *
   * @param runId
   * @param ownerToken
   * @returns {Promise<void>}
   */
  async acquireOrThrow(runId: string, ownerToken: string) {
    const id = assertRunId(runId);
    const ok = await this.acquire(id, ownerToken);
    if (!ok) {
      throw new LeaseError(`Failed to acquire lease for run ${id}`, {
        runId: id,
        code: 'LEASE_NOT_ACQUIRED',
      });
    }
  }
}

export { RENEW_LUA, RELEASE_LUA };
