/**
 * Request-side validation for internal-plane files/skills read.
 *
 * Fail-closed normalisation of a read command before it reaches the wire:
 * bounded ASCII identifiers, strict integer offset/limit, and canonical paths
 * that must resolve under a logical root. Produces the exact body bytes and
 * their digest so the HMAC signature covers what is actually sent.
 */

import { createHash } from 'node:crypto';
import { computeToolRequestHashV1 } from '../../domain/tool/tool-request-hash.js';
import { assertUlid } from '../../domain/shared/ulid.js';
import {
  BODY_ROOT_KEYS,
  FILES_READ_TOOL_NAME,
  IDENTIFIER_MAX_LEN,
  IDENTITY_KEYS,
  JS_MAX_SAFE_INTEGER,
  LOGICAL_SKILL_ROOTS,
  LOGICAL_WORKSPACE_ROOT,
  PRINTABLE_ASCII_RE,
  READ_LIMIT_MAX,
  READ_LIMIT_MIN,
  READ_MAX_BYTES_FIXED,
  READ_OFFSET_MIN,
  READ_PATH_MAX_LEN,
  SHA256_HEX_RE,
  TOOL_CALL_ID_MAX_LEN,
  TRACE_ID_MAX_LEN,
} from './internal-files-read-constants.js';
import { fail } from './internal-sandbox-transport-error.js';

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} [maxLength]
 * @returns {string}
 */
export function requireBoundedAscii(value, field, maxLength = IDENTIFIER_MAX_LEN) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    !PRINTABLE_ASCII_RE.test(value)
  ) {
    fail(
      'FILES_READ_PAYLOAD_INVALID',
      `${field} must be a non-empty bounded printable ASCII string`,
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function requireStrictInt(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail(
      'FILES_READ_PAYLOAD_INVALID',
      `${field} must be a safe integer (no coercion)`,
    );
  }
  if (value < min || value > max) {
    fail('FILES_READ_PAYLOAD_INVALID', `${field} out of allowed range`);
  }
  return value;
}

/**
 * Path must already be Agent-canonical under /home/sandbox/workspace/<rel>.
 * @param {unknown} path
 * @returns {string}
 */
export function validateCanonicalPath(path, root, rootLabel) {
  if (typeof path !== 'string') {
    fail('FILES_READ_PATH', 'path must be a string');
  }
  if (!path || path.length > READ_PATH_MAX_LEN) {
    fail('FILES_READ_PATH', 'path empty or exceeds max length');
  }
  if (path.includes('\0')) fail('FILES_READ_PATH', 'path contains NUL');
  if (path.includes('\\')) fail('FILES_READ_PATH', 'backslash paths rejected');
  if (path.endsWith('/')) fail('FILES_READ_PATH', 'trailing slash rejected');
  if (path.includes('//')) fail('FILES_READ_PATH', 'double slash rejected');
  if (path !== path.trim()) {
    fail('FILES_READ_PATH', 'path must not have surrounding whitespace');
  }

  if (path === root || path === `${root}/`) {
    fail('FILES_READ_PATH', `${rootLabel} root is not a file path`);
  }
  const prefix = `${root}/`;
  if (!path.startsWith(prefix)) {
    fail(
      'FILES_READ_PATH',
      `path must be under ${root}/<relative>`,
    );
  }
  const relative = path.slice(prefix.length);
  if (!relative) fail('FILES_READ_PATH', 'path must include a file name');
  const parts = relative.split('/');
  for (const seg of parts) {
    if (!seg || seg === '.') {
      fail('FILES_READ_PATH', "empty or '.' path segment rejected");
    }
    if (seg === '..') fail('FILES_READ_PATH', 'parent traversal rejected');
    if (seg.includes('\\') || seg.includes('\0')) {
      fail('FILES_READ_PATH', 'invalid path segment');
    }
  }
  const canonical = `${root}/${parts.join('/')}`;
  if (canonical !== path) fail('FILES_READ_PATH', 'path is not canonical');
  return path;
}

export function validateCanonicalWorkspacePath(path) {
  return validateCanonicalPath(path, LOGICAL_WORKSPACE_ROOT, 'workspace');
}

/**
 * Accept either skill tier. Longest root wins so skill-user is not parsed as
 * a child of the system skill root.
 * @param {unknown} path
 * @returns {string}
 */
export function validateCanonicalSkillPath(path) {
  if (typeof path !== 'string') {
    fail('FILES_READ_PATH', 'path must be a string');
  }
  const roots = [...LOGICAL_SKILL_ROOTS].sort((a, b) => b.length - a.length);
  for (const root of roots) {
    if (path === root || path.startsWith(`${root}/`)) {
      return validateCanonicalPath(path, root, 'skill');
    }
  }
  fail(
    'FILES_READ_PATH',
    `path must be under one of ${LOGICAL_SKILL_ROOTS.join(', ')}`,
  );
}

/**
 * Strict payload validation; model/extra fields cannot override identity/claim.
 * Rebuilds an authoritative body object (exact key set + order).
 *
 * @param {unknown} payload
 * @returns {{
 *   path: string,
 *   offset: number,
 *   limit: number,
 *   maxBytes: number,
 *   identity: {
 *     orgId: string,
 *     userId: string,
 *     conversationId: string,
 *     agentSessionId: string,
 *     runId: string,
 *     sandboxSessionId: string,
 *     traceId: string,
 *     executionFenceToken: number,
 *   },
 *   toolExecutionId: string,
 *   toolCallId: string,
 *   requestHash: string,
 *   requestHashVersion: number,
 * }}
 */
export function validateAndNormalizeReadPayload(payload, validatePath) {
  if (!isPlainObject(payload)) {
    fail('FILES_READ_PAYLOAD_INVALID', 'payload must be a plain object');
  }
  const p = /** @type {Record<string, unknown>} */ (payload);

  // Claim / identity first so model path/offset cannot shadow them later.
  if (!isPlainObject(p.identity)) {
    fail('FILES_READ_PAYLOAD_INVALID', 'identity must be a plain object');
  }
  const idIn = /** @type {Record<string, unknown>} */ (p.identity);

  const identity = {
    orgId: requireBoundedAscii(idIn.orgId, 'identity.orgId'),
    userId: requireBoundedAscii(idIn.userId, 'identity.userId'),
    conversationId: requireBoundedAscii(
      idIn.conversationId,
      'identity.conversationId',
    ),
    agentSessionId: requireBoundedAscii(
      idIn.agentSessionId,
      'identity.agentSessionId',
    ),
    runId: requireBoundedAscii(idIn.runId, 'identity.runId'),
    sandboxSessionId: requireBoundedAscii(
      idIn.sandboxSessionId,
      'identity.sandboxSessionId',
    ),
    traceId: requireBoundedAscii(
      idIn.traceId,
      'identity.traceId',
      TRACE_ID_MAX_LEN,
    ),
    executionFenceToken: requireStrictInt(
      idIn.executionFenceToken,
      'identity.executionFenceToken',
      1,
      JS_MAX_SAFE_INTEGER,
    ),
  };

  let toolExecutionId;
  try {
    toolExecutionId = assertUlid(p.toolExecutionId, 'toolExecutionId');
  } catch {
    fail('FILES_READ_PAYLOAD_INVALID', 'toolExecutionId must be a formal ULID');
  }
  const toolCallId = requireBoundedAscii(
    p.toolCallId,
    'toolCallId',
    TOOL_CALL_ID_MAX_LEN,
  );
  if (typeof p.requestHash !== 'string' || !SHA256_HEX_RE.test(p.requestHash)) {
    fail(
      'FILES_READ_PAYLOAD_INVALID',
      'requestHash must be 64 lowercase hex characters',
    );
  }
  const requestHash = p.requestHash;
  const requestHashVersion = requireStrictInt(
    p.requestHashVersion,
    'requestHashVersion',
    1,
    1,
  );

  const path = validatePath(p.path);
  const offset = requireStrictInt(
    p.offset,
    'offset',
    READ_OFFSET_MIN,
    JS_MAX_SAFE_INTEGER,
  );
  const limit = requireStrictInt(
    p.limit,
    'limit',
    READ_LIMIT_MIN,
    READ_LIMIT_MAX,
  );
  const maxBytes = requireStrictInt(
    p.maxBytes,
    'maxBytes',
    READ_MAX_BYTES_FIXED,
    READ_MAX_BYTES_FIXED,
  );

  // Recompute request-hash from semantic args (Python contract parity).
  let computed;
  try {
    computed = computeToolRequestHashV1({
      toolName: FILES_READ_TOOL_NAME,
      args: { path, offset, limit, maxBytes },
    });
  } catch (err) {
    fail(
      'FILES_READ_HASH',
      err instanceof Error ? err.message : 'request-hash computation failed',
    );
  }
  if (
    computed.requestHashVersion !== 1 ||
    computed.requestHash !== requestHash
  ) {
    fail('FILES_READ_HASH', 'requestHash does not match recomputed hash');
  }

  return {
    path,
    offset,
    limit,
    maxBytes,
    identity,
    toolExecutionId,
    toolCallId,
    requestHash,
    requestHashVersion,
  };
}

export function validateAndNormalizeReadFilePayload(payload) {
  return validateAndNormalizeReadPayload(payload, validateCanonicalWorkspacePath);
}

export function validateAndNormalizeReadSkillPayload(payload) {
  return validateAndNormalizeReadPayload(payload, validateCanonicalSkillPath);
}

/**
 * Build exact raw body bytes (compact JSON, deterministic key order).
 * Same bytes are used for body_sha256 and the HTTP body.
 *
 * @param {unknown} payload
 * @returns {{ bodyBytes: Buffer, bodySha256: string, normalized: ReturnType<typeof validateAndNormalizeReadFilePayload> }}
 */
export function buildReadBodyBytes(payload, validatePayload) {
  const normalized = validatePayload(payload);
  // Exact root key order matching Python contract tests / wire shape.
  const bodyObj = {
    path: normalized.path,
    offset: normalized.offset,
    limit: normalized.limit,
    maxBytes: normalized.maxBytes,
    identity: {
      orgId: normalized.identity.orgId,
      userId: normalized.identity.userId,
      conversationId: normalized.identity.conversationId,
      agentSessionId: normalized.identity.agentSessionId,
      runId: normalized.identity.runId,
      sandboxSessionId: normalized.identity.sandboxSessionId,
      traceId: normalized.identity.traceId,
      executionFenceToken: normalized.identity.executionFenceToken,
    },
    toolExecutionId: normalized.toolExecutionId,
    toolCallId: normalized.toolCallId,
    requestHash: normalized.requestHash,
    requestHashVersion: normalized.requestHashVersion,
  };
  // Defense: only expected keys.
  for (const key of Object.keys(bodyObj)) {
    if (!BODY_ROOT_KEYS.includes(key)) {
      fail('FILES_READ_SCHEMA', 'unexpected body key');
    }
  }
  for (const key of Object.keys(bodyObj.identity)) {
    if (!IDENTITY_KEYS.includes(key)) {
      fail('FILES_READ_SCHEMA', 'unexpected identity key');
    }
  }
  const bodyBytes = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const bodySha256 = createHash('sha256').update(bodyBytes).digest('hex');
  return { bodyBytes, bodySha256, normalized };
}

export function buildFilesReadBodyBytes(payload) {
  return buildReadBodyBytes(payload, validateAndNormalizeReadFilePayload);
}

export function buildSkillsReadBodyBytes(payload) {
  return buildReadBodyBytes(payload, validateAndNormalizeReadSkillPayload);
}
