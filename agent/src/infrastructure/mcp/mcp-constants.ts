/**
 * Shared constants, patterns, and the error type for the MCP boundary.
 *
 * Their own module so the deployment-registry parser can depend on them
 * without a cycle.
 */

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export class PiMcpAdapterError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: Loose;
  details: Loose;

  constructor(message: string, opts: { code?: string, details?: Record<string, any>, cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'PiMcpAdapterError';
    this.code = opts.code ?? 'PI_MCP_ADAPTER_ERROR';
    this.details = opts.details ?? undefined;
  }
}

/** Allowed values for MCP_SERVERS_JSON[].transport (url servers only). */
export const MCP_TRANSPORT_VALUES = Object.freeze([
  'streamable-http',
  'sse',
  'auto',
]);


export const SERVER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
export const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SENSITIVE_QUERY_KEY = /(?:token|secret|password|api[_-]?key|authorization)/i;
