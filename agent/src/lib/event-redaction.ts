/**
 * Redaction and summarisation for anything the runtime hands us before it is persisted
 * or shown to a user.
 *
 * Split out of platform-event-projector.js: twelve modules depend on these
 * helpers, while the projector class that used to sit beside them is not on the
 * production event path at all (see its header). Importing the whole projector
 * just to reach `redactPayload` made that dead path look load-bearing.
 *
 * Everything here is pure — no I/O, no correlators, no persistence.
 */

import { createHash } from 'node:crypto';
import { redactSecretText, safeSlice } from './text-redaction.js';

/** Object-key redaction (credential field names). */
const SENSITIVE_KEY =
  /(?:^|_)(?:api[_-]?key|secret|password|authorization|cookie|token|access[_-]?token|refresh[_-]?token|bearer)(?:$|_)/i;

export const DEFAULT_MAX_STRING = 512;
export const DEFAULT_MAX_RESULT_CHARS = 2048;

/**
 * Projector-first inline patterns that produce a uniform `[redacted]` token
 * (nicer for model/event payloads than key=[REDACTED]). Shared durable coverage
 * lives in `SECRET_PATTERNS` / `redactSecretText` — keep these as a superset
 * only for replacement style, not for unique secret classes.
 * Avoid matching the bare English word "token" in harmless prose.
 */
const INLINE_SECRET_PATTERNS = [
  // Authorization: Bearer <token>
  /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // Bearer <token> standalone
  /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/gi,
  // Field-style secrets (same classes as SECRET_PATTERNS field alternation)
  /\b(?:api[_-]?key|x-api-key|x-auth-token|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|authorization)\s*[:=]\s*['"]?[^\s'"]{3,}['"]?/gi,
  // cookie: name=value
  /\bCookie\s*:\s*[^\n\r]+/gi,
  // sk- live keys
  /\bsk-[A-Za-z0-9]{10,}\b/g,
];

/**
 * @param value
 * @returns {boolean}
 */
function isPlainObject(value: unknown) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param value
 * @returns {string}
 */
function digest(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Redact sensitive substrings inside free text while preserving safe prose.
 * Does not wipe a whole sentence merely because it contains the word "token".
 *
 * @param text
 * @returns {string}
 */
export function redactInlineSecrets(text: string) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const re of INLINE_SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    re.lastIndex = 0;
    out = out.replace(re, '[redacted]');
  }
  return redactSecretText(out);
}

/**
 * @param value
 * @param [opts]
 * @returns {unknown}
 */
export function redactPayload(value: unknown, opts: { maxString?: number, depth?: number } = {}) {
  const maxString = opts.maxString ?? DEFAULT_MAX_STRING;
  const depth = opts.depth ?? 0;
  if (depth > 6) return '[omitted]';
  if (value == null) return value;
  if (typeof value === 'string') {
    const s = redactInlineSecrets(value);
    const sliced = safeSlice(s, maxString);
    return sliced.truncated ? `${sliced.text}…` : sliced.text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((v) => redactPayload(v, { maxString, depth: depth + 1 }));
  }
  if (!isPlainObject(value)) {
    return String(value).slice(0, maxString);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    if (k === 'provider' && v && typeof v === 'object' && !Array.isArray(v)) {
      const p = (v as Record<string, unknown>);
      out.provider =
        typeof p.id === 'string'
          ? p.id
          : typeof p.name === 'string'
            ? p.name
            : '[omitted]';
      continue;
    }
    if (k === 'model' && v && typeof v === 'object' && !Array.isArray(v)) {
      const m = (v as Record<string, unknown>);
      out.model = {
        id: m.id ?? m.modelId ?? null,
        provider: m.provider ?? null,
        reasoning: typeof m.reasoning === 'boolean' ? m.reasoning : undefined,
      };
      continue;
    }
    if (typeof v === 'string') {
      const s = redactInlineSecrets(v);
      const sliced = safeSlice(s, maxString);
      if (sliced.truncated) {
        out[k] = `${sliced.text}…`;
        out[`${k}_bytes`] = Buffer.byteLength(v, 'utf8');
        out[`${k}_sha256`] = digest(v);
        out[`${k}_truncated`] = true;
      } else {
        out[k] = sliced.text;
      }
      continue;
    }
    out[k] = redactPayload(v, { maxString, depth: depth + 1 });
  }
  return out;
}

export function summarizeToolArgs(toolName: string, args: unknown) {
  void toolName;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    const s = redactInlineSecrets(String(args ?? ''));
    return { value: safeSlice(s, DEFAULT_MAX_STRING).text };
  }
  return ((
    redactPayload(args, { maxString: DEFAULT_MAX_STRING })) as Record<string, unknown>);
}

export function summarizeToolResult(result: unknown) {
  if (result == null) return null;
  if (typeof result === 'string') {
    const redacted = redactInlineSecrets(result);
    const sliced = safeSlice(redacted, DEFAULT_MAX_RESULT_CHARS);
    if (sliced.truncated) {
      return {
        text_truncated: true,
        text_bytes: Buffer.byteLength(result, 'utf8'),
        text_sha256: digest(result),
        preview: sliced.text,
      };
    }
    return { text: redacted };
  }
  if (typeof result !== 'object') {
    return { value: redactInlineSecrets(String(result)) };
  }
  return redactPayload(result, { maxString: DEFAULT_MAX_RESULT_CHARS });
}

/**
 * Bounded redacted projection of a complete assistant message.
 * @param message
 */
export function summarizeAssistantMessage(message: unknown) {
  if (!message || typeof message !== 'object') return null;
  const m = (message as Record<string, unknown>);
  const out: Record<string, unknown> = {
    role: m.role ?? 'assistant',
  };
  let textTruncated = false;
  if (typeof m.stopReason === 'string') out.stopReason = m.stopReason;
  if (Array.isArray(m.content)) {
    out.content = m.content.map((part) => {
      if (!part || typeof part !== 'object') return { type: 'unknown' };
      const p = (part as Record<string, unknown>);
      if (p.type === 'text') {
        const text = redactInlineSecrets(String(p.text ?? ''));
        const sliced = safeSlice(text, DEFAULT_MAX_STRING);
        if (sliced.truncated) textTruncated = true;
        return {
          type: 'text',
          text: sliced.truncated ? `${sliced.text}…` : sliced.text,
          truncated: sliced.truncated,
        };
      }
      if (p.type === 'toolCall') {
        return {
          type: 'toolCall',
          id: p.id ?? null,
          name: p.name ?? null,
          args: summarizeToolArgs(String(p.name ?? ''), p.arguments ?? p.args),
        };
      }
      return { type: String(p.type ?? 'unknown') };
    });
  } else if (typeof m.content === 'string') {
    const text = redactInlineSecrets(m.content);
    const sliced = safeSlice(text, DEFAULT_MAX_STRING);
    textTruncated = sliced.truncated;
    out.content = sliced.truncated ? `${sliced.text}…` : sliced.text;
  }
  // The text body is intentionally a bounded event projection. Make that
  // status explicit at the message level so consumers never overwrite a full
  // streamed or durable transcript with this preview.
  if (textTruncated) out.textTruncated = true;
  return out;
}

/**
 * Extract toolCall blocks from assistant message content (order preserved).
 * @param message
 * @returns {Array<{ id: string, name: string, arguments: unknown }>}
 */
export function extractToolCallBlocks(message: unknown) {
  if (!message || typeof message !== 'object') return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string, name: string, arguments: unknown }> = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = (part as Record<string, unknown>);
    if (p.type !== 'toolCall') continue;
    out.push({
      id: String(p.id ?? ''),
      name: String(p.name ?? ''),
      arguments: p.arguments ?? p.args ?? {},
    });
  }
  return out;
}

/**
 * UI-safe assistant text only (no toolCall args leakage).
 * @param message
 * @returns {string}
 */
export function extractAssistantTextForUi(message: unknown) {
  if (!message || typeof message !== 'object') return '';
  const m = (message as Record<string, unknown>);
  if (typeof m.content === 'string') {
    return redactInlineSecrets(m.content);
  }
  if (!Array.isArray(m.content)) return '';
  const parts = [];
  for (const part of m.content) {
    if (part && typeof part === 'object' && part.type === 'text') {
      parts.push(redactInlineSecrets(String(part.text ?? '')));
    }
  }
  return parts.join('');
}
