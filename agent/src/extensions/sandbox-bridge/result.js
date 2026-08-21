/**
 * Pi AgentToolResult helpers + redaction for sandbox-bridge.
 */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from '@earendil-works/pi-coding-agent';
import { redactInlineSecrets, redactPayload } from '../../infrastructure/pi/event-redaction.js';
import { safeSlice } from '../../lib/text-redaction.js';

/**
 * Pi's model-facing tool-output budget, taken from the SDK rather than copied.
 * When Pi retunes what fits in a tool result, sandbox-routed tools follow.
 */
export const DEFAULT_TOOL_OUTPUT_BYTES = DEFAULT_MAX_BYTES;
export const DEFAULT_TOOL_OUTPUT_LINES = DEFAULT_MAX_LINES;

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
 * Bounded text output for a sandbox tool result.
 *
 * This is deliberately *not* Pi's `truncateHead`, and the difference is one
 * behaviour: when a single line is wider than the byte budget, `truncateHead`
 * returns empty content with `firstLineExceedsLimit`, while this returns the
 * prefix that fits and flags `partialLine`. A minified bundle or a one-line CSV
 * is a normal thing to find in a workspace, and handing the model nothing at
 * all for it is a dead end — the read tool's pagination reports `completedLines`
 * so the next offset still never skips an unread line.
 *
 * The budgets themselves come from the SDK (see DEFAULT_TOOL_OUTPUT_*), and
 * `tests/pi/sandbox-truncation-contract.unit.test.js` pins where the two agree,
 * so an SDK change to the shared semantics surfaces rather than drifting.
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
 * Hermes-style character budget: keep whole lines that fit under maxChars.
 * Unlike {@link truncateToolOutput}, this counts JS string length (code units)
 * as a token proxy rather than UTF-8 bytes.
 *
 * @param {string} content
 * @param {number} maxChars
 * @returns {{ text: string, linesKept: number, truncated: boolean, partialLine: boolean }}
 */
export function truncateToCharBudget(content, maxChars) {
  const source = String(content ?? '');
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return { text: '', linesKept: 0, truncated: true, partialLine: false };
  }
  if (source.length <= maxChars) {
    return {
      text: source,
      linesKept: source ? source.split('\n').length : 0,
      truncated: false,
      partialLine: false,
    };
  }

  const lines = source.split('\n');
  /** @type {string[]} */
  const kept = [];
  let running = 0;
  for (const line of lines) {
    const addition = line.length + (kept.length ? 1 : 0);
    if (running + addition > maxChars) break;
    kept.push(line);
    running += addition;
  }

  if (kept.length === 0) {
    // First line alone exceeds the budget — clamp on a code-point boundary
    // (never split a surrogate pair) so the read never returns empty and the
    // caller can still advance.
    return {
      text: safeSlice(lines[0], maxChars).text,
      linesKept: 0,
      truncated: true,
      partialLine: true,
    };
  }

  return {
    text: kept.join('\n'),
    linesKept: kept.length,
    truncated: true,
    partialLine: false,
  };
}

/**
 * Bound JSON for tool text output.
 * Callers with large payload fields should pre-bound those fields (e.g. read
 * content via {@link truncateToCharBudget}) so this fallback is exceptional.
 *
 * @param {unknown} value
 * @param {number} [maxBytes]
 */
export function toolResultJson(value, maxBytes = DEFAULT_TOOL_OUTPUT_BYTES) {
  // The projector's default 512-character cap is right for durable event
  // summaries, but wrong for model-facing tool output: it silently turns a
  // paginated read into a 512-character response before this function can
  // report a useful continuation. Bound the whole JSON document below instead.
  // Do not re-truncate large string fields here with redactPayload maxString —
  // that would silently destroy pre-bounded content into 50KB-ish fragments.
  const raw = JSON.stringify(redactPayload(value, { maxString: Math.max(maxBytes, 1) }) ?? null);
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
