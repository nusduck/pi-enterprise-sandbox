/** W3C Trace Context parsing and request-scoped propagation helpers. */

import { randomBytes as cryptoRandomBytes } from 'node:crypto';

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const TRACESTATE_KEY_RE = /^[a-z][a-z0-9_*/-]{0,255}$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

export const REQUEST_TRACE_CONTEXT: unique symbol = Symbol.for(
  'pi-enterprise.request-trace-context',
);

export interface Traceparent {
  readonly version: string;
  readonly traceId: string;
  readonly parentSpanId: string;
  readonly traceFlags: string;
}

export interface RequestTraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly traceFlags: string;
  readonly tracestate: string | null;
}

export function normalizeTraceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return TRACE_ID_RE.test(normalized) && normalized !== ZERO_TRACE_ID
    ? normalized
    : null;
}

export function parseTraceparent(value: unknown): Traceparent | null {
  if (typeof value !== 'string') return null;
  const match = TRACEPARENT_RE.exec(value.trim());
  if (!match || !match[1] || !match[2] || !match[3] || !match[4]) return null;
  const version = match[1].toLowerCase();
  const traceId = match[2].toLowerCase();
  const parentSpanId = match[3].toLowerCase();
  const traceFlags = match[4].toLowerCase();
  if (
    version === 'ff' ||
    traceId === ZERO_TRACE_ID ||
    parentSpanId === ZERO_SPAN_ID
  ) {
    return null;
  }
  return Object.freeze({ version, traceId, parentSpanId, traceFlags });
}

/**
 * Validate an opaque tracestate without rewriting vendor values. Invalid state
 * is dropped rather than forwarded into an internal request.
 */
export function normalizeTracestate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 512 || /[^\x20-\x7e]/.test(raw)) return null;
  const members = raw.split(',');
  if (members.length > 32) return null;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const memberRaw of members) {
    const member = memberRaw.trim();
    const separator = member.indexOf('=');
    if (separator <= 0 || separator === member.length - 1) return null;
    const key = member.slice(0, separator);
    const memberValue = member.slice(separator + 1);
    if (
      !TRACESTATE_KEY_RE.test(key) ||
      memberValue.length > 256 ||
      /[,=]/.test(memberValue) ||
      memberValue.startsWith(' ') ||
      memberValue.endsWith(' ')
    ) {
      return null;
    }
    if (seen.has(key)) return null;
    seen.add(key);
    normalized.push(`${key}=${memberValue}`);
  }
  return normalized.join(',');
}

function newNonZeroHex(
  size: number,
  randomBytes: (size: number) => Uint8Array,
): string {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const bytes = randomBytes(size);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
      throw new Error(`trace random source must return exactly ${size} bytes`);
    }
    const value = Buffer.from(bytes).toString('hex');
    if (!/^0+$/.test(value)) return value;
  }
  throw new Error('trace random source returned only zero identifiers');
}

export function createTraceId(options: { randomBytes?: (size: number) => Uint8Array } = {}): string {
  return newNonZeroHex(16, options.randomBytes ?? cryptoRandomBytes);
}

/**
 * Resolve the browser carrier and create the BFF request span. The resulting
 * traceparent is the parent carrier for all internal calls made by this request.
 */
export function resolveRequestTraceContext(
  headers: Record<string, unknown> = {},
  options: { randomBytes?: (size: number) => Uint8Array } = {},
): RequestTraceContext {
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  const incoming = parseTraceparent(
    headers.traceparent ?? headers.Traceparent ?? headers.TraceParent,
  );
  const traceId =
    incoming?.traceId ??
    normalizeTraceId(headers['x-trace-id'] ?? headers['X-Trace-Id']) ??
    newNonZeroHex(16, randomBytes);
  const spanId = newNonZeroHex(8, randomBytes);
  const tracestate = incoming
    ? normalizeTracestate(headers.tracestate ?? headers.Tracestate ?? headers.TraceState)
    : null;
  return Object.freeze({
    traceId,
    spanId,
    parentSpanId: incoming?.parentSpanId ?? null,
    traceFlags: incoming?.traceFlags ?? '01',
    tracestate,
  });
}

export function formatTraceparent(context: { traceId?: unknown; spanId?: unknown; traceFlags?: unknown } | null | undefined): string {
  const traceId = normalizeTraceId(context?.traceId);
  const spanId = String(context?.spanId || '').toLowerCase();
  const traceFlags = String(context?.traceFlags || '01').toLowerCase();
  if (!traceId || !SPAN_ID_RE.test(spanId) || spanId === ZERO_SPAN_ID) {
    throw new Error('trace context contains an invalid trace or span id');
  }
  if (!/^[0-9a-f]{2}$/.test(traceFlags)) {
    throw new Error('trace context contains invalid trace flags');
  }
  return `00-${traceId}-${spanId}-${traceFlags}`;
}

export function bindRequestTraceContext<T extends object>(target: T, context: RequestTraceContext | null | undefined): T {
  if (!target || typeof target !== 'object' || !context) return target;
  Object.defineProperty(target, REQUEST_TRACE_CONTEXT, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: context,
  });
  return target;
}

export function boundRequestTraceContext(target: unknown): RequestTraceContext | null {
  return target && typeof target === 'object'
    ? ((target as Record<symbol, any>)[REQUEST_TRACE_CONTEXT] as RequestTraceContext | undefined) ?? null
    : null;
}

export function traceCarrierHeaders(context: any): Record<string, string> {
  if (!context || typeof context !== 'object') return {};
  const traceparent = formatTraceparent(context);
  const traceId = normalizeTraceId(context.traceId);
  const tracestate = normalizeTracestate(context.tracestate);
  return {
    traceparent,
    ...(traceId ? { 'X-Trace-Id': traceId } : {}),
    ...(tracestate ? { tracestate } : {}),
  };
}

