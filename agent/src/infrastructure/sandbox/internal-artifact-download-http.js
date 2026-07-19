/** Agent -> Sandbox HMAC transport for owner-scoped artifact byte delivery. */

import { createHash } from 'node:crypto';

import { assertUlid } from '../../domain/shared/ulid.js';
import {
  issueInternalToken,
  validateInternalHmacKeyring,
} from './internal-hmac.js';
import { normalizeBaseUrl } from './internal-files-read-http.js';
import { createTraceHeaders } from './trace-context.js';

export const ARTIFACT_DOWNLOAD_HTU = '/internal/v1/artifacts/download';
export const ARTIFACT_DOWNLOAD_SCOPE = 'sandbox.artifacts.download';
export const ARTIFACT_DOWNLOAD_TOOL = 'artifact.download';
export const DEFAULT_ARTIFACT_DOWNLOAD_TIMEOUT_MS = 30_000;

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const HEADER_VALUE_MAX_LENGTH = 1024;

export class InternalArtifactDownloadError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'InternalArtifactDownloadError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function fail(code, message, extra = {}) {
  throw new InternalArtifactDownloadError(code, message, extra);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, field) {
  if (!isPlainObject(value)) {
    fail('ARTIFACT_DOWNLOAD_PAYLOAD_INVALID', `${field} must be an object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    fail('ARTIFACT_DOWNLOAD_PAYLOAD_INVALID', `${field} keys invalid`);
  }
  return value;
}

function ulid(value, field) {
  try {
    return assertUlid(value, field);
  } catch {
    fail('ARTIFACT_DOWNLOAD_PAYLOAD_INVALID', `${field} must be a formal ULID`);
  }
}

function positiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('ARTIFACT_DOWNLOAD_PAYLOAD_INVALID', `${field} must be positive`);
  }
  return value;
}

function normalizeIdentity(input) {
  const value = exactKeys(
    input,
    [
      'orgId',
      'userId',
      'conversationId',
      'agentSessionId',
      'runId',
      'sandboxSessionId',
      'traceId',
      'executionFenceToken',
    ],
    'identity',
  );
  const traceId = String(value.traceId || '');
  if (!TRACE_ID_RE.test(traceId)) {
    fail('ARTIFACT_DOWNLOAD_PAYLOAD_INVALID', 'identity.traceId invalid');
  }
  return {
    orgId: ulid(value.orgId, 'identity.orgId'),
    userId: ulid(value.userId, 'identity.userId'),
    conversationId: ulid(value.conversationId, 'identity.conversationId'),
    agentSessionId: ulid(value.agentSessionId, 'identity.agentSessionId'),
    runId: ulid(value.runId, 'identity.runId'),
    sandboxSessionId: ulid(value.sandboxSessionId, 'identity.sandboxSessionId'),
    traceId,
    executionFenceToken: positiveSafeInteger(
      value.executionFenceToken,
      'identity.executionFenceToken',
    ),
  };
}

function normalizeInput(input) {
  const value = exactKeys(
    input,
    ['artifactId', 'identity', 'expectedSizeBytes', 'expectedSha256'],
    'download input',
  );
  const expectedSizeBytes = value.expectedSizeBytes;
  if (
    expectedSizeBytes !== null &&
    (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0)
  ) {
    fail('ARTIFACT_DOWNLOAD_PAYLOAD_INVALID', 'expectedSizeBytes invalid');
  }
  const expectedSha256 = String(value.expectedSha256 || '').toLowerCase();
  if (!SHA256_RE.test(expectedSha256)) {
    fail('ARTIFACT_DOWNLOAD_PAYLOAD_INVALID', 'expectedSha256 invalid');
  }
  return {
    artifactId: ulid(value.artifactId, 'artifactId'),
    identity: normalizeIdentity(value.identity),
    expectedSizeBytes,
    expectedSha256,
  };
}

function responseHeader(response, name) {
  const value = response?.headers?.get?.(name);
  if (value == null) return null;
  const text = String(value);
  if (
    !text ||
    text.length > HEADER_VALUE_MAX_LENGTH ||
    /[\r\n\0]/u.test(text)
  ) {
    fail('SANDBOX_RESPONSE_INVALID', `${name} header invalid`);
  }
  return text;
}

function cancelBody(response) {
  try {
    const pending = response?.body?.cancel?.();
    pending?.catch?.(() => {});
  } catch {
    // Best-effort cancellation only.
  }
}

/**
 * @param {{
 *   baseUrl: string,
 *   keyring?: object|string,
 *   activeKid?: string,
 *   allowInsecureHttp?: boolean,
 *   fetchImpl?: typeof fetch,
 *   tokenIssuer?: Function,
 *   clock?: () => number,
 *   randomBytes?: (size: number) => Uint8Array,
 *   ttlSeconds?: number,
 *   timeoutMs?: number,
 * }} options
 */
export function createInternalArtifactDownloadTransport(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl, {
    allowInsecureHttp: options.allowInsecureHttp === true,
  });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    fail('SANDBOX_TRANSPORT_CONFIG', 'fetchImpl must be a function');
  }
  if (typeof options.tokenIssuer !== 'function') {
    validateInternalHmacKeyring(options.keyring, options.activeKid);
  }
  const timeoutMs =
    options.timeoutMs ?? DEFAULT_ARTIFACT_DOWNLOAD_TIMEOUT_MS;
  positiveSafeInteger(timeoutMs, 'timeoutMs');

  return Object.freeze({
    async downloadArtifact(input, requestOptions = {}) {
      const normalized = normalizeInput(input);
      const wireBody = {
        artifactId: normalized.artifactId,
        identity: normalized.identity,
      };
      const body = Buffer.from(JSON.stringify(wireBody), 'utf8');
      const bodySha256 = createHash('sha256').update(body).digest('hex');
      const operationId = `${normalized.artifactId}:${ARTIFACT_DOWNLOAD_TOOL}`;
      const claims = {
        org_id: normalized.identity.orgId,
        user_id: normalized.identity.userId,
        conversation_id: normalized.identity.conversationId,
        agent_session_id: normalized.identity.agentSessionId,
        sandbox_session_id: normalized.identity.sandboxSessionId,
        run_id: normalized.identity.runId,
        tool_execution_id: operationId,
        tool_call_id: operationId,
        tool_name: ARTIFACT_DOWNLOAD_TOOL,
        scope: [ARTIFACT_DOWNLOAD_SCOPE],
        request_hash: bodySha256,
        execution_fence_token: normalized.identity.executionFenceToken,
        trace_id: normalized.identity.traceId,
        htm: 'POST',
        htu: ARTIFACT_DOWNLOAD_HTU,
        body_sha256: bodySha256,
      };
      const token =
        typeof options.tokenIssuer === 'function'
          ? await options.tokenIssuer(claims, { bodyBytes: body, bodySha256 })
          : issueInternalToken({
              keyring: options.keyring,
              activeKid: options.activeKid,
              clock: options.clock,
              randomBytes: options.randomBytes,
              ttlSeconds: options.ttlSeconds,
              claims,
            });

      const controller = new AbortController();
      const callerSignal = requestOptions.signal;
      const onCallerAbort = () => controller.abort();
      if (callerSignal?.aborted) controller.abort();
      else callerSignal?.addEventListener?.('abort', onCallerAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${ARTIFACT_DOWNLOAD_HTU}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': String(body.byteLength),
            ...createTraceHeaders(normalized.identity.traceId, {
              randomBytes: options.spanRandomBytes,
              // A2A byte delivery is request-scoped. Prefer the carrier that
              // arrived with this call, while retaining the factory default
              // for existing run-scoped callers.
              traceState:
                requestOptions.traceState ?? options.traceState,
            }),
          },
          body,
          signal: controller.signal,
        });
      } catch (cause) {
        fail(
          'SANDBOX_ARTIFACT_DOWNLOAD_UNAVAILABLE',
          'Sandbox artifact download unavailable',
          { cause, retryable: true },
        );
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener?.('abort', onCallerAbort);
      }

      if (!response?.ok) {
        cancelBody(response);
        const status = Number(response?.status) || 502;
        fail(
          status === 404
            ? 'ARTIFACT_NOT_FOUND'
            : 'SANDBOX_ARTIFACT_DOWNLOAD_FAILED',
          'Sandbox artifact download failed',
          { httpStatus: status, retryable: status >= 500 },
        );
      }
      if (!response.body) {
        fail('SANDBOX_RESPONSE_INVALID', 'Sandbox response body missing');
      }

      const responseArtifactId = responseHeader(response, 'x-artifact-id');
      const responseSha256 = String(
        responseHeader(response, 'x-artifact-sha256') || '',
      ).toLowerCase();
      const contentLengthText = responseHeader(response, 'content-length');
      if (responseArtifactId !== normalized.artifactId) {
        cancelBody(response);
        fail('SANDBOX_RESPONSE_INVALID', 'artifact id binding mismatch');
      }
      if (
        !SHA256_RE.test(responseSha256) ||
        responseSha256 !== normalized.expectedSha256
      ) {
        cancelBody(response);
        fail('SANDBOX_RESPONSE_INVALID', 'artifact digest binding mismatch');
      }
      if (!/^(0|[1-9][0-9]*)$/.test(contentLengthText || '')) {
        cancelBody(response);
        fail('SANDBOX_RESPONSE_INVALID', 'content length invalid');
      }
      const contentLength = Number(contentLengthText);
      if (
        !Number.isSafeInteger(contentLength) ||
        (normalized.expectedSizeBytes !== null &&
          contentLength !== normalized.expectedSizeBytes)
      ) {
        cancelBody(response);
        fail('SANDBOX_RESPONSE_INVALID', 'artifact size binding mismatch');
      }

      return {
        body: response.body,
        contentType:
          responseHeader(response, 'content-type') ||
          'application/octet-stream',
        contentLength,
        contentDisposition: responseHeader(response, 'content-disposition'),
        sha256: responseSha256,
      };
    },
  });
}
