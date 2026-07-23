/**
 * Sandbox tool request-hash v1 (PR-07B batch 2A).
 *
 * Strict cross-language contract shared with Python
 * `sandbox/app/domain/tool_request_hash.py` and golden fixture
 * `tests/fixtures/contracts/sandbox-tool-request-hash-v1.json`.
 *
 * Envelope: `{ "v": 1, "tool": <toolName>, "args": <normalized args> }`
 * Hash: SHA-256 lowercase hex of compact UTF-8 JSON with ASCII key byte-order sort.
 *
 * Fail-closed: rejects float, unsafe int, BigInt, Date, Buffer, undefined,
 * function, symbol, custom objects, cycles, non-ASCII keys, lone surrogates.
 * Does NOT reuse permissive stableCanonicalStringify.
 */

import { createHash } from 'node:crypto';

export const TOOL_REQUEST_HASH_VERSION = 1;
export const TOOL_NAME_MAX_LEN = 255;

/** Printable ASCII keys only (space through tilde). */
const ASCII_KEY_RE = /^[\x20-\x7E]+$/;

export class ToolRequestHashError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'TOOL_REQUEST_HASH_INVALID') {
    super(message);
    this.name = 'ToolRequestHashError';
    this.code = code;
  }
}

/**
 * @param {string} s
 * @returns {boolean}
 */
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length) return true;
      const c2 = s.charCodeAt(i + 1);
      if (c2 < 0xdc00 || c2 > 0xdfff) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} toolName
 * @returns {string}
 */
export function assertToolRequestToolName(toolName) {
  if (typeof toolName !== 'string') {
    throw new ToolRequestHashError(
      'toolName must be a non-empty already-trimmed string',
      'TOOL_REQUEST_HASH_BAD_TOOL_NAME',
    );
  }
  if (!toolName || toolName !== toolName.trim() || toolName.length === 0) {
    throw new ToolRequestHashError(
      'toolName must be a non-empty already-trimmed string',
      'TOOL_REQUEST_HASH_BAD_TOOL_NAME',
    );
  }
  if (toolName.length > TOOL_NAME_MAX_LEN) {
    throw new ToolRequestHashError(
      `toolName exceeds max length ${TOOL_NAME_MAX_LEN}`,
      'TOOL_REQUEST_HASH_BAD_TOOL_NAME',
    );
  }
  if (hasLoneSurrogate(toolName)) {
    throw new ToolRequestHashError(
      'toolName contains lone Unicode surrogate',
      'TOOL_REQUEST_HASH_BAD_TOOL_NAME',
    );
  }
  return toolName;
}

/**
 * Canonical JSON fragment for an accepted value (no surrounding whitespace).
 *
 * @param {unknown} value
 * @param {Set<object>} stack
 * @returns {string}
 */
function canonicalizeValue(value, stack) {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'string') {
    if (hasLoneSurrogate(/** @type {string} */ (value))) {
      throw new ToolRequestHashError(
        'string contains lone Unicode surrogate',
        'TOOL_REQUEST_HASH_LONE_SURROGATE',
      );
    }
    return JSON.stringify(value);
  }

  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new ToolRequestHashError(
        'number must be finite (no NaN/Infinity)',
        'TOOL_REQUEST_HASH_BAD_NUMBER',
      );
    }
    if (!Number.isInteger(value)) {
      throw new ToolRequestHashError(
        'float is not allowed in request-hash args',
        'TOOL_REQUEST_HASH_FLOAT',
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new ToolRequestHashError(
        'integer outside JS safe integer range',
        'TOOL_REQUEST_HASH_UNSAFE_INT',
      );
    }
    return String(value);
  }

  if (t === 'bigint') {
    throw new ToolRequestHashError(
      'BigInt is not allowed',
      'TOOL_REQUEST_HASH_BIGINT',
    );
  }

  if (t === 'undefined' || t === 'function' || t === 'symbol') {
    throw new ToolRequestHashError(
      `type ${t} is not allowed`,
      'TOOL_REQUEST_HASH_BAD_TYPE',
    );
  }

  if (t !== 'object') {
    throw new ToolRequestHashError(
      `unsupported type ${t}`,
      'TOOL_REQUEST_HASH_BAD_TYPE',
    );
  }

  if (value instanceof Date) {
    throw new ToolRequestHashError(
      'Date is not allowed',
      'TOOL_REQUEST_HASH_BAD_TYPE',
    );
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    throw new ToolRequestHashError(
      'Buffer/bytes are not allowed',
      'TOOL_REQUEST_HASH_BAD_TYPE',
    );
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new ToolRequestHashError(
      'bytes/ArrayBuffer are not allowed',
      'TOOL_REQUEST_HASH_BAD_TYPE',
    );
  }

  const objRef = /** @type {object} */ (value);
  if (stack.has(objRef)) {
    throw new ToolRequestHashError(
      'cyclic structure is not allowed',
      'TOOL_REQUEST_HASH_CYCLE',
    );
  }

  if (Array.isArray(value)) {
    stack.add(objRef);
    try {
      const parts = value.map((v) => canonicalizeValue(v, stack));
      return `[${parts.join(',')}]`;
    } finally {
      stack.delete(objRef);
    }
  }

  // Plain object only — reject custom prototypes (except Object.prototype / null).
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new ToolRequestHashError(
      'custom objects are not allowed',
      'TOOL_REQUEST_HASH_BAD_TYPE',
    );
  }

  stack.add(objRef);
  try {
    const obj = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(obj);
    for (const k of keys) {
      if (typeof k !== 'string' || !ASCII_KEY_RE.test(k)) {
        throw new ToolRequestHashError(
          'object keys must be ASCII printable strings',
          'TOOL_REQUEST_HASH_NON_ASCII_KEY',
        );
      }
    }
    // ASCII object-key byte-order sort (code-unit / UTF-8 for ASCII).
    keys.sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalizeValue(obj[k], stack)}`,
    );
    return `{${parts.join(',')}}`;
  } finally {
    stack.delete(objRef);
  }
}

/**
 * Build canonical envelope JSON for request-hash v1.
 *
 * @param {{ toolName: string, args?: unknown }} input
 * @returns {string}
 */
export function canonicalToolRequestJsonV1(input) {
  const toolName = assertToolRequestToolName(input.toolName);
  const args = input.args === undefined ? {} : input.args;
  const stack = new Set();
  const argsJson = canonicalizeValue(args, stack);
  // Fixed key order for envelope: args, tool, v (ASCII sort) — but we emit
  // exact contract field order via manual construction matching the envelope
  // shape with sorted keys: args, tool, v.
  return `{"args":${argsJson},"tool":${JSON.stringify(toolName)},"v":${TOOL_REQUEST_HASH_VERSION}}`;
}

/**
 * @param {{ toolName: string, args?: unknown }} input
 * @returns {{ requestHash: string, requestHashVersion: number, canonicalJson: string }}
 */
export function computeToolRequestHashV1(input) {
  const canonicalJson = canonicalToolRequestJsonV1(input);
  const requestHash = createHash('sha256')
    .update(canonicalJson, 'utf8')
    .digest('hex');
  return {
    requestHash,
    requestHashVersion: TOOL_REQUEST_HASH_VERSION,
    canonicalJson,
  };
}
