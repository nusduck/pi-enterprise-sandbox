/**
 * PlatformEventProjector (PR-05) — pure, stateless Pi → platform event mapping.
 *
 * No mutable correlators. Tool identity comes from event fields only.
 * Persistence stays outside this projector.
 *
 * Model request lifecycle is NOT projected from agent_start/agent_end (one agent
 * turn may include multiple provider calls). Real model.request.* mapping is
 * PR-06 observability (provider lifecycle).
 */

import { createHash } from 'node:crypto';
import { redactSecretText } from '../../lib/text-redaction.js';

export const PROJECTOR_EVENT_TYPES = Object.freeze([
  'message.delta',
  'message.completed',
  'tool.call.proposed',
  'tool.execution.started',
  'tool.execution.progress',
  'tool.execution.completed',
  'tool.execution.failed',
  'artifact.ready',
  'session.compacted',
  // model.request.* reserved for PR-06 provider lifecycle — not mapped from agent_* here
  'model.request.started',
  'model.request.completed',
  'model.request.failed',
  'error.occurred',
]);

/** Object-key redaction (credential field names). */
const SENSITIVE_KEY =
  /(?:^|_)(?:api[_-]?key|secret|password|authorization|cookie|token|access[_-]?token|refresh[_-]?token|bearer)(?:$|_)/i;

const DEFAULT_MAX_STRING = 512;
const DEFAULT_MAX_RESULT_CHARS = 2048;

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
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Redact sensitive substrings inside free text while preserving safe prose.
 * Does not wipe a whole sentence merely because it contains the word "token".
 *
 * @param {string} text
 * @returns {string}
 */
export function redactInlineSecrets(text) {
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
 * @param {unknown} value
 * @param {{ maxString?: number, depth?: number }} [opts]
 * @returns {unknown}
 */
export function redactPayload(value, opts = {}) {
  const maxString = opts.maxString ?? DEFAULT_MAX_STRING;
  const depth = opts.depth ?? 0;
  if (depth > 6) return '[omitted]';
  if (value == null) return value;
  if (typeof value === 'string') {
    let s = redactInlineSecrets(value);
    if (s.length > maxString) {
      return `${s.slice(0, maxString)}…`;
    }
    return s;
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
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    if (k === 'provider' && v && typeof v === 'object' && !Array.isArray(v)) {
      const p = /** @type {Record<string, unknown>} */ (v);
      out.provider =
        typeof p.id === 'string'
          ? p.id
          : typeof p.name === 'string'
            ? p.name
            : '[omitted]';
      continue;
    }
    if (k === 'model' && v && typeof v === 'object' && !Array.isArray(v)) {
      const m = /** @type {Record<string, unknown>} */ (v);
      out.model = {
        id: m.id ?? m.modelId ?? null,
        provider: m.provider ?? null,
        reasoning: typeof m.reasoning === 'boolean' ? m.reasoning : undefined,
      };
      continue;
    }
    if (typeof v === 'string') {
      let s = redactInlineSecrets(v);
      if (s.length > maxString) {
        out[k] = `${s.slice(0, maxString)}…`;
        out[`${k}_bytes`] = Buffer.byteLength(v, 'utf8');
        out[`${k}_sha256`] = digest(v);
        out[`${k}_truncated`] = true;
      } else {
        out[k] = s;
      }
      continue;
    }
    out[k] = redactPayload(v, { maxString, depth: depth + 1 });
  }
  return out;
}

/**
 * @param {string} toolName
 * @param {unknown} args
 */
export function summarizeToolArgs(toolName, args) {
  void toolName;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    const s = redactInlineSecrets(String(args ?? ''));
    return { value: s.slice(0, DEFAULT_MAX_STRING) };
  }
  return /** @type {Record<string, unknown>} */ (
    redactPayload(args, { maxString: DEFAULT_MAX_STRING })
  );
}

/**
 * @param {unknown} result
 */
export function summarizeToolResult(result) {
  if (result == null) return null;
  if (typeof result === 'string') {
    const redacted = redactInlineSecrets(result);
    if (redacted.length > DEFAULT_MAX_RESULT_CHARS) {
      return {
        text_truncated: true,
        text_bytes: Buffer.byteLength(result, 'utf8'),
        text_sha256: digest(result),
        preview: redacted.slice(0, DEFAULT_MAX_RESULT_CHARS),
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
 * @param {unknown} message
 */
export function summarizeAssistantMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const m = /** @type {Record<string, unknown>} */ (message);
  /** @type {Record<string, unknown>} */
  const out = {
    role: m.role ?? 'assistant',
  };
  let textTruncated = false;
  if (typeof m.stopReason === 'string') out.stopReason = m.stopReason;
  if (Array.isArray(m.content)) {
    out.content = m.content.map((part) => {
      if (!part || typeof part !== 'object') return { type: 'unknown' };
      const p = /** @type {Record<string, unknown>} */ (part);
      if (p.type === 'text') {
        const text = redactInlineSecrets(String(p.text ?? ''));
        const truncated = text.length > DEFAULT_MAX_STRING;
        if (truncated) textTruncated = true;
        return {
          type: 'text',
          text:
            truncated
              ? `${text.slice(0, DEFAULT_MAX_STRING)}…`
              : text,
          truncated,
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
    textTruncated = text.length > DEFAULT_MAX_STRING;
    out.content =
      textTruncated
        ? `${text.slice(0, DEFAULT_MAX_STRING)}…`
        : text;
  }
  // The text body is intentionally a bounded event projection. Make that
  // status explicit at the message level so consumers never overwrite a full
  // streamed or durable transcript with this preview.
  if (textTruncated) out.textTruncated = true;
  return out;
}

/**
 * Extract toolCall blocks from assistant message content (order preserved).
 * @param {unknown} message
 * @returns {Array<{ id: string, name: string, arguments: unknown }>}
 */
export function extractToolCallBlocks(message) {
  if (!message || typeof message !== 'object') return [];
  const content = /** @type {Record<string, unknown>} */ (message).content;
  if (!Array.isArray(content)) return [];
  /** @type {Array<{ id: string, name: string, arguments: unknown }>} */
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = /** @type {Record<string, unknown>} */ (part);
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
 * @param {unknown} message
 * @returns {string}
 */
export function extractAssistantTextForUi(message) {
  if (!message || typeof message !== 'object') return '';
  const m = /** @type {Record<string, unknown>} */ (message);
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

/**
 * Stateless pure projector.
 */
export class PlatformEventProjector {
  /**
   * @param {{ maxString?: number }} [opts]
   */
  constructor(opts = {}) {
    this.maxString = opts.maxString ?? DEFAULT_MAX_STRING;
  }

  /**
   * @param {object | null | undefined} event
   * @param {{
   *   runId?: string | null,
   *   orgId?: string | null,
   *   userId?: string | null,
   *   conversationId?: string | null,
   *   agentSessionId?: string | null,
   *   traceId?: string | null,
   *   spanId?: string | null,
   * }} [ctx]
   * @returns {Array<{ type: string, payload: Record<string, unknown> }>}
   */
  project(event, ctx = {}) {
    if (!event || typeof event !== 'object') return [];
    const type = /** @type {Record<string, unknown>} */ (event).type;
    if (typeof type !== 'string') return [];

    const base = this.#baseContext(ctx);
    const ev = /** @type {Record<string, unknown>} */ (event);

    switch (type) {
      case 'message_update': {
        const ame = /** @type {any} */ (ev).assistantMessageEvent;
        if (ame?.type === 'text_delta') {
          const delta = redactInlineSecrets(String(ame.delta ?? ''));
          return [
            {
              type: 'message.delta',
              payload: {
                ...base,
                role: 'assistant',
                delta: delta.slice(0, this.maxString),
                delta_truncated: delta.length > this.maxString,
              },
            },
          ];
        }
        return [];
      }

      case 'message_end': {
        const message = /** @type {any} */ (ev).message;
        /** @type {Array<{ type: string, payload: Record<string, unknown> }>} */
        const out = [
          {
            type: 'message.completed',
            payload: {
              ...base,
              role: message?.role ?? 'assistant',
              message: summarizeAssistantMessage(message),
            },
          },
        ];
        for (const tc of extractToolCallBlocks(message)) {
          out.push({
            type: 'tool.call.proposed',
            payload: {
              ...base,
              toolCallId: tc.id,
              toolName: tc.name,
              args: summarizeToolArgs(tc.name, tc.arguments),
            },
          });
        }
        return out;
      }

      case 'tool_execution_start': {
        const toolCallId = String(ev.toolCallId ?? '');
        const toolName = String(ev.toolName ?? '');
        return [
          {
            type: 'tool.execution.started',
            payload: {
              ...base,
              toolCallId,
              toolName,
              args: summarizeToolArgs(toolName, ev.args),
            },
          },
        ];
      }

      case 'tool_execution_update': {
        const toolCallId = String(ev.toolCallId ?? '');
        const toolName = String(ev.toolName ?? '');
        return [
          {
            type: 'tool.execution.progress',
            payload: {
              ...base,
              toolCallId,
              toolName,
              progress: redactPayload(
                ev.partialResult ?? ev.progress ?? ev.update ?? null,
              ),
            },
          },
        ];
      }

      case 'tool_execution_end': {
        const toolCallId = String(ev.toolCallId ?? '');
        const toolName = String(ev.toolName ?? '');
        const isError = Boolean(ev.isError);
        return [
          {
            type: isError ? 'tool.execution.failed' : 'tool.execution.completed',
            payload: {
              ...base,
              toolCallId,
              toolName,
              isError,
              result: summarizeToolResult(ev.result),
            },
          },
        ];
      }

      case 'compaction_end': {
        const errorMessage = ev.errorMessage;
        const aborted = Boolean(ev.aborted);
        const result = ev.result;
        if (!aborted && !errorMessage && result != null) {
          return [
            {
              type: 'session.compacted',
              payload: {
                ...base,
                reason: String(ev.reason ?? ''),
                aborted: false,
                willRetry: Boolean(ev.willRetry),
              },
            },
          ];
        }
        if (errorMessage || aborted) {
          const msg = errorMessage
            ? redactInlineSecrets(String(errorMessage)).slice(0, this.maxString)
            : 'compaction aborted';
          return [
            {
              type: 'error.occurred',
              payload: {
                ...base,
                source: 'compaction',
                reason: String(ev.reason ?? ''),
                message: msg,
                aborted,
              },
            },
          ];
        }
        return [];
      }

      // agent_start / agent_end are NOT mapped to model.request.* —
      // one agent lifecycle may include multiple provider calls (PR-06).
      case 'agent_start':
      case 'agent_end':
        return [];

      default:
        return [];
    }
  }

  /**
   * @param {Iterable<object>} events
   * @param {object} [ctx]
   */
  projectMany(events, ctx = {}) {
    /** @type {Array<{ type: string, payload: Record<string, unknown> }>} */
    const out = [];
    for (const ev of events) {
      out.push(...this.project(ev, ctx));
    }
    return out;
  }

  /**
   * @param {object} ctx
   * @returns {Record<string, unknown>}
   */
  #baseContext(ctx) {
    /** @type {Record<string, unknown>} */
    const base = {};
    if (ctx.runId) base.runId = ctx.runId;
    if (ctx.orgId) base.orgId = ctx.orgId;
    if (ctx.userId) base.userId = ctx.userId;
    if (ctx.conversationId) base.conversationId = ctx.conversationId;
    if (ctx.agentSessionId) base.agentSessionId = ctx.agentSessionId;
    if (ctx.traceId) base.traceId = ctx.traceId;
    if (ctx.spanId) base.spanId = ctx.spanId;
    return base;
  }
}

/**
 * @param {object} event
 * @param {object} [ctx]
 */
export function projectPiEvent(event, ctx = {}) {
  return new PlatformEventProjector().project(event, ctx);
}
