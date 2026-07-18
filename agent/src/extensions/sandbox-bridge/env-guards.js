/**
 * Bounded env validation for bash / process_start.
 */

import {
  MAX_ENV_KEY_LEN,
  MAX_ENV_KEYS,
  MAX_ENV_VALUE_LEN,
  SENSITIVE_ENV_KEY,
} from './constants.js';

/**
 * @param {unknown} env
 * @returns {{ ok: true, env: Record<string, string> } | { ok: false, code: string, reason: string }}
 */
export function normalizeBoundedEnv(env) {
  if (env == null) return { ok: true, env: {} };
  if (typeof env !== 'object' || Array.isArray(env)) {
    return { ok: false, code: 'ENV_INVALID', reason: 'env must be an object' };
  }
  const entries = Object.entries(/** @type {object} */ (env));
  if (entries.length > MAX_ENV_KEYS) {
    return {
      ok: false,
      code: 'ENV_TOO_MANY_KEYS',
      reason: `env exceeds ${MAX_ENV_KEYS} keys`,
    };
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of entries) {
    const key = String(k);
    if (!key || key.length > MAX_ENV_KEY_LEN) {
      return { ok: false, code: 'ENV_KEY_INVALID', reason: 'env key invalid or too long' };
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { ok: false, code: 'ENV_KEY_INVALID', reason: 'env key must be identifier-like' };
    }
    if (SENSITIVE_ENV_KEY.test(key)) {
      return {
        ok: false,
        code: 'ENV_SENSITIVE_KEY_DENIED',
        reason: `env key denied by policy: ${key}`,
      };
    }
    const val = v == null ? '' : String(v);
    if (val.length > MAX_ENV_VALUE_LEN) {
      return {
        ok: false,
        code: 'ENV_VALUE_TOO_LONG',
        reason: 'env value exceeds max length',
      };
    }
    out[key] = val;
  }
  return { ok: true, env: out };
}
