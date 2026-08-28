/**
 * Agent -> Sandbox HMAC transport for the read-only search tools ls/find/grep.
 *
 * Same shape as the process transport: strict payload normalisation, a
 * recomputed request hash that must match what the ledger bound, and a signed
 * claim scoped to exactly one route. Search never mutates the workspace, so a
 * transport failure is retryable and never reports outcomeUnknown — re-running
 * the same search is always safe.
 */
import { createHash } from 'node:crypto';
import { computeToolRequestHashV1 } from '../../domain/tool/tool-request-hash.js';
import { assertUlid } from '../../domain/shared/ulid.js';
import {
  issueInternalToken,
  validateInternalHmacKeyring,
} from './internal-hmac.js';
import { normalizeBaseUrl } from './internal-files-read-http.js';
import { createTraceHeaders } from './trace-context.js';

const ROUTES = Object.freeze({
  ls: ['/internal/v1/files/ls', 'sandbox.files.ls'],
  find: ['/internal/v1/files/find', 'sandbox.files.find'],
  grep: ['/internal/v1/files/grep', 'sandbox.files.grep'],
});

const TOOL_KEYS = Object.freeze({
  ls: ['path', 'depth', 'includeHidden'],
  find: ['path', 'pattern', 'type', 'maxDepth', 'limit'],
  grep: [
    'path',
    'query',
    'glob',
    'regex',
    'caseSensitive',
    'context',
    'limit',
    'outputMode',
  ],
});

const FIND_TYPES = new Set(['file', 'dir', 'symlink']);
const GREP_OUTPUT_MODES = new Set(['content', 'files_with_matches', 'count']);

export const SEARCH_MAX_PATH_LEN = 512;
export const SEARCH_MAX_PATTERN_LEN = 512;
export const SEARCH_MAX_QUERY_LEN = 1_024;
export const LS_MAX_DEPTH = 5;
export const FIND_MAX_DEPTH = 20;
export const FIND_MAX_LIMIT = 500;
export const GREP_MAX_LIMIT = 500;
export const GREP_MAX_CONTEXT = 5;
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;

class InternalSearchTransportError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'InternalSearchTransportError';
    this.code = code;
    if (extra.httpStatus != null) this.httpStatus = extra.httpStatus;
    if (extra.retryable != null) this.retryable = extra.retryable;
    if (extra.cause != null) this.cause = extra.cause;
  }
}

function fail(code, message, extra) {
  throw new InternalSearchTransportError(code, message, extra);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reqUlid(value, field) {
  try {
    return assertUlid(value, field);
  } catch {
    return fail('SEARCH_PAYLOAD_INVALID', `${field} must be a formal ULID`);
  }
}

function reqAscii(value, field, max = 255) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > max ||
    value !== value.trim()
  ) {
    fail('SEARCH_PAYLOAD_INVALID', `${field} invalid`);
  }
  return value;
}

function reqInt(value, field, min, max) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    fail('SEARCH_PAYLOAD_INVALID', `${field} invalid`);
  }
  return value;
}

function reqBool(value, field) {
  if (typeof value !== 'boolean') {
    fail('SEARCH_PAYLOAD_INVALID', `${field} invalid`);
  }
  return value;
}

function reqText(value, field, max, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    fail('SEARCH_PAYLOAD_INVALID', `${field} invalid`);
  }
  if (!allowEmpty && !value.trim()) {
    fail('SEARCH_PAYLOAD_INVALID', `${field} invalid`);
  }
  return value;
}

function identity(ctx) {
  if (!plain(ctx) || Object.keys(ctx).length !== 8) {
    fail('SEARCH_PAYLOAD_INVALID', 'identity keys invalid');
  }
  const trace = reqAscii(ctx.traceId, 'identity.traceId', 32);
  if (!/^[0-9a-f]{32}$/.test(trace)) {
    fail('SEARCH_PAYLOAD_INVALID', 'identity.traceId invalid');
  }
  return {
    orgId: reqUlid(ctx.orgId, 'identity.orgId'),
    userId: reqUlid(ctx.userId, 'identity.userId'),
    conversationId: reqUlid(ctx.conversationId, 'identity.conversationId'),
    agentSessionId: reqUlid(ctx.agentSessionId, 'identity.agentSessionId'),
    runId: reqUlid(ctx.runId, 'identity.runId'),
    sandboxSessionId: reqUlid(ctx.sandboxSessionId, 'identity.sandboxSessionId'),
    traceId: trace,
    executionFenceToken: reqInt(
      ctx.executionFenceToken,
      'identity.executionFenceToken',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function searchArgs(toolName, payload) {
  const path = reqText(payload.path, 'path', SEARCH_MAX_PATH_LEN);
  if (toolName === 'ls') {
    return {
      path,
      depth: reqInt(payload.depth, 'depth', 0, LS_MAX_DEPTH),
      includeHidden: reqBool(payload.includeHidden, 'includeHidden'),
    };
  }
  if (toolName === 'find') {
    if (payload.type !== null && !FIND_TYPES.has(payload.type)) {
      fail('SEARCH_PAYLOAD_INVALID', 'type invalid');
    }
    return {
      path,
      pattern: reqText(payload.pattern, 'pattern', SEARCH_MAX_PATTERN_LEN),
      type: payload.type,
      maxDepth: reqInt(payload.maxDepth, 'maxDepth', 0, FIND_MAX_DEPTH),
      limit: reqInt(payload.limit, 'limit', 1, FIND_MAX_LIMIT),
    };
  }
  let glob = payload.glob;
  if (glob !== null) {
    glob = reqText(glob, 'glob', SEARCH_MAX_PATTERN_LEN);
  }
  if (!GREP_OUTPUT_MODES.has(payload.outputMode)) {
    fail('SEARCH_PAYLOAD_INVALID', 'outputMode invalid');
  }
  return {
    path,
    query: reqText(payload.query, 'query', SEARCH_MAX_QUERY_LEN),
    glob,
    regex: reqBool(payload.regex, 'regex'),
    caseSensitive: reqBool(payload.caseSensitive, 'caseSensitive'),
    context: reqInt(payload.context, 'context', 0, GREP_MAX_CONTEXT),
    limit: reqInt(payload.limit, 'limit', 1, GREP_MAX_LIMIT),
    outputMode: payload.outputMode,
  };
}

function normalize(toolName, payload) {
  if (!plain(payload) || !ROUTES[toolName]) {
    fail('SEARCH_PAYLOAD_INVALID', 'payload invalid');
  }
  const expected = new Set([
    'identity',
    'toolExecutionId',
    'toolCallId',
    'requestHash',
    'requestHashVersion',
    ...TOOL_KEYS[toolName],
  ]);
  const keys = Object.keys(payload);
  if (keys.length !== expected.size || keys.some((k) => !expected.has(k))) {
    fail('SEARCH_PAYLOAD_INVALID', 'payload keys invalid');
  }

  const id = identity(payload.identity || {});
  const requestHash = reqAscii(payload.requestHash, 'requestHash', 64);
  if (!/^[0-9a-f]{64}$/.test(requestHash)) {
    fail('SEARCH_PAYLOAD_INVALID', 'requestHash invalid');
  }
  const args = searchArgs(toolName, payload);

  let hash;
  try {
    hash = computeToolRequestHashV1({ toolName, args });
  } catch {
    return fail('SEARCH_HASH_INVALID', 'request hash cannot be computed');
  }
  const requestHashVersion = reqInt(
    payload.requestHashVersion,
    'requestHashVersion',
    1,
    1,
  );
  if (
    hash.requestHash !== requestHash ||
    hash.requestHashVersion !== requestHashVersion
  ) {
    fail('SEARCH_HASH_INVALID', 'requestHash mismatch');
  }

  return {
    identity: id,
    toolExecutionId: reqUlid(payload.toolExecutionId, 'toolExecutionId'),
    toolCallId: reqAscii(payload.toolCallId, 'toolCallId'),
    requestHash,
    requestHashVersion,
    ...args,
  };
}

export function createInternalSearchTransport(options) {
  if (!options || typeof options !== 'object') {
    fail('SEARCH_TRANSPORT_CONFIG', 'options object is required');
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl, {
    allowInsecureHttp: options.allowInsecureHttp === true,
  });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    fail('SEARCH_TRANSPORT_CONFIG', 'fetchImpl must be a function');
  }
  validateInternalHmacKeyring(options.keyring, options.activeKid);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;

  async function call(toolName, payload) {
    const normalized = normalize(toolName, payload);
    const body = Buffer.from(JSON.stringify(normalized), 'utf8');
    const bodySha256 = createHash('sha256').update(body).digest('hex');
    const [htu, scope] = ROUTES[toolName];
    const token = issueInternalToken({
      keyring: options.keyring,
      activeKid: options.activeKid,
      clock: options.clock,
      randomBytes: options.randomBytes,
      ttlSeconds: options.ttlSeconds,
      claims: {
        org_id: normalized.identity.orgId,
        user_id: normalized.identity.userId,
        conversation_id: normalized.identity.conversationId,
        agent_session_id: normalized.identity.agentSessionId,
        sandbox_session_id: normalized.identity.sandboxSessionId,
        run_id: normalized.identity.runId,
        tool_execution_id: normalized.toolExecutionId,
        tool_call_id: normalized.toolCallId,
        tool_name: toolName,
        scope: [scope],
        request_hash: normalized.requestHash,
        execution_fence_token: normalized.identity.executionFenceToken,
        trace_id: normalized.identity.traceId,
        htm: 'POST',
        htu,
        body_sha256: bodySha256,
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${htu}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...createTraceHeaders(normalized.identity.traceId, {
            randomBytes: options.spanRandomBytes,
            traceState: options.traceState,
          }),
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      // Read-only: nothing can have been mutated, so this is plainly retryable
      // and never an unknown outcome.
      return fail('SEARCH_TRANSPORT_UNAVAILABLE', 'Sandbox search request failed', {
        retryable: true,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      return fail('SEARCH_RESPONSE_INVALID', 'Sandbox returned invalid JSON');
    }
    if (!response.ok) {
      const code =
        plain(parsed?.error) && typeof parsed.error.code === 'string'
          ? parsed.error.code
          : 'SANDBOX_ERROR';
      fail(code, 'Sandbox search request failed', {
        httpStatus: response.status,
      });
    }
    if (!plain(parsed)) {
      fail('SEARCH_RESPONSE_INVALID', 'Sandbox response must be object');
    }
    return parsed;
  }

  return Object.freeze({
    lsFiles: (payload) => call('ls', payload),
    findFiles: (payload) => call('find', payload),
    grepFiles: (payload) => call('grep', payload),
  });
}

export { InternalSearchTransportError };
