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

const attachedClients: WeakSet<Record<string, any>> = new WeakSet();

/** @type {symbol} */
export const REDIS_ERROR_GUARD_CLEANUP = Symbol.for(
  'pi.enterprise.redis.connectionErrorGuardCleanup',
);

/**
 * Strip credentials / redis URLs from free-form error text.
 * @param err
 * @returns {{ category: string, message: string, stack: string | null }}
 */
export function classifyRedisConnectionError(err: unknown) {
  const code =
    err && typeof err === 'object' && 'code' in err && err.code != null
      ? String((err as { code: unknown }).code)
      : err && typeof err === 'object' && 'errno' in err && err.errno != null
        ? String((err as { errno: unknown }).errno)
        : 'UNKNOWN';

  let message =
    err instanceof Error
      ? err.message
      : err == null
        ? String(err)
        : typeof err === 'string'
          ? err
          : String((err as { message?: unknown }).message ?? err);

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
 * @param text
 * @returns {string}
 */
export function sanitizeRedisLogText(text: string) {
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
export type ConnectionHealthState = 'ok' | 'degraded';

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
export function createConnectionErrorGuard(opts: { role?: string, minIntervalMs?: number, now?: () => number, log?: (level: 'error' | 'info', message: string, meta?: Record<string, unknown>) => void, } = {}) {
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

  let state: ConnectionHealthState = 'ok';
  let lastErrorLogAt: number | null = null;
  let lastCategory: string | null = null;
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

        const meta: Record<string, unknown> = {
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

      const meta: Record<string, unknown> = { role };
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
 * @param level
 * @param message
 * @param [meta]
 */
export function defaultConnectionLog(level: 'error' | 'info', message: string, meta: Record<string, unknown> = {}) {
  const safe = {
    role: meta.role,
    category: meta.category,
    detail: meta.detail,
    suppressed: meta.suppressed,
  };
  // Drop undefined keys for compact logs
  for (const k of Object.keys(safe)) {
    if (safe[(k as keyof typeof safe)] === undefined) {
      delete safe[(k as keyof typeof safe)];
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
 * @param client
 * @param {{
 *   role?: string,
 *   minIntervalMs?: number,
 *   now?: () => number,
 *   log?: (level: 'error' | 'info', message: string, meta?: Record<string, unknown>) => void,
 * }} [opts]
 * @returns {(() => void) | null} dispose/remove listeners; null if already attached or invalid
 */
export function attachRedisConnectionErrorGuard(client: Record<string, any>, opts: { role?: string, minIntervalMs?: number, now?: () => number, log?: (level: 'error' | 'info', message: string, meta?: Record<string, unknown>) => void, } = {}) {
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
        delete (client as any)[REDIS_ERROR_GUARD_CLEANUP];
      }
    } catch {
      // ignore non-configurable
    }
  };

  try {
    (client as any)[REDIS_ERROR_GUARD_CLEANUP] = dispose;
  } catch {
    // If symbol attach fails, dispose still works via returned function.
  }

  return dispose;
}

function removeListener(client: Record<string, any>, event: string, fn: (...args: any[]) => void) {
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
 * @param client
 */
export function hasRedisConnectionErrorGuard(client: Record<string, any> | null | undefined) {
  return client != null && typeof client === 'object' && attachedClients.has(client);
}
