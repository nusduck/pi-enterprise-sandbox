/**
 * Bounded Redis connection error / recovery logging.
 *
 * ioredis emits many `error` events during outages (reconnect loop). Without a
 * listener Node prints "[ioredis] Unhandled error event" for every attempt.
 * BullMQ also `duplicate()`s connections — listeners must attach in the Redis
 * constructor so clones are covered without double-attach on the same instance.
 *
 * Policy:
 * - Always handle `error` (never leave unhandled).
 * - Log the first transition into degraded (with stack, sanitized).
 * - While degraded: log at most once per minIntervalMs across all categories;
 *   count suppressed events and include the count on the next log line. DNS
 *   failures commonly alternate ENOTFOUND/ETIMEDOUT, so category changes must
 *   not bypass the bound.
 * - On `ready` after degraded: single recovery log; reset so the next outage
 *   can log its first error again.
 * - Never log DSNs or password material.
 */

import { redactSecretText } from '../../lib/text-redaction.js';

/** @type {WeakSet<object>} */
const attachedClients = new WeakSet();

/** @type {symbol} */
export const REDIS_ERROR_GUARD_CLEANUP = Symbol.for(
  'pi.enterprise.redis.connectionErrorGuardCleanup',
);

/**
 * Strip credentials / redis URLs from free-form error text.
 * @param {unknown} err
 * @returns {{ category: string, message: string, stack: string | null }}
 */
export function classifyRedisConnectionError(err) {
  const code =
    err && typeof err === 'object' && 'code' in err && err.code != null
      ? String(/** @type {{ code: unknown }} */ (err).code)
      : err && typeof err === 'object' && 'errno' in err && err.errno != null
        ? String(/** @type {{ errno: unknown }} */ (err).errno)
        : 'UNKNOWN';

  let message =
    err instanceof Error
      ? err.message
      : err == null
        ? String(err)
        : typeof err === 'string'
          ? err
          : String(/** @type {{ message?: unknown }} */ (err).message ?? err);

  message = sanitizeRedisLogText(message);

  let stack = null;
  if (err instanceof Error && typeof err.stack === 'string') {
    stack = sanitizeRedisLogText(err.stack).slice(0, 2000);
  }

  return {
    category: code.slice(0, 64) || 'UNKNOWN',
    message: message.slice(0, 400),
    stack,
  };
}

/**
 * @param {string} text
 * @returns {string}
 */
export function sanitizeRedisLogText(text) {
  // Shared secret patterns first (Bearer, access_token=, sk-*, URI userinfo).
  let s = redactSecretText(String(text));
  // Collapse any remaining redis URLs (including non-credential forms).
  s = s.replace(/rediss?:\/\/[^\s"'`]+/gi, 'redis://***');
  // leftover :password@host forms
  s = s.replace(/:([^@/\s"'`]{1,200})@/g, ':***@');
  // AUTH / password= / passwd= fragments (passwd not in shared patterns)
  s = s.replace(
    /(password|passwd|auth)\s*[=:]\s*\S+/gi,
    '$1=***',
  );
  return s;
}

/**
 * @typedef {'ok' | 'degraded'} ConnectionHealthState
 *
 * @typedef {{
 *   onError: (err: unknown) => void,
 *   onReady: () => void,
 *   dispose: () => void,
 *   getSnapshot: () => {
 *     state: ConnectionHealthState,
 *     suppressedCount: number,
 *     lastCategory: string | null,
 *     lastErrorLogAt: number,
 *     disposed: boolean,
 *   },
 * }} ConnectionErrorGuard
 */

/**
 * Pure rate-limit / state machine (injectable clock + logger for tests).
 *
 * @param {{
 *   role?: string,
 *   minIntervalMs?: number,
 *   now?: () => number,
 *   log?: (level: 'error' | 'info', message: string, meta?: Record<string, unknown>) => void,
 * }} [opts]
 * @returns {ConnectionErrorGuard}
 */
export function createConnectionErrorGuard(opts = {}) {
  const role = String(opts.role || 'redis').slice(0, 64);
  const minIntervalMs =
    typeof opts.minIntervalMs === 'number' && opts.minIntervalMs >= 0
      ? opts.minIntervalMs
      : 30_000;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const log =
    typeof opts.log === 'function'
      ? opts.log
      : defaultConnectionLog;

  /** @type {ConnectionHealthState} */
  let state = 'ok';
  /** @type {number | null} null = never logged / reset after recovery (not wall-clock 0). */
  let lastErrorLogAt = null;
  /** @type {string | null} */
  let lastCategory = null;
  let suppressedCount = 0;
  let disposed = false;

  return {
    onError(err) {
      if (disposed) return;
      const { category, message, stack } = classifyRedisConnectionError(err);
      const t = now();
      const enteringDegraded = state !== 'degraded';
      const intervalElapsed =
        lastErrorLogAt == null || t - lastErrorLogAt >= minIntervalMs;

      // Log on: enter degraded (first of outage), or the next rate window.
      // Category changes are still captured in the next summary but never
      // bypass the per-connection bound.
      if (enteringDegraded || intervalElapsed) {
        const suppressed = suppressedCount;
        suppressedCount = 0;
        lastErrorLogAt = t;
        lastCategory = category;
        state = 'degraded';

        /** @type {Record<string, unknown>} */
        const meta = {
          role,
          category,
          detail: message,
        };
        if (suppressed > 0) meta.suppressed = suppressed;
        // Full stack only on transition into degraded (first of an outage).
        if (enteringDegraded && stack) meta.stack = stack;

        log(
          'error',
          `[${role}] redis connection error category=${category}` +
            (suppressed > 0 ? ` suppressed=${suppressed}` : ''),
          meta,
        );
        return;
      }

      lastCategory = category;
      suppressedCount += 1;
    },

    onReady() {
      if (disposed) return;
      if (state !== 'degraded') {
        // Initial ready or redundant ready — no spam.
        return;
      }
      const suppressed = suppressedCount;
      suppressedCount = 0;
      state = 'ok';
      lastCategory = null;
      // Next outage's first error logs immediately (enteringDegraded).
      lastErrorLogAt = null;

      /** @type {Record<string, unknown>} */
      const meta = { role };
      if (suppressed > 0) meta.suppressed = suppressed;

      log(
        'info',
        `[${role}] redis connection restored` +
          (suppressed > 0 ? ` suppressed_during_outage=${suppressed}` : ''),
        meta,
      );
    },

    dispose() {
      disposed = true;
    },

    getSnapshot() {
      return {
        state,
        suppressedCount,
        lastCategory,
        lastErrorLogAt,
        disposed,
      };
    },
  };
}

/**
 * Default logger — no DSN; stack only when provided in meta.
 * @param {'error' | 'info'} level
 * @param {string} message
 * @param {Record<string, unknown>} [meta]
 */
export function defaultConnectionLog(level, message, meta = {}) {
  const safe = {
    role: meta.role,
    category: meta.category,
    detail: meta.detail,
    suppressed: meta.suppressed,
  };
  // Drop undefined keys for compact logs
  for (const k of Object.keys(safe)) {
    if (safe[/** @type {keyof typeof safe} */ (k)] === undefined) {
      delete safe[/** @type {keyof typeof safe} */ (k)];
    }
  }
  if (level === 'error') {
    if (meta.stack) {
      console.error(message, safe, '\n', meta.stack);
    } else {
      console.error(message, safe);
    }
  } else {
    console.info(message, safe);
  }
}

/**
 * Attach guard listeners once per client. Safe on EventEmitter-like fakes.
 *
 * @param {object} client
 * @param {{
 *   role?: string,
 *   minIntervalMs?: number,
 *   now?: () => number,
 *   log?: (level: 'error' | 'info', message: string, meta?: Record<string, unknown>) => void,
 * }} [opts]
 * @returns {(() => void) | null} dispose/remove listeners; null if already attached or invalid
 */
export function attachRedisConnectionErrorGuard(client, opts = {}) {
  if (client == null || typeof client !== 'object') return null;
  if (typeof client.on !== 'function') return null;
  if (attachedClients.has(client)) return null;

  attachedClients.add(client);
  const guard = createConnectionErrorGuard(opts);

  const onError = (err) => {
    guard.onError(err);
  };
  const onReady = () => {
    guard.onReady();
  };

  client.on('error', onError);
  // ioredis: 'ready' after (re)connect is usable; also covers first connect.
  client.on('ready', onReady);

  const dispose = () => {
    guard.dispose();
    // Drop ready (no recovery log after teardown). Keep `error` listener so
    // quit/disconnect races never surface as Unhandled error event — onError
    // is a silent no-op once disposed.
    removeListener(client, 'ready', onReady);
    attachedClients.delete(client);
    try {
      if (
        client &&
        typeof client === 'object' &&
        REDIS_ERROR_GUARD_CLEANUP in client
      ) {
        delete /** @type {any} */ (client)[REDIS_ERROR_GUARD_CLEANUP];
      }
    } catch {
      // ignore non-configurable
    }
  };

  try {
    /** @type {any} */ (client)[REDIS_ERROR_GUARD_CLEANUP] = dispose;
  } catch {
    // If symbol attach fails, dispose still works via returned function.
  }

  return dispose;
}

/**
 * @param {object} client
 * @param {string} event
 * @param {(...args: any[]) => void} fn
 */
function removeListener(client, event, fn) {
  if (typeof client.off === 'function') {
    client.off(event, fn);
    return;
  }
  if (typeof client.removeListener === 'function') {
    client.removeListener(event, fn);
  }
}

/**
 * Whether this client already has the production error guard attached.
 * @param {object | null | undefined} client
 */
export function hasRedisConnectionErrorGuard(client) {
  return client != null && typeof client === 'object' && attachedClients.has(client);
}
