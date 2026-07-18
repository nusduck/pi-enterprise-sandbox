/**
 * Agent Session distributed lock (PR-05).
 *
 * Key: agent:session-lock:{agentSessionId}
 * Acquire: SET NX PX ownerToken
 * Renew/release: token-safe Lua.
 *
 * Redis lock absence or busy is **coordination only** — never Session status.
 * Use {@link generateSessionLockOwnerToken} so each execution gets a unique token
 * even when worker identity is shared (Slice B).
 */

import { randomBytes } from 'node:crypto';
import {
  SESSION_LOCK_TTL_MS,
  SESSION_LOCK_RENEW_INTERVAL_MS,
  sessionLockKey,
} from './constants.js';
import { SessionLockError } from './errors.js';
import {
  assertAgentSessionId,
  assertOwnerToken,
} from './validation.js';

const SESSION_LOCK_RENEW_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
`.trim();

const SESSION_LOCK_RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`.trim();

/**
 * @param {unknown} n
 * @param {string} field
 * @param {number} fallback
 * @returns {number}
 */
function assertPositiveMs(n, field, fallback) {
  if (n == null || n === '') return fallback;
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) {
    throw new SessionLockError(`${field} must be a positive number of milliseconds`, {
      code: 'SESSION_LOCK_CONFIG_INVALID',
    });
  }
  return Math.floor(v);
}

/**
 * Unique acquisition owner token per execution.
 * Format: `{workerIdentity}:{cryptographicSuffix}` so the same worker process
 * still gets distinct tokens across concurrent/sequential locks.
 *
 * @param {string} workerIdentity non-empty worker id / host identity
 * @param {{ randomBytes?: (n: number) => Buffer | Uint8Array }} [opts]
 * @returns {string}
 */
export function generateSessionLockOwnerToken(workerIdentity, opts = {}) {
  const base = String(workerIdentity ?? '').trim();
  if (!base) {
    throw new SessionLockError('workerIdentity is required for session lock owner token', {
      code: 'SESSION_LOCK_OWNER_INVALID',
    });
  }
  const rnd = opts.randomBytes ?? randomBytes;
  const suffix = Buffer.from(rnd(16)).toString('hex');
  const token = `${base}:${suffix}`;
  return assertOwnerToken(token);
}

/**
 * @typedef {object} RedisLike
 * @property {(key: string, value: string, ...args: unknown[]) => Promise<string | null>} set
 * @property {(key: string) => Promise<string | null>} get
 * @property {(script: string, numKeys: number, ...args: unknown[]) => Promise<unknown>} eval
 */

/**
 * @param {{
 *   intervalMs: number,
 *   tick: () => Promise<void>,
 *   isStopped: () => boolean,
 * }} opts
 */
export function createSerialRenewLoop(opts) {
  const intervalMs = Math.max(1, Number(opts.intervalMs) || 1);
  let stopped = false;
  let timer = null;
  /** @type {Promise<void> | null} */
  let inFlight = null;

  const schedule = () => {
    if (stopped || opts.isStopped()) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped || opts.isStopped()) return;
      const tickPromise = (async () => {
        try {
          if (stopped || opts.isStopped()) return;
          await opts.tick();
        } finally {
          /* tick owns errors */
        }
      })();
      inFlight = tickPromise.finally(() => {
        if (inFlight === tickPromise) inFlight = null;
        if (!stopped && !opts.isStopped()) schedule();
      });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  return {
    start() {
      if (stopped) return;
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export class SessionLockManager {
  /**
   * @param {RedisLike} redis
   * @param {{
   *   ttlMs?: number,
   *   renewIntervalMs?: number,
   *   createRenewLoop?: typeof createSerialRenewLoop,
   * }} [options]
   */
  constructor(redis, options = {}) {
    if (!redis || typeof redis.set !== 'function' || typeof redis.eval !== 'function') {
      throw new Error('SessionLockManager requires a redis client with set() and eval()');
    }
    this.redis = redis;
    this.ttlMs = assertPositiveMs(options.ttlMs, 'ttlMs', SESSION_LOCK_TTL_MS);
    this.renewIntervalMs = assertPositiveMs(
      options.renewIntervalMs,
      'renewIntervalMs',
      SESSION_LOCK_RENEW_INTERVAL_MS,
    );
    this.createRenewLoop = options.createRenewLoop ?? createSerialRenewLoop;
  }

  /**
   * @param {string} agentSessionId
   * @returns {string}
   */
  key(agentSessionId) {
    return sessionLockKey(agentSessionId);
  }

  /**
   * @param {string} agentSessionId
   * @param {string} ownerToken
   * @returns {Promise<boolean>}
   */
  async acquire(agentSessionId, ownerToken) {
    const id = assertAgentSessionId(agentSessionId);
    const owner = assertOwnerToken(ownerToken);
    const result = await this.redis.set(
      this.key(id),
      owner,
      'PX',
      this.ttlMs,
      'NX',
    );
    return result === 'OK';
  }

  /**
   * @param {string} agentSessionId
   * @param {string} ownerToken
   * @returns {Promise<void>}
   */
  async acquireOrThrow(agentSessionId, ownerToken) {
    const id = assertAgentSessionId(agentSessionId);
    const ok = await this.acquire(id, ownerToken);
    if (!ok) {
      throw new SessionLockError(`Failed to acquire session lock for ${id}`, {
        agentSessionId: id,
        code: 'SESSION_LOCK_NOT_ACQUIRED',
      });
    }
  }

  /**
   * @param {string} agentSessionId
   * @param {string} ownerToken
   * @returns {Promise<boolean>}
   */
  async renew(agentSessionId, ownerToken) {
    const id = assertAgentSessionId(agentSessionId);
    const owner = assertOwnerToken(ownerToken);
    const result = await this.redis.eval(
      SESSION_LOCK_RENEW_LUA,
      1,
      this.key(id),
      owner,
      String(this.ttlMs),
    );
    return Number(result) === 1;
  }

  /**
   * @param {string} agentSessionId
   * @param {string} ownerToken
   * @returns {Promise<boolean>}
   */
  async release(agentSessionId, ownerToken) {
    const id = assertAgentSessionId(agentSessionId);
    const owner = assertOwnerToken(ownerToken);
    const result = await this.redis.eval(
      SESSION_LOCK_RELEASE_LUA,
      1,
      this.key(id),
      owner,
    );
    return Number(result) === 1;
  }

  /**
   * @param {string} agentSessionId
   * @returns {Promise<string | null>}
   */
  async getOwner(agentSessionId) {
    const id = assertAgentSessionId(agentSessionId);
    const value = await this.redis.get(this.key(id));
    return value == null ? null : String(value);
  }

  /**
   * @param {string} agentSessionId
   * @param {string} ownerToken
   * @param {{ onLost?: (err?: unknown) => void, intervalMs?: number }} [opts]
   */
  startRenewLoop(agentSessionId, ownerToken, opts = {}) {
    const id = assertAgentSessionId(agentSessionId);
    const owner = assertOwnerToken(ownerToken);
    let lost = false;
    const loop = this.createRenewLoop({
      intervalMs: opts.intervalMs ?? this.renewIntervalMs,
      isStopped: () => lost,
      tick: async () => {
        try {
          const ok = await this.renew(id, owner);
          if (!ok && !lost) {
            lost = true;
            opts.onLost?.(
              new SessionLockError('session lock renew lost ownership', {
                agentSessionId: id,
                code: 'SESSION_LOCK_LOST',
              }),
            );
          }
        } catch (err) {
          if (!lost) {
            lost = true;
            opts.onLost?.(err);
          }
        }
      },
    });
    loop.start();
    return {
      stop: async () => {
        lost = true;
        await loop.stop();
      },
      isLost: () => lost,
    };
  }
}

export {
  SESSION_LOCK_RENEW_LUA,
  SESSION_LOCK_RELEASE_LUA,
};
