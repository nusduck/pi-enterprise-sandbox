/**
 * Dependency-free stable canonical JSON + SHA-256 (PR-04 T2).
 *
 * Used for idempotency request hashing. Rejects unsupported types, circular
 * references, and non-finite numbers. Bounds serialized size.
 *
 * Never hash or store bearer tokens / auth secrets — callers must pass a
 * redacted request body (see hashCreateRunRequest).
 */

import { createHash } from 'node:crypto';
import { CanonicalJsonError } from './errors.js';

/** Default max serialized bytes for hashed request bodies. */
export const DEFAULT_MAX_CANONICAL_BYTES = 256 * 1024;

/** Default max messages array length for CreateRun hashing. */
export const DEFAULT_MAX_MESSAGES = 100;

/** Default max single message content string length (chars). */
export const DEFAULT_MAX_MESSAGE_CHARS = 64 * 1024;

/**
 * @param value
 * @returns {boolean}
 */
function isPlainObject(value: unknown) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Produce a JSON-serializable canonical form with sorted object keys.
 *
 * Cycle detection uses a **recursion stack** (add on enter, delete on leave)
 * so shared-but-acyclic object graphs serialize successfully, while true
 * cycles still throw.
 *
 * @param value
 * @param [stack]
 * @returns {unknown}
 */
export function canonicalize(value: unknown, stack: WeakSet<Record<string, any>> = new WeakSet()) {
  if (value === null) return null;

  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;

  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError('non-finite numbers are not supported', {
        value: String(value),
      });
    }
    // Normalize -0 → 0 for stable hashing.
    return Object.is(value, -0) ? 0 : value;
  }

  if (t === 'bigint') {
    throw new CanonicalJsonError('bigint is not supported');
  }
  if (t === 'undefined') {
    throw new CanonicalJsonError('undefined is not supported');
  }
  if (t === 'function' || t === 'symbol') {
    throw new CanonicalJsonError(`${t} is not supported`);
  }

  if (t === 'object') {
    if (value instanceof Date) {
      throw new CanonicalJsonError(
        'Date is not supported; pass ISO strings instead',
      );
    }
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
      throw new CanonicalJsonError('binary buffers are not supported');
    }

    const obj = (value as object);
    if (stack.has(obj)) {
      throw new CanonicalJsonError('circular reference is not supported');
    }
    stack.add(obj);
    try {
      if (Array.isArray(value)) {
        const out = new Array(value.length);
        for (let i = 0; i < value.length; i += 1) {
          out[i] = canonicalize(value[i], stack);
        }
        return out;
      }

      if (!isPlainObject(value)) {
        throw new CanonicalJsonError(
          'only plain objects and arrays are supported',
        );
      }

            const out: Record<string, unknown> = {};
      const keys = Object.keys((value as object)).sort();
      for (const k of keys) {
        // Skip undefined-valued keys (stable omit) rather than failing.
        const v = (value as Record<string, unknown>)[k];
        if (v === undefined) continue;
        out[k] = canonicalize(v, stack);
      }
      return out;
    } finally {
      // Leave recursion frame so siblings may re-visit shared (acyclic) nodes.
      stack.delete(obj);
    }
  }

  throw new CanonicalJsonError(`unsupported type: ${t}`);
}

/**
 * Stable JSON string (sorted keys, no whitespace variance).
 * @param value
 * @param [opts]
 * @returns {string}
 */
export function stableStringify(value: unknown, opts: { maxBytes?: number } = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_CANONICAL_BYTES;
  const canonical = canonicalize(value);
  const text = JSON.stringify(canonical);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) {
    throw new CanonicalJsonError(
      `canonical JSON exceeds max size ${maxBytes} bytes`,
      { bytes, maxBytes },
    );
  }
  return text;
}

/**
 * SHA-256 hex digest of a string (utf8).
 * @param text
 * @returns {string}
 */
export function sha256Hex(text: string) {
  if (typeof text !== 'string') {
    throw new CanonicalJsonError('sha256Hex requires a string');
  }
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Canonicalize + SHA-256.
 * @param value
 * @param [opts]
 * @returns {string}
 */
export function hashCanonical(value: unknown, opts: { maxBytes?: number } = {}) {
  return sha256Hex(stableStringify(value, opts));
}

/**
 * Build the redacted CreateRun body used for idempotency hashing.
 * Excludes auth secrets, bearer tokens, and external identity material that
 * is already bound by owner-scoped idempotency keys.
 *
 * @param {{
 *   messages?: unknown,
 *   externalConversationId?: string | null,
 *   agentProfileId?: string | null,
 *   agentId?: string | null,
 *   modelId?: string | null,
 *   budget?: unknown,
 * }} input
 * @param {{
 *   maxMessages?: number,
 *   maxMessageChars?: number,
 *   maxBytes?: number,
 * }} [opts]
 * @returns {string} 64-char lowercase hex
 */
export function hashCreateRunRequest(input: { messages?: unknown, externalConversationId?: string | null, agentProfileId?: string | null, agentId?: string | null, modelId?: string | null, budget?: unknown, }, opts: { maxMessages?: number, maxMessageChars?: number, maxBytes?: number, } = {}) {
  const maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxMessageChars = opts.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;

  if (input == null || typeof input !== 'object') {
    throw new CanonicalJsonError('CreateRun request body must be an object');
  }

  const messages = input.messages;
  if (!Array.isArray(messages)) {
    throw new CanonicalJsonError('messages must be an array');
  }
  if (messages.length === 0) {
    throw new CanonicalJsonError('messages must be a non-empty array');
  }
  if (messages.length > maxMessages) {
    throw new CanonicalJsonError(
      `messages exceeds max length ${maxMessages}`,
      { length: messages.length, maxMessages },
    );
  }

  // Bound nested string sizes before full canonical walk.
  const boundMessages = messages.map((m, i) => {
    const text = JSON.stringify(m);
    if (text.length > maxMessageChars) {
      throw new CanonicalJsonError(
        `messages[${i}] exceeds max size ${maxMessageChars} chars`,
      );
    }
    return m;
  });

    const body: Record<string, unknown> = {
    messages: boundMessages,
  };
  if (
    input.externalConversationId != null &&
    input.externalConversationId !== ''
  ) {
    body.externalConversationId = String(input.externalConversationId);
  }
  if (input.agentProfileId != null && input.agentProfileId !== '') {
    body.agentProfileId = String(input.agentProfileId);
  }
  if (input.agentId != null && input.agentId !== '') {
    body.agentId = String(input.agentId);
  }
  if (input.modelId != null && input.modelId !== '') {
    body.modelId = String(input.modelId);
  }
  if (input.budget != null) {
    body.budget = input.budget;
  }

  return hashCanonical(body, { maxBytes: opts.maxBytes });
}
