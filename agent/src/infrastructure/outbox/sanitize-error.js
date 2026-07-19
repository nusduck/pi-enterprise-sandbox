/**
 * Bound and sanitize error text stored on domain_outbox.last_error.
 * Never store secrets, full DSNs, or unbounded stacks.
 */

import { redactSecretText } from '../../../lib/text-redaction.js';
import { LAST_ERROR_MAX_LEN } from './outbox-status.js';

/**
 * @param {unknown} err
 * @param {number} [maxLen]
 * @returns {string}
 */
export function sanitizeOutboxError(err, maxLen = LAST_ERROR_MAX_LEN) {
  const limit = Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : LAST_ERROR_MAX_LEN;
  let text = '';
  if (err == null) {
    text = 'unknown error';
  } else if (typeof err === 'string') {
    text = err;
  } else if (err instanceof Error) {
    text = err.message || err.name || 'Error';
  } else if (typeof err === 'object' && err !== null && 'message' in err) {
    text = String(/** @type {{ message?: unknown }} */ (err).message ?? 'error');
  } else {
    text = String(err);
  }

  // Collapse whitespace / newlines from stacks accidentally passed as message.
  text = text.replace(/\s+/g, ' ').trim();

  // Shared secret patterns first (Bearer, token=, password=, URI userinfo).
  text = redactSecretText(text);
  // Extra DSN collapse for common connection-string schemes.
  text = text
    .replace(/mysql2?:\/\/[^\s]+/gi, 'mysql://***')
    .replace(/redis:\/\/[^\s]+/gi, 'redis://***')
    .replace(/rediss:\/\/[^\s]+/gi, 'rediss://***');

  if (!text) text = 'unknown error';
  if (text.length > limit) {
    return `${text.slice(0, Math.max(0, limit - 1))}…`;
  }
  return text;
}
