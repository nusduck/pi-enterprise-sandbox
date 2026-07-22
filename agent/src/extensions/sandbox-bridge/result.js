/**
 * Pi AgentToolResult helpers + redaction for sandbox-bridge.
 */

import { redactInlineSecrets, redactPayload } from '../../infrastructure/pi/platform-event-projector.js';

/** Match Pi's model-facing tool-output budget: bounded and explicit. */
export const DEFAULT_TOOL_OUTPUT_BYTES = 50 * 1024;
export const DEFAULT_TOOL_OUTPUT_LINES = 2_000;

/**
 * @param {string} text
 * @param {object} [details]
 * @param {{ maxDetailString?: number }} [opts]
 * @returns {{ content: Array<{ type: 'text', text: string }>, details?: object }}
 */
export function toolOk(text, details, opts = {}) {
  const out = {
    content: [{ type: 'text', text: redactInlineSecrets(String(text ?? '')) }],
  };
  if (details != null) {
    out.details = /** @type {object} */ (
      redactPayload(details, { maxString: opts.maxDetailString ?? 512 })
    );
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
 * Pi-style bounded text output. Unlike the former JSON-string truncation,
 * this always returns valid text plus enough metadata for the model to
 * continue with an offset/cursor or choose a narrower query.
 *
 * @param {unknown} value
 * @param {{ maxBytes?: number, maxLines?: number }} [opts]
 */
export function truncateToolOutput(value, opts = {}) {
  const source = redactInlineSecrets(String(value ?? ''));
  const maxBytes = opts.maxBytes ?? DEFAULT_TOOL_OUTPUT_BYTES;
  const maxLines = opts.maxLines ?? DEFAULT_TOOL_OUTPUT_LINES;
  const lines = source.split('\n');
  const totalBytes = Buffer.byteLength(source, 'utf8');
  const totalLines = lines.length;
  /** @type {string[]} */
  const output = [];
  let outputBytes = 0;
  let truncatedBy = null;
  let completedLines = 0;
  let partialLine = false;

  for (let index = 0; index < lines.length; index += 1) {
    if (index >= maxLines) {
      truncatedBy = 'lines';
      break;
    }
    const prefix = output.length ? '\n' : '';
    const prefixBytes = Buffer.byteLength(prefix, 'utf8');
    const line = lines[index];
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (outputBytes + prefixBytes + lineBytes <= maxBytes) {
      output.push(line);
      outputBytes += prefixBytes + lineBytes;
      completedLines += 1;
      continue;
    }

    // Preserve valid UTF-8 by adding complete JS code points only.
    let partial = '';
    let partialBytes = 0;
    const available = Math.max(0, maxBytes - outputBytes - prefixBytes);
    for (const char of line) {
      const charBytes = Buffer.byteLength(char, 'utf8');
      if (partialBytes + charBytes > available) break;
      partial += char;
      partialBytes += charBytes;
    }
    if (partial) {
      output.push(partial);
      outputBytes += prefixBytes + partialBytes;
      partialLine = true;
    }
    truncatedBy = 'bytes';
    break;
  }

  const text = output.join('\n');
  return {
    text,
    truncated: truncatedBy != null,
    truncatedBy,
    totalBytes,
    totalLines,
    outputBytes: Buffer.byteLength(text, 'utf8'),
    outputLines: output.length,
    // Needed by line-oriented read pagination: a byte cap may include only a
    // prefix of the last line, which must not advance the next line offset.
    completedLines,
    partialLine,
  };
}

/**
 * Bound JSON for tool text output.
 * @param {unknown} value
 * @param {number} [maxChars]
 */
export function toolResultJson(value, maxBytes = DEFAULT_TOOL_OUTPUT_BYTES) {
  // The projector's default 512-character cap is right for durable event
  // summaries, but wrong for model-facing tool output: it silently turns a
  // paginated read into a 512-character response before this function can
  // report a useful continuation. Bound the whole JSON document below instead.
  const raw = JSON.stringify(redactPayload(value, { maxString: maxBytes }) ?? null);
  if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return raw;
  const preview = truncateToolOutput(raw, { maxBytes: Math.max(1, maxBytes - 512) });
  // Never return a sliced JSON document: malformed JSON makes models retry
  // blindly. Callers with large payload fields should use truncateToolOutput
  // first so this fallback is exceptional and still machine-readable.
  return JSON.stringify({
    truncated: true,
    truncatedBy: 'result_bytes',
    totalBytes: Buffer.byteLength(raw, 'utf8'),
    preview: preview.text,
  });
}
