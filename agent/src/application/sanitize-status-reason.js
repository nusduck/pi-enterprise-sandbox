/**
 * Bound + sanitize status_reason / failure text for MySQL persistence.
 * Never store secrets, DSNs, or raw stacks.
 */

import { redactSecretText } from '../lib/text-redaction.js';

export const STATUS_REASON_MAX_LEN = 255;

/**
 * @param {unknown} err
 * @param {number} [maxLen]
 * @returns {string | null}
 */
export function sanitizeStatusReason(err, maxLen = STATUS_REASON_MAX_LEN) {
  if (err == null || err === '') return null;
  const limit =
    Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : STATUS_REASON_MAX_LEN;

  let text = '';
  if (typeof err === 'string') {
    text = err;
  } else if (err instanceof Error) {
    // Message only — never stack.
    text = err.message || err.name || 'Error';
  } else if (typeof err === 'object' && err !== null && 'message' in err) {
    text = String(/** @type {{ message?: unknown }} */ (err).message ?? 'error');
  } else {
    text = String(err);
  }

  text = text.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  // Shared secret patterns first (Bearer, token=, password=, URI userinfo).
  text = redactSecretText(text);
  // Extra DSN collapse for common connection-string schemes (password already
  // stripped by redactSecretText when present as userinfo).
  text = text
    .replace(/mysql2?:\/\/[^\s]+/gi, 'mysql://***')
    .replace(/redis:\/\/[^\s]+/gi, 'redis://***')
    .replace(/rediss:\/\/[^\s]+/gi, 'rediss://***');

  if (!text) return null;
  if (text.length > limit) {
    return `${text.slice(0, Math.max(0, limit - 1))}…`;
  }
  return text;
}
