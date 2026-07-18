/**
 * Sandbox transport port (PR-06 B1 / PR-07B batch 1).
 *
 * Explicit injection only via deps.sandboxTransport — never legacy
 * browser-Bearer sandbox-client. Missing methods fail closed with
 * SANDBOX_TRANSPORT_UNAVAILABLE at extension load.
 *
 * Run identity includes executionFenceToken as a positive finite integer
 * (number type preserved). Every transport call also carries toolCallId
 * as a top-level correlation field (not model-schema visible).
 */

/** Methods required for full 10-tool coverage. */
export const SANDBOX_TRANSPORT_METHODS = Object.freeze([
  'readFile',
  'writeFile',
  'editFile',
  'bash',
  'python',
  'processStart',
  'processStatus',
  'processRead',
  'processKill',
  'submitArtifact',
]);

/** Optional methods (skill read). Absence → skill read returns unsupported. */
export const SANDBOX_TRANSPORT_OPTIONAL = Object.freeze(['readSkill']);

/** String identity fields required on every transport call. */
export const RUN_TRANSPORT_STRING_IDENTITY_KEYS = Object.freeze([
  'orgId',
  'userId',
  'conversationId',
  'agentSessionId',
  'runId',
  'sandboxSessionId',
  'traceId',
]);

/**
 * All identity keys including numeric fence (order stable for docs/tests).
 * @type {readonly string[]}
 */
export const RUN_TRANSPORT_IDENTITY_KEYS = Object.freeze([
  ...RUN_TRANSPORT_STRING_IDENTITY_KEYS,
  'executionFenceToken',
]);

/** Max length for transport toolCallId correlation field. */
export const MAX_TOOL_CALL_ID_LEN = 255;

/**
 * @param {string} code
 * @param {string} message
 * @param {object} [details]
 */
function identityError(code, message, details) {
  const err = new Error(`${code}: ${message}`);
  /** @type {any} */ (err).code = code;
  if (details) /** @type {any} */ (err).details = details;
  return err;
}

/**
 * Positive finite integer fence — no coercion of strings/floats/NaN.
 * Rejects 0, negative, non-integer, non-number.
 *
 * @param {unknown} token
 * @param {string} [field]
 * @returns {number}
 */
export function assertPositiveExecutionFenceToken(
  token,
  field = 'executionFenceToken',
) {
  if (typeof token !== 'number') {
    throw identityError(
      'RUN_IDENTITY_INVALID',
      `runContext.${field} must be a positive finite integer number`,
      { field, gotType: typeof token },
    );
  }
  if (!Number.isFinite(token) || !Number.isInteger(token) || token <= 0) {
    throw identityError(
      'RUN_IDENTITY_INVALID',
      `runContext.${field} must be a positive finite integer`,
      { field },
    );
  }
  return token;
}

/**
 * Fail-closed identity validation. Rejects null/undefined and the strings
 * "null" / "undefined" from accidental String(null) coercion.
 * executionFenceToken is validated as a positive finite integer number.
 *
 * @param {unknown} runContext
 * @returns {{ [k: string]: string | number }}
 */
export function assertRunTransportIdentity(runContext) {
  if (
    !runContext ||
    typeof runContext !== 'object' ||
    Array.isArray(runContext)
  ) {
    throw identityError(
      'RUN_IDENTITY_REQUIRED',
      'runContext object is required for sandbox transport identity',
    );
  }
  const ctx = /** @type {Record<string, unknown>} */ (runContext);
  /** @type {Record<string, string | number>} */
  const out = {};
  for (const key of RUN_TRANSPORT_STRING_IDENTITY_KEYS) {
    if (!(key in ctx)) {
      throw identityError(
        'RUN_IDENTITY_REQUIRED',
        `runContext.${key} is required`,
        { field: key },
      );
    }
    const raw = ctx[key];
    if (raw == null) {
      throw identityError(
        'RUN_IDENTITY_REQUIRED',
        `runContext.${key} must be a non-empty value (got null/undefined)`,
        { field: key },
      );
    }
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      throw identityError(
        'RUN_IDENTITY_INVALID',
        `runContext.${key} must be a string`,
        { field: key },
      );
    }
    const s = String(raw).trim();
    if (!s || s === 'null' || s === 'undefined') {
      throw identityError(
        'RUN_IDENTITY_REQUIRED',
        `runContext.${key} must be a non-empty identity value`,
        { field: key },
      );
    }
    out[key] = s;
  }

  if (!('executionFenceToken' in ctx)) {
    throw identityError(
      'RUN_IDENTITY_REQUIRED',
      'runContext.executionFenceToken is required',
      { field: 'executionFenceToken' },
    );
  }
  out.executionFenceToken = assertPositiveExecutionFenceToken(
    ctx.executionFenceToken,
  );
  return out;
}

/**
 * Validate toolCallId for transport correlation BEFORE any transport call.
 * - must be a string (reject numbers/null)
 * - already trimmed (reject leading/trailing whitespace; do not canonicalize)
 * - non-empty, max MAX_TOOL_CALL_ID_LEN
 *
 * @param {unknown} toolCallId
 * @returns {{ ok: true, toolCallId: string } | { ok: false, code: string, reason: string }}
 */
export function normalizeTransportToolCallId(toolCallId) {
  if (typeof toolCallId !== 'string') {
    return {
      ok: false,
      code: 'TOOL_CALL_ID_INVALID',
      reason: 'toolCallId must be a non-empty string',
    };
  }
  if (toolCallId.length === 0) {
    return {
      ok: false,
      code: 'TOOL_CALL_ID_INVALID',
      reason: 'toolCallId must be non-empty',
    };
  }
  if (toolCallId !== toolCallId.trim()) {
    return {
      ok: false,
      code: 'TOOL_CALL_ID_INVALID',
      reason:
        'toolCallId must not have leading or trailing whitespace',
    };
  }
  if (toolCallId.length > MAX_TOOL_CALL_ID_LEN) {
    return {
      ok: false,
      code: 'TOOL_CALL_ID_INVALID',
      reason: `toolCallId exceeds max length ${MAX_TOOL_CALL_ID_LEN}`,
    };
  }
  return { ok: true, toolCallId };
}

/**
 * @param {unknown} toolCallId
 * @returns {string}
 */
export function assertTransportToolCallId(toolCallId) {
  const r = normalizeTransportToolCallId(toolCallId);
  if (!r.ok) {
    throw identityError(r.code, r.reason, { field: 'toolCallId' });
  }
  return r.toolCallId;
}

/**
 * Claim / request-hash fields required on every Sandbox transport call
 * after Agent-side bind (PR-07B batch 2B). Applied last so model params
 * cannot override identity or hash fields.
 * @type {readonly string[]}
 */
export const TRANSPORT_CLAIM_KEYS = Object.freeze([
  'toolExecutionId',
  'toolCallId',
  'requestHash',
  'requestHashVersion',
]);

/**
 * Build transport payload with frozen identity + claim fields last so
 * model-supplied params cannot override identity/fence/toolCallId/hash.
 *
 * Top-level claim fields (required after bind):
 *   toolExecutionId, toolCallId, requestHash, requestHashVersion
 * Plus authoritative identity (org/user/conversation/agentSession/
 * sandboxSession/run/fence/trace) under `identity`.
 *
 * @param {Readonly<object>} identity
 * @param {string} toolCallId
 * @param {object} [params]
 * @param {{
 *   toolExecutionId: string,
 *   requestHash: string,
 *   requestHashVersion: number,
 * }} [claim]
 */
export function buildTransportCallPayload(
  identity,
  toolCallId,
  params = {},
  claim = undefined,
) {
  /** @type {Record<string, unknown>} */
  const payload = {
    ...params,
    identity,
    toolCallId,
  };
  if (claim != null) {
    payload.toolExecutionId = claim.toolExecutionId;
    payload.toolCallId = toolCallId;
    payload.requestHash = claim.requestHash;
    payload.requestHashVersion = claim.requestHashVersion;
  }
  return payload;
}

/**
 * @param {unknown} transport
 * @param {string[]} [required]
 */
export function assertSandboxTransport(
  transport,
  required = SANDBOX_TRANSPORT_METHODS,
) {
  if (!transport || typeof transport !== 'object') {
    const err = new Error(
      'SANDBOX_TRANSPORT_UNAVAILABLE: sandboxTransport was not injected',
    );
    /** @type {any} */ (err).code = 'SANDBOX_TRANSPORT_UNAVAILABLE';
    throw err;
  }
  const missing = required.filter(
    (m) => typeof /** @type {any} */ (transport)[m] !== 'function',
  );
  if (missing.length) {
    const err = new Error(
      `SANDBOX_TRANSPORT_UNAVAILABLE: transport missing methods: ${missing.join(', ')}`,
    );
    /** @type {any} */ (err).code = 'SANDBOX_TRANSPORT_UNAVAILABLE';
    /** @type {any} */ (err).missing = missing;
    throw err;
  }
  return transport;
}

/**
 * Frozen identity for every transport call — model params cannot override.
 * Fail-closed if any required field is missing/null/"null".
 * executionFenceToken remains a number (positive finite integer).
 *
 * @param {object} runContext
 */
export function buildTransportIdentity(runContext) {
  const id = assertRunTransportIdentity(runContext);
  return Object.freeze({
    orgId: /** @type {string} */ (id.orgId),
    userId: /** @type {string} */ (id.userId),
    conversationId: /** @type {string} */ (id.conversationId),
    agentSessionId: /** @type {string} */ (id.agentSessionId),
    runId: /** @type {string} */ (id.runId),
    sandboxSessionId: /** @type {string} */ (id.sandboxSessionId),
    traceId: /** @type {string} */ (id.traceId),
    executionFenceToken: /** @type {number} */ (id.executionFenceToken),
  });
}

/**
 * @param {object} transport
 * @param {string} method
 * @param {object} payload
 */
export async function callTransport(transport, method, payload) {
  if (!transport || typeof transport[method] !== 'function') {
    const err = new Error(
      `SANDBOX_TRANSPORT_UNAVAILABLE: method ${method} not available`,
    );
    /** @type {any} */ (err).code = 'SANDBOX_TRANSPORT_UNAVAILABLE';
    throw err;
  }
  return transport[method](payload);
}
