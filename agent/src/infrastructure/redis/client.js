/**
 * Redis client factory. Never falls back to empty URL, localhost default, or memory stores.
 *
 * Lazy-loads ioredis so offline unit tests that inject fakes need not install the package.
 * BullMQ workers require maxRetriesPerRequest: null (see createBullMQConnection).
 *
 * Every client (including BullMQ `duplicate()` clones) gets a bounded `error` /
 * `ready` guard so reconnect storms never emit Unhandled error event floods.
 */

import { createRequire } from 'node:module';
import { RedisConfigError, RedisDependencyError } from './errors.js';
import {
  attachRedisConnectionErrorGuard,
  REDIS_ERROR_GUARD_CLEANUP,
} from './redis-connection-error-guard.js';

const require = createRequire(import.meta.url);

/**
 * Clients that have already entered destroy (at-most-once per object identity).
 * WeakSet so GC is not blocked and status/quit failures still count as destroyed.
 * @type {WeakSet<object>}
 */
const destroyedClients = new WeakSet();

/**
 * Classify a rejected URL for error messages without echoing credentials.
 * @param {string} normalized
 * @returns {string}
 */
export function describeRejectedRedisUrl(normalized) {
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
 * True when the string contains C0 controls or DEL (never allowed in DSNs).
 * @param {string} s
 */
function hasControlChars(s) {
  return /[\u0000-\u001f\u007f]/.test(s);
}

/**
 * Strict Redis DSN gate via URL parsing.
 *
 * Accepts only exact protocols `redis:` / `rediss:` with a non-empty hostname.
 * Explicit `redis://localhost` is allowed (not a silent fallback).
 * Rejects empty hosts, password-only hosts, socket-style empty-host URLs, whitespace,
 * control characters, and unsupported schemes. Error messages never include credentials.
 *
 * @param {string | undefined | null} url
 * @returns {string} trimmed original URL when valid
 */
export function assertRedisConnectionUrl(url) {
  if (url == null || typeof url !== 'string') {
    throw new RedisConfigError(
      'Redis connection URL is required (set AGENT_REDIS_URL or TEST_REDIS_URL). ' +
        'Only redis:// or rediss:// with a non-empty hostname are accepted; ' +
        'empty, implicit localhost, and memory fallbacks are not supported.',
    );
  }

  if (hasControlChars(url)) {
    throw new RedisConfigError(
      'Redis connection URL must not contain control characters. ' +
        'Only redis:// or rediss:// with a non-empty hostname are accepted.',
    );
  }

  const normalized = url.trim();
  if (normalized === '') {
    throw new RedisConfigError(
      'Redis connection URL is required (set AGENT_REDIS_URL or TEST_REDIS_URL). ' +
        'Only redis:// or rediss:// with a non-empty hostname are accepted; ' +
        'empty, implicit localhost, and memory fallbacks are not supported.',
    );
  }

  if (/\s/.test(normalized)) {
    throw new RedisConfigError(
      'Redis connection URL must not contain whitespace. ' +
        'Only redis:// or rediss:// with a non-empty hostname are accepted.',
    );
  }

  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    const kind = describeRejectedRedisUrl(normalized);
    throw new RedisConfigError(
      `Unsupported Redis URL for Agent Redis (${kind}). ` +
        'Only redis:// or rediss:// with a non-empty hostname are accepted.',
    );
  }

  // URL.protocol is always lowercase and includes the trailing colon.
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    const kind = `scheme=${parsed.protocol.replace(/:$/, '') || 'unknown'}`;
    throw new RedisConfigError(
      `Unsupported Redis URL for Agent Redis (${kind}). ` +
        'Only redis:// or rediss:// with a non-empty hostname are accepted; ' +
        'memory://, unix://, and bare hosts are rejected.',
    );
  }

  // Reject empty hostname (redis://, redis://:password@, redis:///socket, etc.).
  // Explicit redis://localhost is valid because hostname is the literal "localhost".
  const hostname = parsed.hostname;
  if (hostname == null || hostname === '') {
    throw new RedisConfigError(
      'Redis connection URL requires a non-empty hostname. ' +
        'Implicit localhost and Unix socket forms without a hostname are not accepted.',
    );
  }

  return normalized;
}

/**
 * Load ioredis at runtime so unit tests that only inject fakes need not install it.
 * @returns {typeof import('ioredis').default}
 */
export function loadIoredisModule() {
  try {
    const mod = require('ioredis');
    return typeof mod === 'function' ? mod : mod.default;
  } catch (err) {
    throw new RedisDependencyError(
      'Package "ioredis" is not installed. Add ioredis (see agent/package.json), then npm install.',
      { cause: err },
    );
  }
}

/**
 * Ensure ioredis is resolvable without constructing a client.
 */
export function assertIoredisInstalled() {
  try {
    require.resolve('ioredis');
  } catch (err) {
    throw new RedisDependencyError(
      'Package "ioredis" is not installed. Add ioredis (see agent/package.json), then npm install.',
      { cause: err },
    );
  }
}

/**
 * Ensure bullmq is resolvable (queue/worker factories).
 */
export function assertBullmqInstalled() {
  try {
    require.resolve('bullmq');
  } catch (err) {
    throw new RedisDependencyError(
      'Package "bullmq" is not installed. Add bullmq (see agent/package.json), then npm install.',
      { cause: err },
    );
  }
}

/**
 * Load bullmq at runtime so offline unit tests need not install it.
 * @returns {typeof import('bullmq')}
 */
export function loadBullmqModule() {
  try {
    return require('bullmq');
  } catch (err) {
    throw new RedisDependencyError(
      'Package "bullmq" is not installed. Add bullmq (see agent/package.json), then npm install.',
      { cause: err },
    );
  }
}

/**
 * @typedef {object} RedisClientOptions
 * @property {boolean} [lazyConnect]
 * @property {null | number} [maxRetriesPerRequest]
 * @property {boolean} [enableReadyCheck]
 * @property {boolean} [enableOfflineQueue]
 * @property {string} [connectionRole] log role label (e.g. agent-redis, bullmq-worker)
 * @property {number} [connectionErrorLogIntervalMs] min interval between repeat error logs
 * @property {() => number} [now] injectable clock for error guard tests
 * @property {(level: 'error'|'info', message: string, meta?: Record<string, unknown>) => void} [connectionLog]
 */

/**
 * Build an ioredis subclass that attaches the connection error guard in the
 * constructor so BullMQ `connection.duplicate()` clones also get listeners.
 *
 * @param {typeof import('ioredis').default} Redis
 * @param {{
 *   role: string,
 *   minIntervalMs?: number,
 *   now?: () => number,
 *   log?: (level: 'error'|'info', message: string, meta?: Record<string, unknown>) => void,
 * }} guardOpts
 */
export function createGuardedRedisClass(Redis, guardOpts) {
  class AgentGuardedRedis extends Redis {
    /**
     * @param {string | object} arg1
     * @param {object} [arg2]
     */
    constructor(arg1, arg2) {
      super(arg1, arg2);
      attachRedisConnectionErrorGuard(this, guardOpts);
    }

    /**
     * ioredis 5.x implements duplicate() as `new Redis(...)`, which discards
     * subclasses. Override it explicitly so BullMQ's blocking/internal clones
     * remain guarded too.
     *
     * @param {object} [override]
     */
    duplicate(override) {
      return new AgentGuardedRedis({
        ...this.options,
        ...(override || {}),
      });
    }
  }
  // Helpful in diagnostics without printing URLs.
  Object.defineProperty(AgentGuardedRedis.prototype, 'connectionRole', {
    value: guardOpts.role,
    writable: false,
    enumerable: false,
  });
  return AgentGuardedRedis;
}

/**
 * Create an ioredis client for a validated redis(s):// URL.
 *
 * @param {string} connectionUrl
 * @param {RedisClientOptions} [options]
 * @returns {import('ioredis').default}
 */
export function createRedisClient(connectionUrl, options = {}) {
  const url = assertRedisConnectionUrl(connectionUrl);
  assertIoredisInstalled();
  const Redis = loadIoredisModule();

  /** @type {import('ioredis').RedisOptions} */
  const redisOptions = {
    lazyConnect: options.lazyConnect ?? false,
    enableOfflineQueue: options.enableOfflineQueue ?? true,
  };

  if (options.maxRetriesPerRequest !== undefined) {
    redisOptions.maxRetriesPerRequest = options.maxRetriesPerRequest;
  }
  if (options.enableReadyCheck !== undefined) {
    redisOptions.enableReadyCheck = options.enableReadyCheck;
  }

  const role =
    typeof options.connectionRole === 'string' && options.connectionRole.trim()
      ? options.connectionRole.trim().slice(0, 64)
      : 'agent-redis';

  /** @type {Parameters<typeof attachRedisConnectionErrorGuard>[1]} */
  const guardOpts = { role };
  if (typeof options.connectionErrorLogIntervalMs === 'number') {
    guardOpts.minIntervalMs = options.connectionErrorLogIntervalMs;
  }
  if (typeof options.now === 'function') {
    guardOpts.now = options.now;
  }
  if (typeof options.connectionLog === 'function') {
    guardOpts.log = options.connectionLog;
  }

  const GuardedRedis = createGuardedRedisClass(Redis, guardOpts);
  return new GuardedRedis(url, redisOptions);
}

/**
 * BullMQ-compatible connection factory.
 * Workers require maxRetriesPerRequest: null; enableReadyCheck false is the common pairing.
 *
 * Callers must create separate connections for Queue vs Worker (BullMQ recommendation).
 *
 * @param {string} connectionUrl
 * @param {RedisClientOptions} [options]
 * @returns {import('ioredis').default}
 */
export function createBullMQConnection(connectionUrl, options = {}) {
  return createRedisClient(connectionUrl, {
    ...options,
    maxRetriesPerRequest: null,
    enableReadyCheck: options.enableReadyCheck ?? false,
    connectionRole:
      options.connectionRole != null && String(options.connectionRole).trim()
        ? options.connectionRole
        : 'bullmq',
  });
}

/**
 * At-most-once client teardown (integration tests / process shutdown).
 *
 * Marks the object destroyed in a module-private WeakSet before any I/O so that:
 * - status never updating still yields a no-op on later calls
 * - quit throwing still falls through to disconnect once, then no-ops forever
 *
 * @param {{ quit?: () => Promise<unknown>, disconnect?: () => void, status?: string } | null | undefined} client
 */
export async function destroyRedisClient(client) {
  if (client == null || (typeof client !== 'object' && typeof client !== 'function')) {
    return;
  }

  /** @type {object} */
  const obj = /** @type {object} */ (client);
  if (destroyedClients.has(obj)) {
    return;
  }
  // Claim first — concurrent/repeat destroy is a pure no-op after this point.
  destroyedClients.add(obj);

  // Detach error/ready guard before quit so shutdown races do not log as outages.
  try {
    const cleanup = /** @type {any} */ (client)[REDIS_ERROR_GUARD_CLEANUP];
    if (typeof cleanup === 'function') {
      cleanup();
    }
  } catch {
    // ignore
  }

  if (typeof client.quit === 'function') {
    try {
      await client.quit();
      return;
    } catch {
      // Fall through to hard disconnect on first quit failure only.
    }
  }

  if (typeof client.disconnect === 'function') {
    try {
      client.disconnect();
    } catch {
      // Ignore secondary failures; object remains marked destroyed.
    }
  }
}
