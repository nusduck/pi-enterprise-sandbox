/** Agent -> Sandbox HMAC transport for formal files.write/files.edit. */

import { createHash, randomBytes } from 'node:crypto';

import { computeToolRequestHashV1 } from '../../domain/tool/tool-request-hash.js';
import { assertUlid } from '../../domain/shared/ulid.js';
import { issueInternalToken, validateInternalHmacKeyring } from './internal-hmac.js';
import {
  extractCompactJwtPayloadJti,
  normalizeBaseUrl,
} from './internal-files-read-http.js';
import { createTraceHeaders } from './trace-context.js';

export const FILES_WRITE_HTU = '/internal/v1/files/write';
export const FILES_EDIT_HTU = '/internal/v1/files/edit';
export const FILES_CONTENT_MAX_BYTES = 16 * 1024 * 1024;

const COMMON_KEYS = Object.freeze([
  'identity',
  'toolExecutionId',
  'toolCallId',
  'requestHash',
  'requestHashVersion',
]);
const WRITE_KEYS = Object.freeze([...COMMON_KEYS, 'path', 'content', 'encoding']);
const EDIT_REQUIRED_KEYS = Object.freeze([
  ...COMMON_KEYS,
  'path',
  'oldText',
  'newText',
]);
const EDIT_OPTIONAL_KEYS = Object.freeze(['expectedHash', 'expectedVersion']);
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
const SHA256_RE = /^[0-9a-f]{64}$/;
const TRACE_RE = /^[0-9a-f]{32}$/;
const VISIBLE_ASCII_RE = /^[\x21-\x7e]+$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class InternalFilesWriteError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'InternalFilesWriteError';
    this.code = code;
    if (extra.httpStatus != null) this.httpStatus = extra.httpStatus;
    if (extra.outcomeUnknown === true) this.outcomeUnknown = true;
    if (extra.cause != null) this.cause = extra.cause;
  }
}

function fail(code, message, extra) {
  throw new InternalFilesWriteError(code, message, extra);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, expected, field) {
  if (!isPlainObject(value)) {
    fail('FILES_WRITE_PAYLOAD_INVALID', `${field} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    fail('FILES_WRITE_PAYLOAD_INVALID', `${field} keys do not match the contract`);
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('FILES_WRITE_PAYLOAD_INVALID', `${field}.${key} must be a data property`);
    }
  }
  return value;
}

function requireVisibleAscii(value, field, maxLength = 255) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maxLength ||
    value !== value.trim() ||
    !VISIBLE_ASCII_RE.test(value)
  ) {
    fail('FILES_WRITE_PAYLOAD_INVALID', `${field} must be bounded visible ASCII`);
  }
  return value;
}

function requireUlid(value, field) {
  try {
    return assertUlid(value, field);
  } catch {
    fail('FILES_WRITE_PAYLOAD_INVALID', `${field} must be a formal ULID`);
  }
}

function normalizeIdentity(value) {
  const identity = requireExactKeys(value, IDENTITY_KEYS, 'identity');
  if (typeof identity.traceId !== 'string' || !TRACE_RE.test(identity.traceId)) {
    fail('FILES_WRITE_PAYLOAD_INVALID', 'identity.traceId must be lowercase hex32');
  }
  if (
    !Number.isSafeInteger(identity.executionFenceToken) ||
    identity.executionFenceToken < 1
  ) {
    fail('FILES_WRITE_PAYLOAD_INVALID', 'executionFenceToken invalid');
  }
  return {
    orgId: requireUlid(identity.orgId, 'identity.orgId'),
    userId: requireUlid(identity.userId, 'identity.userId'),
    conversationId: requireUlid(identity.conversationId, 'identity.conversationId'),
    agentSessionId: requireUlid(identity.agentSessionId, 'identity.agentSessionId'),
    runId: requireUlid(identity.runId, 'identity.runId'),
    sandboxSessionId: requireUlid(identity.sandboxSessionId, 'identity.sandboxSessionId'),
    traceId: identity.traceId,
    executionFenceToken: identity.executionFenceToken,
  };
}

function normalizePath(value) {
  const path = requireVisibleAscii(value, 'path', 512);
  const prefix = '/home/sandbox/workspace/';
  if (
    !path.startsWith(prefix) ||
    path.endsWith('/') ||
    path.includes('//') ||
    path.includes('\\') ||
    path.includes('\0')
  ) {
    fail('FILES_WRITE_PATH', 'invalid workspace path');
  }
  const parts = path.slice(prefix.length).split('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) {
    fail('FILES_WRITE_PATH', 'invalid workspace path');
  }
  return path;
}

function decodedContentSize(content, encoding) {
  if (encoding === 'utf-8') return Buffer.byteLength(content, 'utf8');
  if (!BASE64_RE.test(content)) {
    fail('FILES_WRITE_PAYLOAD_INVALID', 'content must be canonical base64');
  }
  const decoded = Buffer.from(content, 'base64');
  if (decoded.toString('base64') !== content) {
    fail('FILES_WRITE_PAYLOAD_INVALID', 'content must be canonical base64');
  }
  return decoded.byteLength;
}

function normalize(payload, tool) {
  if (!isPlainObject(payload)) {
    fail('FILES_WRITE_PAYLOAD_INVALID', 'payload must be a plain object');
  }
  let expectedKeys;
  if (tool === 'write') {
    expectedKeys = WRITE_KEYS;
  } else {
    const optional = EDIT_OPTIONAL_KEYS.filter((key) => Object.hasOwn(payload, key));
    expectedKeys = [...EDIT_REQUIRED_KEYS, ...optional];
  }
  requireExactKeys(payload, expectedKeys, 'payload');

  const identity = normalizeIdentity(payload.identity);
  const toolExecutionId = requireUlid(payload.toolExecutionId, 'toolExecutionId');
  const toolCallId = requireVisibleAscii(payload.toolCallId, 'toolCallId');
  const path = normalizePath(payload.path);
  const args = { path };

  if (tool === 'write') {
    if (typeof payload.content !== 'string') {
      fail('FILES_WRITE_PAYLOAD_INVALID', 'content must be a string');
    }
    if (payload.encoding !== 'utf-8' && payload.encoding !== 'base64') {
      fail('FILES_WRITE_PAYLOAD_INVALID', 'encoding invalid');
    }
    if (decodedContentSize(payload.content, payload.encoding) > FILES_CONTENT_MAX_BYTES) {
      fail('FILES_WRITE_PAYLOAD_INVALID', 'decoded content is too large');
    }
    args.content = payload.content;
    args.encoding = payload.encoding;
  } else {
    if (typeof payload.oldText !== 'string' || typeof payload.newText !== 'string') {
      fail('FILES_WRITE_PAYLOAD_INVALID', 'oldText/newText must be strings');
    }
    if (
      Buffer.byteLength(payload.oldText, 'utf8') > FILES_CONTENT_MAX_BYTES ||
      Buffer.byteLength(payload.newText, 'utf8') > FILES_CONTENT_MAX_BYTES
    ) {
      fail('FILES_WRITE_PAYLOAD_INVALID', 'edit text is too large');
    }
    if (!Object.hasOwn(payload, 'expectedHash') && !Object.hasOwn(payload, 'expectedVersion')) {
      fail('FILE_VERSION_PRECONDITION_REQUIRED', 'expectedHash or expectedVersion required');
    }
    args.oldText = payload.oldText;
    args.newText = payload.newText;
    if (Object.hasOwn(payload, 'expectedHash')) {
      if (typeof payload.expectedHash !== 'string' || !SHA256_RE.test(payload.expectedHash)) {
        fail('FILES_WRITE_PAYLOAD_INVALID', 'expectedHash invalid');
      }
      args.expectedHash = payload.expectedHash;
    }
    if (Object.hasOwn(payload, 'expectedVersion')) {
      args.expectedVersion = requireVisibleAscii(payload.expectedVersion, 'expectedVersion');
    }
  }

  let computed;
  try {
    computed = computeToolRequestHashV1({ toolName: tool, args });
  } catch {
    fail('FILES_WRITE_HASH', 'request hash computation failed');
  }
  if (
    payload.requestHash !== computed.requestHash ||
    payload.requestHashVersion !== computed.requestHashVersion
  ) {
    fail('FILES_WRITE_HASH', 'request hash mismatch');
  }

  const body = {
    ...args,
    identity,
    toolExecutionId,
    toolCallId,
    requestHash: computed.requestHash,
    requestHashVersion: computed.requestHashVersion,
  };
  return {
    bodyBytes: Buffer.from(JSON.stringify(body), 'utf8'),
    normalized: { ...body, tool },
  };
}

function safeError(status, parsed) {
  const detail = parsed?.error ?? parsed?.detail;
  const code =
    typeof detail?.code === 'string'
      ? detail.code
      : status === 409
        ? 'SANDBOX_CONFLICT'
        : status >= 500
          ? 'SANDBOX_ERROR'
          : 'SANDBOX_REQUEST_REJECTED';
  const message =
    typeof detail?.message === 'string'
      ? detail.message.slice(0, 512)
      : 'sandbox request failed';
  throw new InternalFilesWriteError(code, message, {
    httpStatus: status,
    outcomeUnknown: code === 'TOOL_OUTCOME_UNKNOWN',
  });
}

function validateResponse(parsed, normalized, tool) {
  if (!isPlainObject(parsed)) {
    fail('SANDBOX_RESPONSE_INVALID', 'response must be an object');
  }
  const keys = tool === 'write'
    ? ['path', 'size', 'hash', 'version']
    : ['path', 'hash', 'version', 'beforeHash'];
  const result = {};
  for (const key of keys) {
    if (!Object.hasOwn(parsed, key)) {
      fail('SANDBOX_RESPONSE_INVALID', 'response fields missing');
    }
    result[key] = parsed[key];
  }
  if (result.path !== normalized.path) {
    fail('SANDBOX_RESPONSE_INVALID', 'response path mismatch');
  }
  if (tool === 'write' && (!Number.isSafeInteger(result.size) || result.size < 0)) {
    fail('SANDBOX_RESPONSE_INVALID', 'response size invalid');
  }
  for (const key of tool === 'write'
    ? ['hash', 'version']
    : ['hash', 'version', 'beforeHash']) {
    if (typeof result[key] !== 'string' || !SHA256_RE.test(result[key])) {
      fail('SANDBOX_RESPONSE_INVALID', 'response digest invalid');
    }
  }
  return { ...result };
}

export function createInternalFilesWriteTransport(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl, {
    allowInsecureHttp: options.allowInsecureHttp === true,
  });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    fail('SANDBOX_TRANSPORT_CONFIG', 'fetchImpl required');
  }
  const tokenIssuer = options.tokenIssuer;
  if (typeof tokenIssuer !== 'function') {
    validateInternalHmacKeyring(options.keyring, options.activeKid);
  }

  async function call(payload, tool) {
    const { bodyBytes, normalized } = normalize(payload, tool);
    const bodySha256 = createHash('sha256').update(bodyBytes).digest('hex');
    const jti = randomBytes(16);
    const htu = tool === 'write' ? FILES_WRITE_HTU : FILES_EDIT_HTU;
    const claims = {
      org_id: normalized.identity.orgId,
      user_id: normalized.identity.userId,
      conversation_id: normalized.identity.conversationId,
      agent_session_id: normalized.identity.agentSessionId,
      sandbox_session_id: normalized.identity.sandboxSessionId,
      run_id: normalized.identity.runId,
      tool_execution_id: normalized.toolExecutionId,
      tool_call_id: normalized.toolCallId,
      tool_name: tool,
      scope: [`sandbox.files.${tool}`],
      request_hash: normalized.requestHash,
      execution_fence_token: normalized.identity.executionFenceToken,
      trace_id: normalized.identity.traceId,
      htm: 'POST',
      htu,
      body_sha256: bodySha256,
    };
    let token;
    if (typeof tokenIssuer === 'function') {
      token = await tokenIssuer(claims, {
        bodyBytes,
        bodySha256,
        expectedJti: jti.toString('base64url'),
        attempt: 1,
        jtiBytes: jti,
      });
      let actualJti;
      try {
        actualJti = extractCompactJwtPayloadJti(token);
      } catch {
        fail(
          'SANDBOX_TOKEN_JTI_MISMATCH',
          'tokenIssuer must return a compact JWT',
        );
      }
      if (actualJti !== jti.toString('base64url')) {
        fail(
          'SANDBOX_TOKEN_JTI_MISMATCH',
          'tokenIssuer must embed transport-generated expectedJti',
        );
      }
    } else {
      token = issueInternalToken({
        keyring: options.keyring,
        activeKid: options.activeKid,
        claims,
        randomBytes: () => jti,
        ttlSeconds: options.ttlSeconds,
      });
    }

    let response;
    try {
      response = await fetchImpl(`${baseUrl}${htu}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...createTraceHeaders(normalized.identity.traceId, {
            randomBytes: options.spanRandomBytes,
            traceState: options.traceState,
          }),
        },
        body: bodyBytes,
        signal: options.signal,
      });
    } catch (cause) {
      throw new InternalFilesWriteError(
        'TOOL_OUTCOME_UNKNOWN',
        'network error after dispatch; outcome unknown',
        { outcomeUnknown: true, cause },
      );
    }

    let parsed;
    try {
      parsed = await response.json();
    } catch (cause) {
      fail('SANDBOX_RESPONSE_INVALID', 'response is not JSON', {
        httpStatus: response.status,
        cause,
      });
    }
    if (!response.ok) safeError(response.status, parsed);
    return validateResponse(parsed, normalized, tool);
  }

  return Object.freeze({
    writeFile: (payload) => call(payload, 'write'),
    editFile: (payload) => call(payload, 'edit'),
  });
}
