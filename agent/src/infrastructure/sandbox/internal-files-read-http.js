/**
 * Agent → Sandbox internal HTTP transport for POST /internal/v1/files/read.
 *
 * Explicit injection only (base URL, HMAC keyring/active kid or tokenIssuer,
 * fetch, clock, jti/randomBytes, timeouts, maxAttempts). Offline-testable.
 * Not wired into production bootstrap/worker in this batch — no silent
 * fallback to legacy browser-Bearer sandbox-client.
 *
 * Contract: body keys/shape match Python files_read_contract; exact raw
 * body bytes are used for body_sha256 and the fetch body; claims match
 * the Python internal verifier (POST, htu, tool=read, scope).
 */

import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';

import {
  issueInternalToken,
  validateInternalHmacKeyring,
} from './internal-hmac.js';
import { computeToolRequestHashV1 } from '../../domain/tool/tool-request-hash.js';
import { assertUlid } from '../../domain/shared/ulid.js';

export const FILES_READ_HTU = '/internal/v1/files/read';
export const FILES_READ_TOOL_NAME = 'read';
export const FILES_READ_SCOPE = 'sandbox.files.read';
export const READ_MAX_BYTES_FIXED = 262_144;
export const READ_LIMIT_MIN = 1;
export const READ_LIMIT_MAX = 50_000;
export const READ_OFFSET_MIN = 0;
export const READ_PATH_MAX_LEN = 512;
export const IDENTIFIER_MAX_LEN = 255;
export const TOOL_CALL_ID_MAX_LEN = 255;
export const TRACE_ID_MAX_LEN = 255;

/** Default: single attempt (no automatic retry). Tests may raise. */
export const DEFAULT_MAX_ATTEMPTS = 1;
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
/** Hard cap on response body (success content ≤ 256KiB + JSON overhead). */
export const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
/** Safe transport-layer retries only (never business 4xx / 409 ledger). */
export const DEFAULT_RETRYABLE_HTTP_STATUSES = Object.freeze([502, 503, 504]);

export const LOGICAL_WORKSPACE_ROOT = '/home/sandbox/workspace';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;
const JS_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

/** Terminal / ledger codes that must never be remapped or auto-retried. */
export const PRESERVED_SANDBOX_ERROR_CODES = Object.freeze([
  'IN_PROGRESS',
  'TOOL_OUTCOME_UNKNOWN',
  'CANCELLED',
]);

const SUCCESS_TEXT_KEYS = Object.freeze([
  'path',
  'binary',
  'content',
  'truncated',
  'offset',
  'limit',
  'size',
  'returnedLines',
  'nextOffset',
  'mimeType',
]);

const SUCCESS_BINARY_KEYS = Object.freeze([
  'path',
  'binary',
  'size',
  'mimeType',
]);

const BODY_ROOT_KEYS = Object.freeze([
  'path',
  'offset',
  'limit',
  'maxBytes',
  'identity',
  'toolExecutionId',
  'toolCallId',
  'requestHash',
  'requestHashVersion',
]);

const IDENTITY_KEYS = Object.freeze([
  'orgId',
  'userId',
  'conversationId',
  'agentSessionId',
  'runId',
  'sandboxSessionId',
  'traceId',
  'executionFenceToken',
]);

/**
 * Stable marker key on tool result details / transport errors.
 * Observability only treats exact `outcomeUnknown: true` + code as UNKNOWN.
 */
export const OUTCOME_UNKNOWN_MARKER_KEY = 'outcomeUnknown';

/**
 * Typed transport error with stable `.code` for mapTransportError / callers.
 * When `outcomeUnknown === true`, ledger must record TOOL_OUTCOME_UNKNOWN
 * (never ordinary FAILED/CANCELLED) — Sandbox may still complete the claim.
 */
export class InternalSandboxTransportError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{
   *   httpStatus?: number,
   *   retryable?: boolean,
   *   outcomeUnknown?: boolean,
   * }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'InternalSandboxTransportError';
    this.code = code;
    if (extra.httpStatus != null) this.httpStatus = extra.httpStatus;
    if (extra.retryable != null) this.retryable = extra.retryable;
    // Strict boolean only — never truthy coercion from strings.
    if (extra.outcomeUnknown === true) {
      this.outcomeUnknown = true;
    }
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {{
 *   httpStatus?: number,
 *   retryable?: boolean,
 *   outcomeUnknown?: boolean,
 * }} [extra]
 * @returns {never}
 */
function fail(code, message, extra) {
  throw new InternalSandboxTransportError(code, message, extra);
}

/**
 * Ambiguous post-dispatch outcome: never retry; never map to ordinary
 * CANCELLED/FAILED/TIMEOUT for ledger solidification.
 *
 * @param {string} message
 * @param {{ httpStatus?: number }} [extra]
 * @returns {never}
 */
function failOutcomeUnknown(message, extra = {}) {
  throw new InternalSandboxTransportError(
    'TOOL_OUTCOME_UNKNOWN',
    message,
    {
      ...extra,
      outcomeUnknown: true,
      retryable: false,
    },
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
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
function requireBoundedAscii(value, field, maxLength = IDENTIFIER_MAX_LEN) {
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
function requireStrictInt(value, field, min, max) {
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
function validateCanonicalWorkspacePath(path) {
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

  const root = LOGICAL_WORKSPACE_ROOT;
  if (path === root || path === `${root}/`) {
    fail('FILES_READ_PATH', 'workspace root is not a file path');
  }
  const prefix = `${root}/`;
  if (!path.startsWith(prefix)) {
    fail(
      'FILES_READ_PATH',
      'path must be under /home/sandbox/workspace/<relative>',
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
export function validateAndNormalizeReadFilePayload(payload) {
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

  const path = validateCanonicalWorkspacePath(p.path);
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

/**
 * Build exact raw body bytes (compact JSON, deterministic key order).
 * Same bytes are used for body_sha256 and the HTTP body.
 *
 * @param {unknown} payload
 * @returns {{ bodyBytes: Buffer, bodySha256: string, normalized: ReturnType<typeof validateAndNormalizeReadFilePayload> }}
 */
export function buildFilesReadBodyBytes(payload) {
  const normalized = validateAndNormalizeReadFilePayload(payload);
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

/**
 * @param {unknown} raw
 * @param {{ path: string, offset: number, limit: number, maxBytes: number }} command
 * @returns {Record<string, unknown>}
 */
export function filterFilesReadSuccessResult(raw, command) {
  if (!isPlainObject(raw)) {
    fail('SANDBOX_RESPONSE_INVALID', 'success result must be a JSON object');
  }
  const binary = raw.binary;
  if (binary === true) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of SUCCESS_BINARY_KEYS) {
      if (!(k in raw)) {
        fail('SANDBOX_RESPONSE_INVALID', `missing binary result field ${k}`);
      }
      out[k] = raw[k];
    }
    if (typeof out.path !== 'string' || out.path !== command.path) {
      fail('SANDBOX_RESPONSE_INVALID', 'binary path must equal request path');
    }
    if (
      typeof out.size !== 'number' ||
      !Number.isSafeInteger(out.size) ||
      out.size < 0
    ) {
      fail('SANDBOX_RESPONSE_INVALID', 'binary size invalid');
    }
    if (typeof out.mimeType !== 'string') {
      fail('SANDBOX_RESPONSE_INVALID', 'binary mimeType invalid');
    }
    return out;
  }
  if (binary === false) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of SUCCESS_TEXT_KEYS) {
      if (!(k in raw)) {
        fail('SANDBOX_RESPONSE_INVALID', `missing text result field ${k}`);
      }
      out[k] = raw[k];
    }
    if (typeof out.path !== 'string' || out.path !== command.path) {
      fail('SANDBOX_RESPONSE_INVALID', 'text path must equal request path');
    }
    if (typeof out.content !== 'string') {
      fail('SANDBOX_RESPONSE_INVALID', 'text content invalid');
    }
    if (typeof out.truncated !== 'boolean') {
      fail('SANDBOX_RESPONSE_INVALID', 'text truncated invalid');
    }
    if (
      typeof out.offset !== 'number' ||
      !Number.isSafeInteger(out.offset) ||
      out.offset !== command.offset
    ) {
      fail('SANDBOX_RESPONSE_INVALID', 'text offset must equal request offset');
    }
    if (
      typeof out.limit !== 'number' ||
      !Number.isSafeInteger(out.limit) ||
      out.limit !== command.limit
    ) {
      fail('SANDBOX_RESPONSE_INVALID', 'text limit must equal request limit');
    }
    if (
      typeof out.size !== 'number' ||
      !Number.isSafeInteger(out.size) ||
      out.size < 0
    ) {
      fail('SANDBOX_RESPONSE_INVALID', 'text size invalid');
    }
    if (
      typeof out.returnedLines !== 'number' ||
      !Number.isSafeInteger(out.returnedLines) ||
      out.returnedLines < 0 ||
      out.returnedLines > command.limit
    ) {
      fail('SANDBOX_RESPONSE_INVALID', 'text returnedLines out of range');
    }
    const no = out.nextOffset;
    if (no !== null) {
      if (
        typeof no !== 'number' ||
        !Number.isSafeInteger(no) ||
        no < command.offset
      ) {
        fail('SANDBOX_RESPONSE_INVALID', 'text nextOffset invalid');
      }
    }
    if (typeof out.mimeType !== 'string') {
      fail('SANDBOX_RESPONSE_INVALID', 'text mimeType invalid');
    }
    let contentBytes;
    try {
      contentBytes = Buffer.byteLength(/** @type {string} */ (out.content), 'utf8');
    } catch {
      fail('SANDBOX_RESPONSE_INVALID', 'text content is not UTF-8 encodable');
    }
    if (contentBytes > command.maxBytes) {
      fail('SANDBOX_RESPONSE_INVALID', 'text content exceeds maxBytes');
    }
    return out;
  }
  fail('SANDBOX_RESPONSE_INVALID', 'result binary flag must be strict bool');
}

/**
 * Literal loopback hostnames only — no DNS/CIDR invention.
 * @param {string} hostname
 * @returns {boolean}
 */
function isLiteralLoopbackHostname(hostname) {
  const h = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/**
 * @param {string} baseUrl
 * @param {{ allowInsecureHttp?: boolean }} [opts]
 * @returns {string}
 */
export function normalizeBaseUrl(baseUrl, opts = {}) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    fail('SANDBOX_TRANSPORT_CONFIG', 'baseUrl is required');
  }
  const allowInsecureHttp = opts.allowInsecureHttp === true;
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(trimmed)) {
    fail('SANDBOX_TRANSPORT_CONFIG', 'baseUrl must be an absolute http(s) URL');
  }
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    fail('SANDBOX_TRANSPORT_CONFIG', 'baseUrl is not a valid URL');
  }
  if (u.username || u.password) {
    fail('SANDBOX_TRANSPORT_CONFIG', 'baseUrl must not embed credentials');
  }
  if (u.search || u.hash) {
    fail('SANDBOX_TRANSPORT_CONFIG', 'baseUrl must not include query/hash');
  }
  if (u.protocol === 'https:') {
    return trimmed;
  }
  if (u.protocol === 'http:') {
    // Default: only literal loopback over http. External/plain http requires
    // explicit allowInsecureHttp (dev/controlled). No CIDR/DNS policy here —
    // production config will tighten further.
    if (allowInsecureHttp || isLiteralLoopbackHostname(u.hostname)) {
      return trimmed;
    }
    fail(
      'SANDBOX_TRANSPORT_CONFIG',
      'http baseUrl rejected unless loopback or allowInsecureHttp=true',
    );
  }
  fail('SANDBOX_TRANSPORT_CONFIG', 'baseUrl scheme must be http or https');
}

/**
 * Extract and validate compact JWT payload `.jti` without trusting arbitrary
 * token text (bounded, canonical base64url, plain JSON object).
 *
 * @param {unknown} token
 * @returns {string}
 */
export function extractCompactJwtPayloadJti(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 16 * 1024) {
    fail('SANDBOX_TOKEN_INVALID', 'token must be a bounded string');
  }
  const segments = token.split('.');
  if (
    segments.length !== 3 ||
    segments.some((p) => !p || !/^[A-Za-z0-9_-]+$/.test(p))
  ) {
    fail('SANDBOX_TOKEN_INVALID', 'token must be compact JWT with three segments');
  }
  // Reject padded / non-canonical base64url.
  let payloadBytes;
  try {
    payloadBytes = Buffer.from(segments[1], 'base64url');
  } catch {
    fail('SANDBOX_TOKEN_INVALID', 'token payload is not base64url');
  }
  if (payloadBytes.toString('base64url') !== segments[1]) {
    fail('SANDBOX_TOKEN_INVALID', 'token payload must be canonical base64url');
  }
  if (payloadBytes.length === 0 || payloadBytes.length > 8 * 1024) {
    fail('SANDBOX_TOKEN_INVALID', 'token payload size out of bounds');
  }
  let claims;
  try {
    claims = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    fail('SANDBOX_TOKEN_INVALID', 'token payload is not JSON');
  }
  if (!isPlainObject(claims) || typeof claims.jti !== 'string' || !claims.jti) {
    fail('SANDBOX_TOKEN_INVALID', 'token payload.jti missing or invalid');
  }
  // jti must itself be canonical 16-byte base64url (matches issueInternalToken).
  const jtiBytes = Buffer.from(claims.jti, 'base64url');
  if (jtiBytes.length !== 16 || jtiBytes.toString('base64url') !== claims.jti) {
    fail('SANDBOX_TOKEN_INVALID', 'token payload.jti must be 16-byte base64url');
  }
  return claims.jti;
}

/**
 * @param {Buffer} bytes
 * @returns {unknown}
 */
function parseJsonObjectFailClosed(bytes) {
  let text;
  try {
    text = bytes.toString('utf8');
  } catch {
    fail('SANDBOX_RESPONSE_INVALID', 'response is not valid UTF-8');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('SANDBOX_RESPONSE_INVALID', 'response is not valid JSON');
  }
  if (!isPlainObject(value)) {
    fail('SANDBOX_RESPONSE_INVALID', 'response root must be a JSON object');
  }
  return value;
}

/**
 * Extract stable typed error code from Sandbox error shapes without leaking
 * raw body text into the error message.
 *
 * @param {unknown} parsed
 * @param {number} status
 * @returns {{ code: string, message: string }}
 */
function extractErrorCode(parsed, status) {
  if (isPlainObject(parsed)) {
    // JSONResponse envelope: { error: { code, message } }
    const err = parsed.error;
    if (isPlainObject(err) && typeof err.code === 'string' && err.code) {
      const msg =
        typeof err.message === 'string' && err.message
          ? err.message.slice(0, 512)
          : 'sandbox tool error';
      return { code: err.code, message: sanitizePublicMessage(msg) };
    }
    // FastAPI HTTPException: { detail: { code, message } } or detail string
    const detail = parsed.detail;
    if (isPlainObject(detail) && typeof detail.code === 'string' && detail.code) {
      const msg =
        typeof detail.message === 'string' && detail.message
          ? detail.message.slice(0, 512)
          : 'sandbox tool error';
      return { code: detail.code, message: sanitizePublicMessage(msg) };
    }
    if (typeof detail === 'string' && detail) {
      return {
        code: statusToGenericCode(status),
        message: sanitizePublicMessage(detail.slice(0, 512)),
      };
    }
  }
  return {
    code: statusToGenericCode(status),
    message: 'sandbox request failed',
  };
}

/**
 * @param {string} msg
 * @returns {string}
 */
function sanitizePublicMessage(msg) {
  return msg
    .replace(/\/Users\/[^\s]+/g, '[redacted-path]')
    .replace(/\/var\/[^\s]+/g, '[redacted-path]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
    .slice(0, 512);
}

/**
 * @param {number} status
 * @returns {string}
 */
function statusToGenericCode(status) {
  if (status === 401 || status === 403) return 'SANDBOX_AUTH_FAILED';
  if (status === 404) return 'SANDBOX_NOT_FOUND';
  if (status === 408 || status === 504) return 'SANDBOX_TIMEOUT';
  if (status === 409) return 'SANDBOX_CONFLICT';
  if (status === 413) return 'SANDBOX_PAYLOAD_TOO_LARGE';
  if (status === 502 || status === 503) return 'SANDBOX_UNAVAILABLE';
  if (status >= 500) return 'SANDBOX_ERROR';
  if (status >= 400) return 'SANDBOX_REQUEST_REJECTED';
  return 'SANDBOX_ERROR';
}

/**
 * @param {string | null} contentType
 * @returns {boolean}
 */
function isJsonContentType(contentType) {
  if (typeof contentType !== 'string' || !contentType) return false;
  const base = contentType.split(';')[0].trim().toLowerCase();
  return base === 'application/json';
}

/**
 * Bound response body size (stream when available).
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readResponseBodyLimited(response, maxBytes) {
  const cl = response.headers?.get?.('content-length');
  if (cl != null && cl !== '') {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) {
      fail('SANDBOX_RESPONSE_TOO_LARGE', 'response exceeds size limit', {
        httpStatus: response.status,
      });
    }
  }

  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          fail('SANDBOX_RESPONSE_TOO_LARGE', 'response exceeds size limit', {
            httpStatus: response.status,
          });
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof InternalSandboxTransportError) throw err;
      fail('SANDBOX_TRANSPORT_ERROR', 'failed to read response body', {
        retryable: true,
      });
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }

  let ab;
  try {
    ab = await response.arrayBuffer();
  } catch {
    fail('SANDBOX_TRANSPORT_ERROR', 'failed to read response body', {
      retryable: true,
    });
  }
  if (ab.byteLength > maxBytes) {
    fail('SANDBOX_RESPONSE_TOO_LARGE', 'response exceeds size limit', {
      httpStatus: response.status,
    });
  }
  return Buffer.from(ab);
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbortError(err) {
  if (!err || typeof err !== 'object') return false;
  const name = /** @type {any} */ (err).name;
  const code = /** @type {any} */ (err).code;
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'ABORT_ERR' ||
    code === 'SANDBOX_TIMEOUT' ||
    code === 'SANDBOX_CANCELLED'
  );
}

/**
 * Network / fetch failures that may be retried when maxAttempts > 1.
 * @param {unknown} err
 * @returns {boolean}
 */
function isRetryableTransportFailure(err) {
  if (err instanceof InternalSandboxTransportError) {
    return err.retryable === true;
  }
  if (!err || typeof err !== 'object') return false;
  if (isAbortError(err)) return false;
  const code = /** @type {any} */ (err).code;
  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return true;
  }
  // undici / node fetch TypeError: fetch failed
  if (
    /** @type {any} */ (err).name === 'TypeError' &&
    typeof /** @type {any} */ (err).message === 'string' &&
    /fetch failed|network/i.test(/** @type {any} */ (err).message)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {{
 *   baseUrl: string,
 *   allowInsecureHttp?: boolean,
 *   keyring?: object|string,
 *   activeKid?: string,
 *   tokenIssuer?: (
 *     claims: object,
 *     meta: {
 *       bodyBytes: Buffer,
 *       bodySha256: string,
 *       expectedJti: string,
 *       attempt: number,
 *       jtiBytes: Uint8Array,
 *     },
 *   ) => string | Promise<string>,
 *   fetchImpl?: typeof fetch,
 *   clock?: () => number,
 *   randomBytes?: (size: number) => Uint8Array,
 *   jtiFactory?: () => string,
 *   attemptTimeoutMs?: number,
 *   totalTimeoutMs?: number,
 *   maxAttempts?: number,
 *   retryableHttpStatuses?: readonly number[],
 *   maxResponseBytes?: number,
 *   ttlSeconds?: number,
 *   signal?: AbortSignal,
 * }} options
 */
export function createInternalFilesReadTransport(options) {
  if (!options || typeof options !== 'object') {
    fail('SANDBOX_TRANSPORT_CONFIG', 'options object is required');
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl, {
    allowInsecureHttp: options.allowInsecureHttp === true,
  });
  const url = `${baseUrl}${FILES_READ_HTU}`;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    fail('SANDBOX_TRANSPORT_CONFIG', 'fetchImpl must be a function');
  }

  const clock =
    options.clock ?? (() => Math.floor(Date.now() / 1000));
  if (typeof clock !== 'function') {
    fail('SANDBOX_TRANSPORT_CONFIG', 'clock must be a function');
  }

  const attemptTimeoutMs =
    options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const retryableHttpStatuses = new Set(
    options.retryableHttpStatuses ?? DEFAULT_RETRYABLE_HTTP_STATUSES,
  );

  for (const [name, value] of [
    ['attemptTimeoutMs', attemptTimeoutMs],
    ['totalTimeoutMs', totalTimeoutMs],
    ['maxAttempts', maxAttempts],
    ['maxResponseBytes', maxResponseBytes],
  ]) {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value <= 0
    ) {
      fail('SANDBOX_TRANSPORT_CONFIG', `${name} must be a positive safe integer`);
    }
  }
  if (maxAttempts > 5) {
    fail('SANDBOX_TRANSPORT_CONFIG', 'maxAttempts must be <= 5');
  }

  const tokenIssuer = options.tokenIssuer;
  const hasIssuer = typeof tokenIssuer === 'function';
  let keyring = options.keyring;
  let activeKid = options.activeKid;

  if (!hasIssuer) {
    if (keyring == null || activeKid == null) {
      fail(
        'SANDBOX_TRANSPORT_CONFIG',
        'keyring+activeKid or tokenIssuer is required',
      );
    }
    // Validate keyring early (no silent unknown-kid).
    validateInternalHmacKeyring(keyring, activeKid);
  }

  /**
   * Optional jti injection: jtiFactory returns base64url string, or randomBytes(16).
   * Transport always generates a fresh 16-byte jti per attempt (never reused).
   */
  const randomBytes =
    options.randomBytes ??
    (typeof options.jtiFactory === 'function'
      ? (size) => {
          if (size !== 16) {
            fail('SANDBOX_TRANSPORT_CONFIG', 'jti requires 16 random bytes');
          }
          const jti = options.jtiFactory();
          if (typeof jti !== 'string' || !jti) {
            fail('SANDBOX_TRANSPORT_CONFIG', 'jtiFactory must return a string');
          }
          const buf = Buffer.from(jti, 'base64url');
          if (buf.length !== 16 || buf.toString('base64url') !== jti) {
            fail(
              'SANDBOX_TRANSPORT_CONFIG',
              'jtiFactory must return canonical 16-byte base64url',
            );
          }
          return new Uint8Array(buf);
        }
      : cryptoRandomBytes);

  const externalSignal = options.signal;

  /**
   * @param {ReturnType<typeof validateAndNormalizeReadFilePayload>} normalized
   * @param {string} bodySha256
   * @param {Buffer} bodyBytes
   * @param {number} attempt
   * @returns {Promise<string>}
   */
  async function issueToken(normalized, bodySha256, bodyBytes, attempt) {
    const jtiRaw = randomBytes(16);
    if (!(jtiRaw instanceof Uint8Array) || jtiRaw.byteLength !== 16) {
      fail(
        'SANDBOX_TRANSPORT_CONFIG',
        'randomBytes must return exactly 16 bytes for jti',
      );
    }
    const expectedJti = Buffer.from(jtiRaw).toString('base64url');

    const issueClaims = {
      org_id: normalized.identity.orgId,
      user_id: normalized.identity.userId,
      conversation_id: normalized.identity.conversationId,
      agent_session_id: normalized.identity.agentSessionId,
      sandbox_session_id: normalized.identity.sandboxSessionId,
      run_id: normalized.identity.runId,
      tool_execution_id: normalized.toolExecutionId,
      tool_call_id: normalized.toolCallId,
      tool_name: FILES_READ_TOOL_NAME,
      scope: [FILES_READ_SCOPE],
      request_hash: normalized.requestHash,
      execution_fence_token: normalized.identity.executionFenceToken,
      trace_id: normalized.identity.traceId,
      htm: 'POST',
      htu: FILES_READ_HTU,
      body_sha256: bodySha256,
    };

    if (hasIssuer) {
      const token = await tokenIssuer(issueClaims, {
        bodyBytes,
        bodySha256,
        expectedJti,
        attempt,
        jtiBytes: jtiRaw,
      });
      // Fail closed before any network send if issuer reuses jti / ignores expectedJti.
      const actualJti = extractCompactJwtPayloadJti(token);
      if (actualJti !== expectedJti) {
        fail(
          'SANDBOX_TOKEN_JTI_MISMATCH',
          'tokenIssuer must embed transport-generated expectedJti',
        );
      }
      return token;
    }

    return issueInternalToken({
      keyring,
      activeKid,
      claims: issueClaims,
      clock,
      randomBytes: () => jtiRaw,
      ttlSeconds: options.ttlSeconds,
    });
  }

  /**
   * @param {unknown} payload
   * @returns {Promise<Record<string, unknown>>}
   */
  async function readFile(payload) {
    // Body + hash fixed for the entire readFile call (including retries).
    const { bodyBytes, bodySha256, normalized } =
      buildFilesReadBodyBytes(payload);

    if (externalSignal?.aborted) {
      fail('SANDBOX_CANCELLED', 'request was cancelled before send', {
        retryable: false,
      });
    }

    const deadlineMs = Date.now() + totalTimeoutMs;
    let lastRetryableError = /** @type {Error | null} */ (null);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        fail('SANDBOX_TIMEOUT', 'total timeout exceeded', { retryable: false });
      }
      const thisTimeout = Math.min(attemptTimeoutMs, remainingMs);

      const controller = new AbortController();
      /** @type {(() => void) | null} */
      let onExternalAbort = null;
      if (externalSignal) {
        if (externalSignal.aborted) {
          // Still pre-send for this attempt.
          fail('SANDBOX_CANCELLED', 'request was cancelled before send', {
            retryable: false,
          });
        }
        onExternalAbort = () => {
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
        };
        externalSignal.addEventListener('abort', onExternalAbort, {
          once: true,
        });
      }
      const timer = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      }, thisTimeout);

      /**
       * true once fetch has been invoked. Ambiguous outcomes after this
       * must be TOOL_OUTCOME_UNKNOWN (supervisor may still complete).
       * Connect-level failures are treated as not-delivered for retry only.
       */
      let requestDispatched = false;
      /** true once HTTP response headers/status are observed. */
      let responseReceived = false;

      try {
        // New short-lived token + jti every network attempt (before send).
        const token = await issueToken(
          normalized,
          bodySha256,
          bodyBytes,
          attempt,
        );

        const headers = {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        };
        // Single Authorization only — never X-API-Key / browser bearer.

        requestDispatched = true;
        let response;
        try {
          response = await fetchImpl(url, {
            method: 'POST',
            headers,
            body: bodyBytes,
            signal: controller.signal,
          });
        } catch (fetchErr) {
          // Never auto-retry aborts/timeouts after dispatch.
          if (isAbortError(fetchErr)) {
            // External cancel after dispatch is still UNKNOWN (server may run).
            failOutcomeUnknown(
              externalSignal?.aborted
                ? 'request cancelled after dispatch; outcome unknown'
                : 'request timed out after dispatch; outcome unknown',
            );
          }
          // Clear connect failures: request never reached peer application.
          if (
            isConnectLevelFailure(fetchErr) &&
            attempt < maxAttempts &&
            Date.now() < deadlineMs
          ) {
            lastRetryableError = new InternalSandboxTransportError(
              'SANDBOX_TRANSPORT_ERROR',
              'connect-level transport failure',
              { retryable: true },
            );
            continue;
          }
          if (isConnectLevelFailure(fetchErr)) {
            fail('SANDBOX_TRANSPORT_ERROR', 'sandbox transport failure', {
              retryable: false,
            });
          }
          // Ambiguous mid-flight network error after dispatch → UNKNOWN.
          failOutcomeUnknown(
            'network error after dispatch; outcome unknown',
          );
        }

        responseReceived = true;
        // HTTP response received — business/ledger outcomes are never retried.
        const status = response.status;
        const contentType = response.headers?.get?.('content-type') ?? null;

        let respBytes;
        try {
          respBytes = await readResponseBodyLimited(
            response,
            maxResponseBytes,
          );
        } catch (bodyErr) {
          if (
            bodyErr instanceof InternalSandboxTransportError &&
            bodyErr.code === 'SANDBOX_RESPONSE_TOO_LARGE'
          ) {
            throw bodyErr;
          }
          // Body read interrupted after headers: Sandbox may still finalize.
          failOutcomeUnknown(
            'response body read interrupted; outcome unknown',
          );
        }

        if (status === 200) {
          if (!isJsonContentType(contentType)) {
            fail(
              'SANDBOX_RESPONSE_INVALID',
              'success response Content-Type must be application/json',
              { httpStatus: 200 },
            );
          }
          const parsed = parseJsonObjectFailClosed(respBytes);
          return filterFilesReadSuccessResult(parsed, {
            path: normalized.path,
            offset: normalized.offset,
            limit: normalized.limit,
            maxBytes: normalized.maxBytes,
          });
        }

        // Retry only explicit gateway statuses before parsing as final error.
        if (
          retryableHttpStatuses.has(status) &&
          attempt < maxAttempts &&
          Date.now() < deadlineMs
        ) {
          lastRetryableError = new InternalSandboxTransportError(
            statusToGenericCode(status),
            'sandbox temporarily unavailable',
            { httpStatus: status, retryable: true },
          );
          continue;
        }

        // Parse typed error (IN_PROGRESS / TOOL_OUTCOME_UNKNOWN / CANCELLED / …).
        let parsedErr = null;
        if (respBytes.length > 0 && isJsonContentType(contentType)) {
          try {
            parsedErr = parseJsonObjectFailClosed(respBytes);
          } catch {
            parsedErr = null;
          }
        } else if (respBytes.length > 0) {
          // Non-JSON error body: fail closed without leaking body text.
          fail(statusToGenericCode(status), 'sandbox request failed', {
            httpStatus: status,
            retryable: false,
          });
        }

        const { code, message } = extractErrorCode(parsedErr, status);
        // Sandbox 409 TOOL_OUTCOME_UNKNOWN must carry the same marker.
        if (code === 'TOOL_OUTCOME_UNKNOWN') {
          failOutcomeUnknown(message, { httpStatus: status });
        }
        fail(code, message, {
          httpStatus: status,
          retryable: false,
        });
      } catch (err) {
        if (err instanceof InternalSandboxTransportError) {
          // Outcome-unknown and other non-retryable codes always surface.
          if (err.outcomeUnknown === true || !err.retryable || attempt >= maxAttempts) {
            throw err;
          }
          if (Date.now() >= deadlineMs) {
            // Total budget exhausted between safe retries only.
            fail('SANDBOX_TIMEOUT', 'total timeout exceeded', {
              retryable: false,
            });
          }
          lastRetryableError = err;
          continue;
        }

        // Unexpected throw after response headers → UNKNOWN (conservative).
        if (responseReceived || requestDispatched) {
          failOutcomeUnknown(
            'unexpected failure after dispatch; outcome unknown',
          );
        }

        if (isAbortError(err)) {
          // Pre-dispatch abort (token issue / setup) — only if not dispatched.
          if (externalSignal?.aborted) {
            fail('SANDBOX_CANCELLED', 'request was cancelled before send', {
              retryable: false,
            });
          }
          fail('SANDBOX_TIMEOUT', 'request timed out before send', {
            retryable: false,
          });
        }

        if (
          isRetryableTransportFailure(err) &&
          attempt < maxAttempts &&
          Date.now() < deadlineMs &&
          !requestDispatched
        ) {
          lastRetryableError =
            err instanceof Error
              ? err
              : new InternalSandboxTransportError(
                  'SANDBOX_TRANSPORT_ERROR',
                  'transport failure',
                  { retryable: true },
                );
          continue;
        }

        fail(
          'SANDBOX_TRANSPORT_ERROR',
          'sandbox transport failure',
          { retryable: false },
        );
      } finally {
        clearTimeout(timer);
        if (onExternalAbort && externalSignal) {
          externalSignal.removeEventListener('abort', onExternalAbort);
        }
      }
    }

    if (lastRetryableError instanceof InternalSandboxTransportError) {
      throw lastRetryableError;
    }
    fail('SANDBOX_TRANSPORT_ERROR', 'sandbox transport failure', {
      retryable: false,
    });
  }

  return Object.freeze({
    readFile,
    /** @internal test aid */
    _url: url,
    _maxAttempts: maxAttempts,
  });
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isConnectLevelFailure(err) {
  if (!err || typeof err !== 'object') return false;
  const code = /** @type {any} */ (err).code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  );
}

export {
  BODY_ROOT_KEYS,
  IDENTITY_KEYS,
  SUCCESS_TEXT_KEYS,
  SUCCESS_BINARY_KEYS,
};
