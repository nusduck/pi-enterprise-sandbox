/** W3C Trace Context parsing and request-scoped propagation helpers. */

import { randomBytes as cryptoRandomBytes } from 'node:crypto';

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const TRACESTATE_KEY_RE = /^[a-z][a-z0-9_*/-]{0,255}$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

export const REQUEST_TRACE_CONTEXT = Symbol.for(
  'pi-enterprise.request-trace-context',
);

/** @param {unknown} value */
export function normalizeTraceId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return TRACE_ID_RE.test(normalized) && normalized !== ZERO_TRACE_ID
    ? normalized
    : null;
}

/** @param {unknown} value */
export function parseTraceparent(value) {
  if (typeof value !== 'string') return null;
  const match = TRACEPARENT_RE.exec(value.trim());
  if (!match) return null;
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
 * @param {unknown} value
 */
export function normalizeTracestate(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 512 || /[^\x20-\x7e]/.test(raw)) return null;
  const members = raw.split(',');
  if (members.length > 32) return null;
  const seen = new Set();
  const normalized = [];
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

/** @param {(size: number) => Uint8Array} randomBytes */
function newNonZeroHex(size, randomBytes) {
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

/** @param {{ randomBytes?: (size: number) => Uint8Array }} [options] */
export function createTraceId(options = {}) {
  return newNonZeroHex(16, options.randomBytes ?? cryptoRandomBytes);
}

/**
 * Resolve the browser carrier and create the BFF request span. The resulting
 * traceparent is the parent carrier for all internal calls made by this request.
 * @param {Record<string, unknown>} headers
 * @param {{ randomBytes?: (size: number) => Uint8Array }} [options]
 */
export function resolveRequestTraceContext(headers = {}, options = {}) {
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

/** @param {{ traceId: string, spanId: string, traceFlags?: string }} context */
export function formatTraceparent(context) {
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

/** @param {object} target @param {object|null|undefined} context */
export function bindRequestTraceContext(target, context) {
  if (!target || typeof target !== 'object' || !context) return target;
  Object.defineProperty(target, REQUEST_TRACE_CONTEXT, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: context,
  });
  return target;
}

/** @param {unknown} target */
export function boundRequestTraceContext(target) {
  return target && typeof target === 'object'
    ? target[REQUEST_TRACE_CONTEXT] ?? null
    : null;
}

/** @param {unknown} context */
export function traceCarrierHeaders(context) {
  if (!context || typeof context !== 'object') return {};
  const traceparent = formatTraceparent(context);
  const traceId = normalizeTraceId(context.traceId);
  const tracestate = normalizeTracestate(context.tracestate);
  return {
    traceparent,
    'X-Trace-Id': traceId,
    ...(tracestate ? { tracestate } : {}),
  };
}
