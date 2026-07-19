/** Agent -> Sandbox HMAC transport for claimed bash and Python execution. */

import { createHash } from 'node:crypto';

import { computeToolRequestHashV1 } from '../../domain/tool/tool-request-hash.js';
import { assertUlid } from '../../domain/shared/ulid.js';
import {
  issueInternalToken,
  validateInternalHmacKeyring,
} from './internal-hmac.js';
import { normalizeBaseUrl } from './internal-files-read-http.js';
import { createTraceHeaders } from './trace-context.js';

export const BASH_EXECUTION_HTU = '/internal/v1/executions/bash';
export const PYTHON_EXECUTION_HTU = '/internal/v1/executions/python';
export const BASH_EXECUTION_SCOPE = 'sandbox.executions.bash';
export const PYTHON_EXECUTION_SCOPE = 'sandbox.executions.python';

export const DEFAULT_EXECUTION_TIMEOUT_MS = 620_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

const COMMON_KEYS = Object.freeze([
  'identity',
  'toolExecutionId',
  'toolCallId',
  'requestHash',
  'requestHashVersion',
]);
const TOOL_KEYS = Object.freeze({
  bash: Object.freeze(['command', 'timeoutSeconds', 'env']),
  python: Object.freeze(['code', 'args', 'timeoutSeconds']),
});
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
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_ENV_KEY_RE =
  /^(?:AWS_|AZURE_|GCP_|GOOGLE_|OPENAI_|ANTHROPIC_|API[_-]?KEY|SECRET|PASSWORD|TOKEN|AUTHORIZATION|BEARER|PRIVATE[_-]?KEY|SSH_|HOME|PATH|LD_|DYLD_)/i;

export class InternalExecutionTransportError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'InternalExecutionTransportError';
    this.code = code;
    if (extra.httpStatus != null) this.httpStatus = extra.httpStatus;
    if (extra.outcomeUnknown === true) this.outcomeUnknown = true;
    if (extra.retryable != null) this.retryable = extra.retryable;
    if (extra.cause != null) this.cause = extra.cause;
  }
}

function fail(code, message, extra) {
  throw new InternalExecutionTransportError(code, message, extra);
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
    fail('EXECUTION_PAYLOAD_INVALID', `${field} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    fail(
      'EXECUTION_PAYLOAD_INVALID',
      `${field} keys do not match the execution contract`,
    );
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      fail('EXECUTION_PAYLOAD_INVALID', `${field}.${key} must be a data property`);
    }
  }
  return value;
}

function requireSafeInteger(value, field, minimum, maximum) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail('EXECUTION_PAYLOAD_INVALID', `${field} must be an integer in range`);
  }
  return value;
}

function requireUlid(value, field) {
  try {
    return assertUlid(value, field);
  } catch {
    fail('EXECUTION_PAYLOAD_INVALID', `${field} must be a formal ULID`);
  }
}

function requireVisibleAscii(value, field, maxLength = 255) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maxLength ||
    value !== value.trim() ||
    !VISIBLE_ASCII_RE.test(value)
  ) {
    fail('EXECUTION_PAYLOAD_INVALID', `${field} must be bounded visible ASCII`);
  }
  return value;
}

function normalizeIdentity(value) {
  const identity = requireExactKeys(value, IDENTITY_KEYS, 'identity');
  const traceId = identity.traceId;
  if (typeof traceId !== 'string' || !TRACE_RE.test(traceId)) {
    fail('EXECUTION_PAYLOAD_INVALID', 'identity.traceId must be lowercase hex32');
  }
  return {
    orgId: requireUlid(identity.orgId, 'identity.orgId'),
    userId: requireUlid(identity.userId, 'identity.userId'),
    conversationId: requireUlid(
      identity.conversationId,
      'identity.conversationId',
    ),
    agentSessionId: requireUlid(
      identity.agentSessionId,
      'identity.agentSessionId',
    ),
    runId: requireUlid(identity.runId, 'identity.runId'),
    sandboxSessionId: requireUlid(
      identity.sandboxSessionId,
      'identity.sandboxSessionId',
    ),
    traceId,
    executionFenceToken: requireSafeInteger(
      identity.executionFenceToken,
      'identity.executionFenceToken',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function normalizeEnv(value) {
  if (!isPlainObject(value) || Reflect.ownKeys(value).length > 32) {
    fail('EXECUTION_PAYLOAD_INVALID', 'env must be a bounded plain object');
  }
  const env = {};
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== 'string' ||
      !ENV_KEY_RE.test(key) ||
      key.length > 64 ||
      SENSITIVE_ENV_KEY_RE.test(key)
    ) {
      fail('EXECUTION_PAYLOAD_INVALID', 'env key is invalid or denied');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.length > 1024
    ) {
      fail('EXECUTION_PAYLOAD_INVALID', 'env value must be a bounded string');
    }
    env[key] = descriptor.value;
  }
  return env;
}

/**
 * Validate the exact sandbox-bridge payload and recompute its bound hash.
 */
export function validateAndNormalizeExecutionPayload(toolName, payload) {
  const toolKeys = TOOL_KEYS[toolName];
  if (!toolKeys) {
    fail('EXECUTION_TOOL_INVALID', 'unsupported execution tool');
  }
  const root = requireExactKeys(
    payload,
    [...toolKeys, ...COMMON_KEYS],
    'payload',
  );
  const identity = normalizeIdentity(root.identity);
  const toolExecutionId = requireUlid(root.toolExecutionId, 'toolExecutionId');
  const toolCallId = requireVisibleAscii(root.toolCallId, 'toolCallId');
  if (typeof root.requestHash !== 'string' || !SHA256_RE.test(root.requestHash)) {
    fail('EXECUTION_PAYLOAD_INVALID', 'requestHash must be lowercase sha256');
  }
  requireSafeInteger(root.requestHashVersion, 'requestHashVersion', 1, 1);

  let args;
  if (toolName === 'bash') {
    if (
      typeof root.command !== 'string' ||
      !root.command.trim() ||
      root.command.length > 8192
    ) {
      fail('EXECUTION_PAYLOAD_INVALID', 'command is empty or too long');
    }
    args = {
      command: root.command,
      timeoutSeconds: requireSafeInteger(
        root.timeoutSeconds,
        'timeoutSeconds',
        1,
        600,
      ),
      env: normalizeEnv(root.env),
    };
  } else {
    if (typeof root.code !== 'string' || !root.code.trim()) {
      fail('EXECUTION_PAYLOAD_INVALID', 'code is required');
    }
    if (Buffer.byteLength(root.code, 'utf8') > 256 * 1024) {
      fail('EXECUTION_PAYLOAD_INVALID', 'code is too large');
    }
    if (!Array.isArray(root.args) || root.args.length > 32) {
      fail('EXECUTION_PAYLOAD_INVALID', 'args must be a bounded array');
    }
    const pythonArgs = root.args.map((arg) => {
      if (typeof arg !== 'string' || arg.length > 1024) {
        fail('EXECUTION_PAYLOAD_INVALID', 'python arg is invalid');
      }
      return arg;
    });
    args = {
      code: root.code,
      args: pythonArgs,
      timeoutSeconds: requireSafeInteger(
        root.timeoutSeconds,
        'timeoutSeconds',
        1,
        600,
      ),
    };
  }

  let computed;
  try {
    computed = computeToolRequestHashV1({ toolName, args });
  } catch {
    fail('EXECUTION_HASH_INVALID', 'execution args cannot be hashed');
  }
  if (
    computed.requestHashVersion !== root.requestHashVersion ||
    computed.requestHash !== root.requestHash
  ) {
    fail('EXECUTION_HASH_INVALID', 'requestHash does not match execution args');
  }

  return {
    toolName,
    args,
    identity,
    toolExecutionId,
    toolCallId,
    requestHash: root.requestHash,
    requestHashVersion: root.requestHashVersion,
  };
}

/** Use the exact same bytes for body_sha256 and the HTTP request body. */
export function buildInternalExecutionBodyBytes(toolName, payload) {
  const normalized = validateAndNormalizeExecutionPayload(toolName, payload);
  const bodyObject = {
    ...normalized.args,
    identity: normalized.identity,
    toolExecutionId: normalized.toolExecutionId,
    toolCallId: normalized.toolCallId,
    requestHash: normalized.requestHash,
    requestHashVersion: normalized.requestHashVersion,
  };
  const bodyBytes = Buffer.from(JSON.stringify(bodyObject), 'utf8');
  return {
    normalized,
    bodyBytes,
    bodySha256: createHash('sha256').update(bodyBytes).digest('hex'),
  };
}

function parseJsonObject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('SANDBOX_RESPONSE_INVALID', 'Sandbox returned invalid JSON');
  }
  if (!isPlainObject(parsed)) {
    fail('SANDBOX_RESPONSE_INVALID', 'Sandbox response must be an object');
  }
  return parsed;
}

function isJsonContentType(value) {
  return (
    typeof value === 'string' &&
    /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|\s*$)/i.test(value)
  );
}

function validateSuccessResponse(toolName, payload) {
  const common = ['exitCode', 'stdout', 'stderr', 'truncated', 'durationMs'];
  const expected =
    toolName === 'python'
      ? [...common, 'materializedPath', 'pythonVersion', 'pythonMode']
      : common;
  const result = requireExactKeys(payload, expected, 'response');
  if (
    !Number.isSafeInteger(result.exitCode) ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string' ||
    typeof result.truncated !== 'boolean' ||
    typeof result.durationMs !== 'number' ||
    !Number.isFinite(result.durationMs) ||
    result.durationMs < 0
  ) {
    fail('SANDBOX_RESPONSE_INVALID', 'Sandbox execution result is invalid');
  }
  if (toolName === 'python') {
    for (const key of ['materializedPath', 'pythonVersion', 'pythonMode']) {
      if (result[key] !== null && typeof result[key] !== 'string') {
        fail('SANDBOX_RESPONSE_INVALID', `Sandbox response ${key} is invalid`);
      }
    }
  }
  return Object.fromEntries(expected.map((key) => [key, result[key]]));
}

function errorFromResponse(payload, status) {
  const nested = isPlainObject(payload.error) ? payload.error : null;
  const code =
    nested && typeof nested.code === 'string' && nested.code
      ? nested.code
      : status === 409
        ? 'SANDBOX_CONFLICT'
        : 'SANDBOX_ERROR';
  const message =
    nested && typeof nested.message === 'string' && nested.message
      ? nested.message.slice(0, 512)
      : `Sandbox execution failed (status=${status})`;
  return new InternalExecutionTransportError(code, message, {
    httpStatus: status,
    retryable: false,
    outcomeUnknown: code === 'TOOL_OUTCOME_UNKNOWN',
  });
}

/**
 * @param {{
 *   baseUrl: string,
 *   keyring: object|string,
 *   activeKid: string,
 *   allowInsecureHttp?: boolean,
 *   fetchImpl?: typeof fetch,
 *   clock?: () => number,
 *   randomBytes?: (size: number) => Uint8Array,
 *   timeoutMs?: number,
 *   maxResponseBytes?: number,
 *   ttlSeconds?: number,
 *   signal?: AbortSignal,
 * }} options
 */
export function createInternalExecutionTransport(options) {
  if (!options || typeof options !== 'object') {
    fail('SANDBOX_TRANSPORT_CONFIG', 'options object is required');
  }
  const baseUrl = normalizeBaseUrl(options.baseUrl, {
    allowInsecureHttp: options.allowInsecureHttp === true,
  });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    fail('SANDBOX_TRANSPORT_CONFIG', 'fetchImpl must be a function');
  }
  validateInternalHmacKeyring(options.keyring, options.activeKid);
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  requireSafeInteger(timeoutMs, 'timeoutMs', 1, Number.MAX_SAFE_INTEGER);
  requireSafeInteger(
    maxResponseBytes,
    'maxResponseBytes',
    1,
    Number.MAX_SAFE_INTEGER,
  );

  async function execute(toolName, payload) {
    const { normalized, bodyBytes, bodySha256 } =
      buildInternalExecutionBodyBytes(toolName, payload);
    if (options.signal?.aborted) {
      fail('SANDBOX_CANCELLED', 'request was cancelled before send', {
        retryable: false,
      });
    }
    const htu =
      toolName === 'bash' ? BASH_EXECUTION_HTU : PYTHON_EXECUTION_HTU;
    const scope =
      toolName === 'bash' ? BASH_EXECUTION_SCOPE : PYTHON_EXECUTION_SCOPE;
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
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${htu}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': String(bodyBytes.byteLength),
          ...createTraceHeaders(normalized.identity.traceId, {
            randomBytes: options.spanRandomBytes,
            traceState: options.traceState,
          }),
        },
        body: bodyBytes,
        signal: controller.signal,
      });
    } catch (error) {
      throw new InternalExecutionTransportError(
        'TOOL_OUTCOME_UNKNOWN',
        'Sandbox execution outcome is unknown after dispatch',
        {
          outcomeUnknown: true,
          retryable: false,
          cause: error,
        },
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    try {
      const contentLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
        fail('SANDBOX_RESPONSE_TOO_LARGE', 'Sandbox response exceeds size limit');
      }
      let responseBytes;
      try {
        responseBytes = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        throw new InternalExecutionTransportError(
          'TOOL_OUTCOME_UNKNOWN',
          'Sandbox response was interrupted after dispatch',
          {
            outcomeUnknown: true,
            retryable: false,
            cause: error,
          },
        );
      }
      if (responseBytes.byteLength > maxResponseBytes) {
        fail('SANDBOX_RESPONSE_TOO_LARGE', 'Sandbox response exceeds size limit');
      }
      const contentType = response.headers?.get?.('content-type') ?? null;
      if (response.ok && !isJsonContentType(contentType)) {
        fail(
          'SANDBOX_RESPONSE_INVALID',
          'Sandbox success response must be application/json',
          { httpStatus: response.status },
        );
      }
      const parsed = parseJsonObject(responseBytes.toString('utf8'));
      if (!response.ok) throw errorFromResponse(parsed, response.status);
      return validateSuccessResponse(toolName, parsed);
    } catch (error) {
      if (
        error instanceof InternalExecutionTransportError &&
        error.outcomeUnknown !== true &&
        (response.ok || error.code === 'SANDBOX_RESPONSE_INVALID')
      ) {
        throw new InternalExecutionTransportError(
          'TOOL_OUTCOME_UNKNOWN',
          'Sandbox success response could not be verified after dispatch',
          {
            outcomeUnknown: true,
            retryable: false,
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  return Object.freeze({
    bash: (payload) => execute('bash', payload),
    python: (payload) => execute('python', payload),
  });
}
