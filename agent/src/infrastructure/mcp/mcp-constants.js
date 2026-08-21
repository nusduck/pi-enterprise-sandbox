/**
 * Shared constants, patterns, and the error type for the MCP boundary.
 *
 * Their own module so the factory, the deployment-registry parser, and the
 * tool-schema validator can all depend on them without a cycle.
 */

export class PiMcpAdapterError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, details?: object, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'PiMcpAdapterError';
    this.code = opts.code ?? 'PI_MCP_ADAPTER_ERROR';
    this.details = opts.details ?? undefined;
  }
}

export const PI_MCP_ADAPTER_PACKAGE = 'pi-mcp-adapter';
export const PINNED_PI_MCP_ADAPTER_VERSION = '2.11.0';

/** Parallel discovery workers (A5): avoid one hung server blocking all others. */
export const MCP_DISCOVERY_DEFAULT_CONCURRENCY = 4;
/** Overall discovery budget for process readiness (A5). */
export const MCP_DISCOVERY_DEFAULT_OVERALL_TIMEOUT_MS = 60_000;
/** Per-server discovery hard cap (A5); min()'d with server requestTimeoutMs. */
export const MCP_DISCOVERY_DEFAULT_PER_SERVER_TIMEOUT_MS = 15_000;
/**
 * Per-server connect attempts during discovery. Streamable-HTTP servers that
 * briefly fail probe then fall through to SSE (405) need a second chance —
 * cold start / DNS / concurrent probe races are common at worker boot.
 */
export const MCP_DISCOVERY_DEFAULT_PER_SERVER_ATTEMPTS = 3;
/** Delay between per-server discovery attempts (ms), multiplied by attempt index. */
export const MCP_DISCOVERY_DEFAULT_RETRY_BACKOFF_MS = 750;
/** Bound args JSON size before MCP dispatch (A4). */
export const MCP_TOOL_ARGS_MAX_JSON_BYTES = 256 * 1024;
/** Bound result JSON size after await, before deep redact (A4). */
export const MCP_TOOL_RESULT_MAX_JSON_BYTES = 1024 * 1024;
/** Model-facing MCP tool description budget (untrusted server text). */
export const MCP_TOOL_DESCRIPTION_MAX_CHARS = 2_000;
/** Short prompt snippet derived from the server description. */
export const MCP_TOOL_SNIPPET_MAX_CHARS = 160;

/** Allowed values for MCP_SERVERS_JSON[].transport (url servers only). */
export const MCP_TRANSPORT_VALUES = Object.freeze([
  'streamable-http',
  'sse',
  'auto',
]);


export const SECRET_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SERVER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
export const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SENSITIVE_QUERY_KEY = /(?:token|secret|password|api[_-]?key|authorization)/i;
export const RESERVED_TRACE_HEADER_NAMES = new Set([
  'traceparent',
  'tracestate',
  'x-trace-id',
]);
export const RESERVED_TRACE_ENV_NAMES = new Set([
  'traceparent',
  'tracestate',
  'trace_id',
  'trace_state',
]);

export const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
