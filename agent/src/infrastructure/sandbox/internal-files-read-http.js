/**
 * Agent → Sandbox internal HTTP transport for POST /internal/v1/files/read.
 *
 * Explicit injection only (base URL, HMAC keyring/active kid or tokenIssuer,
 * fetch, clock, jti/randomBytes, timeouts, maxAttempts). Offline-testable.
 * Production bootstrap injects this transport into sandbox-bridge readFile;
 * no browser Bearer or legacy public route is used for formal reads.
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
import { createTraceHeaders } from './trace-context.js';


import {
  BODY_ROOT_KEYS,
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_RETRYABLE_HTTP_STATUSES,
  DEFAULT_TOTAL_TIMEOUT_MS,
  FILES_READ_HTU,
  FILES_READ_SCOPE,
  FILES_READ_TOOL_NAME,
  IDENTITY_KEYS,
  SKILLS_READ_HTU,
  SKILLS_READ_SCOPE,
  SUCCESS_BINARY_KEYS,
  SUCCESS_TEXT_KEYS,
} from './internal-files-read-constants.js';
import { filterFilesReadSuccessResult } from './internal-files-read-result.js';
import {
  InternalSandboxTransportError,
  fail,
  failOutcomeUnknown,
} from './internal-sandbox-transport-error.js';
import {
  buildFilesReadBodyBytes,
  buildSkillsReadBodyBytes,
  isPlainObject,
  validateAndNormalizeReadFilePayload,
  validateAndNormalizeReadSkillPayload,
} from './internal-files-read-payload.js';

// Re-exported so this module stays the transport's single entry point.
export * from './internal-files-read-constants.js';
export { InternalSandboxTransportError } from './internal-sandbox-transport-error.js';
export { filterFilesReadSuccessResult } from './internal-files-read-result.js';
export {
  buildFilesReadBodyBytes,
  buildSkillsReadBodyBytes,
  validateAndNormalizeReadFilePayload,
  validateAndNormalizeReadSkillPayload,
} from './internal-files-read-payload.js';

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
 *   spanRandomBytes?: (size: number) => Uint8Array,
 * }} options
 */
export function createInternalFilesReadTransport(options) {
  return createInternalReadTransport(options, {
    htu: FILES_READ_HTU,
    scope: FILES_READ_SCOPE,
    buildBody: buildFilesReadBodyBytes,
  });
}

/** Same signed/ledger-bound read protocol, scoped to the read-only Skill mount. */
export function createInternalSkillsReadTransport(options) {
  return createInternalReadTransport(options, {
    htu: SKILLS_READ_HTU,
    scope: SKILLS_READ_SCOPE,
    buildBody: buildSkillsReadBodyBytes,
  });
}

function createInternalReadTransport(options, target) {
  if (!options || typeof options !== 'object') {
    fail('SANDBOX_TRANSPORT_CONFIG', 'options object is required');
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl, {
    allowInsecureHttp: options.allowInsecureHttp === true,
  });
  const url = `${baseUrl}${target.htu}`;
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
      scope: [target.scope],
      request_hash: normalized.requestHash,
      execution_fence_token: normalized.identity.executionFenceToken,
      trace_id: normalized.identity.traceId,
      htm: 'POST',
      htu: target.htu,
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
      target.buildBody(payload);

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
          ...createTraceHeaders(normalized.identity.traceId, {
            randomBytes: options.spanRandomBytes,
            traceState: options.traceState,
          }),
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
