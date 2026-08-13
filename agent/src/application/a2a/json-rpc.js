/**
 * JSON-RPC 2.0 helpers for A2A binding (plan §20.2).
 *
 * Standard JSON-RPC codes: -32700 parse, -32600 invalid request,
 * -32601 method not found, -32602 invalid params, -32603 internal.
 *
 * A2A v0.3 application error codes (server range, fixed by protocol):
 *   -32001 Task not found
 *   -32002 Task not cancelable
 *   -32003 Push notification not supported
 *   -32004 Unsupported operation
 *   -32005 Content type not supported
 *   -32006 Invalid agent response
 *   -32007 Authenticated extended card not configured
 *
 * Authentication is expressed via HTTP 401/403. When a JSON-RPC body is still
 * required, enterprise extension codes (-32090+) are used so they never collide
 * with the A2A application codes above.
 */

export const JSON_RPC_VERSION = '2.0';

/** Protocol version this server implements cleanly (no dual-compat shims). */
export const A2A_PROTOCOL_VERSION = '0.3';

export const JSON_RPC_ERROR = Object.freeze({
  PARSE: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL: { code: -32603, message: 'Internal error' },
});

/**
 * A2A v0.3 application error codes (protocol-defined).
 * Do not repurpose these numbers for auth or enterprise semantics.
 */
export const A2A_RPC_ERROR = Object.freeze({
  TASK_NOT_FOUND: { code: -32001, message: 'Task not found' },
  TASK_NOT_CANCELABLE: { code: -32002, message: 'Task not cancelable' },
  PUSH_NOT_SUPPORTED: {
    code: -32003,
    message: 'Push Notification is not supported',
  },
  UNSUPPORTED: { code: -32004, message: 'Unsupported operation' },
  CONTENT_TYPE: { code: -32005, message: 'Content type not supported' },
  INVALID_AGENT_RESPONSE: {
    code: -32006,
    message: 'Invalid agent response',
  },
  AUTHENTICATED_EXTENDED_CARD: {
    code: -32007,
    message: 'Authenticated extended card not configured',
  },
  /** Enterprise extension: authentication failed (prefer HTTP 401). */
  AUTH: { code: -32090, message: 'Authentication failed' },
  /** Enterprise extension: insufficient scope (prefer HTTP 403). */
  FORBIDDEN: { code: -32091, message: 'Forbidden' },
  /** Enterprise extension: safety / resource ceiling. */
  RESOURCE_LIMIT: { code: -32092, message: 'Resource limit exceeded' },
});

/**
 * Canonical method names (plan §20.2 PascalCase) + protocol slash aliases.
 */
export const A2A_METHODS = Object.freeze({
  SEND_MESSAGE: 'SendMessage',
  SEND_STREAMING_MESSAGE: 'SendStreamingMessage',
  GET_TASK: 'GetTask',
  CANCEL_TASK: 'CancelTask',
  SUBSCRIBE_TO_TASK: 'SubscribeToTask',
  LIST_TASKS: 'ListTasks',
});

/** @type {Record<string, string>} */
export const A2A_METHOD_ALIASES = Object.freeze({
  // Plan PascalCase
  SendMessage: A2A_METHODS.SEND_MESSAGE,
  SendStreamingMessage: A2A_METHODS.SEND_STREAMING_MESSAGE,
  GetTask: A2A_METHODS.GET_TASK,
  CancelTask: A2A_METHODS.CANCEL_TASK,
  SubscribeToTask: A2A_METHODS.SUBSCRIBE_TO_TASK,
  ListTasks: A2A_METHODS.LIST_TASKS,
  // A2A JSON-RPC binding (slash form)
  'message/send': A2A_METHODS.SEND_MESSAGE,
  'message/stream': A2A_METHODS.SEND_STREAMING_MESSAGE,
  'tasks/get': A2A_METHODS.GET_TASK,
  'tasks/cancel': A2A_METHODS.CANCEL_TASK,
  'tasks/resubscribe': A2A_METHODS.SUBSCRIBE_TO_TASK,
  'tasks/subscribe': A2A_METHODS.SUBSCRIBE_TO_TASK,
  'tasks/list': A2A_METHODS.LIST_TASKS,
});

/**
 * @param {unknown} method
 * @returns {string | null}
 */
export function normalizeA2aMethod(method) {
  if (typeof method !== 'string' || !method.trim()) return null;
  const m = method.trim();
  return A2A_METHOD_ALIASES[m] || null;
}

/**
 * @param {unknown} body
 * @returns {{
 *   ok: true,
 *   id: string | number | null,
 *   method: string,
 *   params: Record<string, unknown>,
 * } | {
 *   ok: false,
 *   id: string | number | null,
 *   error: { code: number, message: string, data?: unknown },
 * }}
 */
export function parseJsonRpcRequest(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      id: null,
      error: { ...JSON_RPC_ERROR.INVALID_REQUEST },
    };
  }
  const id = 'id' in body ? /** @type {any} */ (body).id : null;
  if (body.jsonrpc !== JSON_RPC_VERSION) {
    return {
      ok: false,
      id,
      error: {
        ...JSON_RPC_ERROR.INVALID_REQUEST,
        data: { reason: 'jsonrpc must be "2.0"' },
      },
    };
  }
  if (typeof body.method !== 'string' || !body.method.trim()) {
    return {
      ok: false,
      id,
      error: {
        ...JSON_RPC_ERROR.INVALID_REQUEST,
        data: { reason: 'method is required' },
      },
    };
  }
  const method = normalizeA2aMethod(body.method);
  if (!method) {
    return {
      ok: false,
      id,
      error: {
        ...JSON_RPC_ERROR.METHOD_NOT_FOUND,
        data: { method: body.method },
      },
    };
  }
  let params = body.params;
  if (params == null) params = {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    return {
      ok: false,
      id,
      error: {
        ...JSON_RPC_ERROR.INVALID_PARAMS,
        data: { reason: 'params must be an object' },
      },
    };
  }
  return {
    ok: true,
    id: id === undefined ? null : id,
    method,
    params: /** @type {Record<string, unknown>} */ (params),
  };
}

/**
 * @param {string | number | null} id
 * @param {unknown} result
 */
export function jsonRpcSuccess(id, result) {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  };
}

/**
 * @param {string | number | null} id
 * @param {{ code: number, message: string, data?: unknown }} error
 */
export function jsonRpcError(id, error) {
  const body = {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: {
      code: error.code,
      message: error.message,
    },
  };
  if (error.data !== undefined) {
    body.error.data = error.data;
  }
  return body;
}

/**
 * Format one SSE frame carrying a JSON-RPC response (plan §20.3).
 *
 * IMPORTANT: do not fall back to result.id (task id) for SSE id — that poisons
 * Last-Event-ID resume as if it were a run_event ULID.
 *
 * @param {object} rpcResponse
 * JSON-RPC A2A streams must not set SSE `event:` — clients discriminate on
 * `result.kind`. The `event` option is kept only for explicit caller use.
 *
 * @param {{ id?: string | number | null, event?: string }} [opts]
 * @returns {string}
 */
export function formatA2aSseRpcFrame(rpcResponse, opts = {}) {
  let id = null;
  if (opts.id != null && String(opts.id).length > 0) {
    id = String(opts.id);
  } else if (rpcResponse?.result?.metadata?.eventId) {
    id = String(rpcResponse.result.metadata.eventId);
  } else if (
    rpcResponse?.result?.metadata?.sequence != null &&
    Number.isSafeInteger(Number(rpcResponse.result.metadata.sequence))
  ) {
    id = String(rpcResponse.result.metadata.sequence);
  }
  // Never use rpcResponse.result.id (task ULID) as SSE id.
  const lines = [];
  if (id != null && id !== '') {
    lines.push(`id: ${id}`);
  }
  if (opts.event) {
    lines.push(`event: ${opts.event}`);
  }
  lines.push(`data: ${JSON.stringify(rpcResponse)}`);
  return `${lines.join('\n')}\n\n`;
}
