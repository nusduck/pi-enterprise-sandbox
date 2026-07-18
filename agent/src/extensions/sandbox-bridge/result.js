/**
 * Pi AgentToolResult helpers + redaction for sandbox-bridge.
 */

import { redactInlineSecrets, redactPayload } from '../../infrastructure/pi/platform-event-projector.js';

/**
 * @param {string} text
 * @param {object} [details]
 * @returns {{ content: Array<{ type: 'text', text: string }>, details?: object }}
 */
export function toolOk(text, details) {
  const out = {
    content: [{ type: 'text', text: redactInlineSecrets(String(text ?? '')) }],
  };
  if (details != null) {
    out.details = /** @type {object} */ (redactPayload(details));
  }
  return out;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 * @returns {{ content: Array<{ type: 'text', text: string }>, details: object, isError?: boolean }}
 */
export function toolErr(code, message, details = {}) {
  const safeMsg = redactInlineSecrets(String(message ?? 'error')).slice(0, 512);
  // Never include physical host paths or tokens in message
  const scrubbed = safeMsg
    .replace(/\/Users\/[^\s]+/g, '[redacted-path]')
    .replace(/\/var\/[^\s]+/g, '[redacted-path]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  return {
    content: [{ type: 'text', text: `Error [${code}]: ${scrubbed}` }],
    details: {
      code: String(code),
      .../** @type {object} */ (redactPayload(details)),
    },
    // Pi tools often encode errors in content; details.code is stable for callers.
  };
}

/**
 * @param {unknown} value
 * @param {number} max
 */
export function truncateText(value, max) {
  const s = redactInlineSecrets(String(value ?? ''));
  if (s.length <= max) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, max)}…`,
    truncated: true,
    bytes: Buffer.byteLength(s, 'utf8'),
  };
}

/**
 * Bound JSON for tool text output.
 * @param {unknown} value
 * @param {number} [maxChars]
 */
export function toolResultJson(value, maxChars = 32_768) {
  const raw = JSON.stringify(redactPayload(value) ?? null);
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}…`;
}
