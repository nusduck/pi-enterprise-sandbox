/**
 * W3C Trace Context field constraints (plan §6.2).
 *
 * Spec: https://www.w3.org/TR/trace-context/
 * traceparent = `{version}-{trace-id}-{parent-id}-{trace-flags}`
 */

/** 16-byte trace-id as 32 lowercase hex characters (all-zero invalid). */
export const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** 8-byte span/parent id as 16 lowercase hex characters (all-zero invalid). */
export const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

/** W3C version field (currently only `00` is defined). */
export const TRACEPARENT_VERSION = '00';

export const TRACEPARENT_PATTERN =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export type TraceId = string;
export type SpanId = string;
export type TraceFlags = string;

export interface Traceparent {
  version: string;
  traceId: TraceId;
  spanId: SpanId;
  /** Parent span id equals span id in the header (W3C parent-id). */
  parentId: SpanId;
  flags: TraceFlags;
  /** Raw header value in canonical lowercase form. */
  raw: string;
}

export function isTraceId(value: unknown): value is TraceId {
  return (
    typeof value === 'string' &&
    TRACE_ID_PATTERN.test(value.toLowerCase()) &&
    value.toLowerCase() !== '0'.repeat(32)
  );
}

export function isSpanId(value: unknown): value is SpanId {
  return (
    typeof value === 'string' &&
    SPAN_ID_PATTERN.test(value.toLowerCase()) &&
    value.toLowerCase() !== '0'.repeat(16)
  );
}

export function normalizeTraceId(value: string): TraceId {
  if (!isTraceId(value)) {
    throw new Error('Invalid W3C trace-id');
  }
  return value.toLowerCase();
}

export function normalizeSpanId(value: string): SpanId {
  if (!isSpanId(value)) {
    throw new Error('Invalid W3C span-id');
  }
  return value.toLowerCase();
}

export function parseTraceparent(header: unknown): Traceparent | null {
  if (typeof header !== 'string') return null;
  const trimmed = header.trim().toLowerCase();
  const match = TRACEPARENT_PATTERN.exec(trimmed);
  if (!match) return null;

  const [, version, traceId, parentId, flags] = match;
  if (version !== TRACEPARENT_VERSION) return null;
  if (!isTraceId(traceId) || !isSpanId(parentId)) return null;
  if (!/^[0-9a-f]{2}$/.test(flags)) return null;

  return {
    version,
    traceId,
    spanId: parentId,
    parentId,
    flags,
    raw: `${version}-${traceId}-${parentId}-${flags}`,
  };
}

export function formatTraceparent(input: {
  traceId: string;
  spanId: string;
  flags?: string;
  version?: string;
}): string {
  const version = (input.version ?? TRACEPARENT_VERSION).toLowerCase();
  const traceId = normalizeTraceId(input.traceId);
  const spanId = normalizeSpanId(input.spanId);
  const flags = (input.flags ?? '01').toLowerCase();
  if (!/^[0-9a-f]{2}$/.test(flags)) {
    throw new Error('Invalid W3C trace-flags');
  }
  if (version !== TRACEPARENT_VERSION) {
    throw new Error('Unsupported W3C traceparent version');
  }
  return `${version}-${traceId}-${spanId}-${flags}`;
}

/**
 * Generate a random 32-hex trace id (non-crypto-critical; Node crypto preferred when available).
 * Kept dependency-free for contract package portability.
 */
export function generateTraceId(randomBytes?: (size: number) => Uint8Array): TraceId {
  const bytes = randomBytes?.(16) ?? defaultRandomBytes(16);
  let hex = bytesToHex(bytes);
  if (hex === '0'.repeat(32)) {
    hex = '1'.padStart(32, '0');
  }
  return hex;
}

export function generateSpanId(randomBytes?: (size: number) => Uint8Array): SpanId {
  const bytes = randomBytes?.(8) ?? defaultRandomBytes(8);
  let hex = bytesToHex(bytes);
  if (hex === '0'.repeat(16)) {
    hex = '1'.padStart(16, '0');
  }
  return hex;
}

function defaultRandomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < size; i += 1) {
    out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}
