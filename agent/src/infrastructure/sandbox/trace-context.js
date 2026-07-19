/**
 * Small W3C Trace Context boundary for Agent -> Sandbox requests.
 *
 * The durable trace id is supplied by the run context. Every outbound HTTP
 * request gets a fresh child span id; no request payload or credential is put
 * in the propagation headers.
 */

import { randomBytes as cryptoRandomBytes } from 'node:crypto';

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const ZERO_TRACE_ID = /^0{32}$/;
const TRACESTATE_KEY_RE = /^[a-z][a-z0-9_*/-]{0,255}$/;

/**
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string}
 */
export function assertW3cTraceId(value, field = 'traceId') {
  if (
    typeof value !== 'string' ||
    !TRACE_ID_RE.test(value) ||
    ZERO_TRACE_ID.test(value)
  ) {
    throw new Error(`${field} must be a non-zero lowercase W3C trace id`);
  }
  return value;
}

/** @param {unknown} value @returns {string | null} */
export function normalizeW3cTracestate(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error('traceState must be a W3C tracestate string');
  }
  const raw = value.trim();
  if (!raw || raw.length > 512 || /[^\x20-\x7e]/.test(raw)) {
    throw new Error('traceState must be printable ASCII with at most 512 chars');
  }
  const members = raw.split(',');
  if (members.length > 32) throw new Error('traceState exceeds 32 members');
  const seen = new Set();
  const normalized = [];
  for (const rawMember of members) {
    const member = rawMember.trim();
    const separator = member.indexOf('=');
    if (separator <= 0 || separator === member.length - 1) {
      throw new Error('traceState contains an invalid list member');
    }
    const key = member.slice(0, separator);
    const memberValue = member.slice(separator + 1);
    if (
      !TRACESTATE_KEY_RE.test(key) ||
      memberValue.length > 256 ||
      /[,=]/.test(memberValue) ||
      memberValue.startsWith(' ') ||
      memberValue.endsWith(' ') ||
      seen.has(key)
    ) {
      throw new Error('traceState contains an invalid or duplicate member');
    }
    seen.add(key);
    normalized.push(`${key}=${memberValue}`);
  }
  return normalized.join(',');
}

/**
 * @param {string} traceId
 * @param {{ randomBytes?: (size: number) => Uint8Array }} [options]
 * @returns {string}
 */
export function createW3cTraceparent(traceId, options = {}) {
  const tid = assertW3cTraceId(traceId);
  const randomBytes = options.randomBytes ?? cryptoRandomBytes;
  if (typeof randomBytes !== 'function') {
    throw new Error('trace span randomBytes must be a function');
  }

  // A W3C span id is exactly eight bytes and may not be all zero. Retry a
  // bounded number of times so a deterministic/test RNG cannot hang a call.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const raw = randomBytes(8);
    if (!(raw instanceof Uint8Array) || raw.byteLength !== 8) {
      throw new Error('trace span randomBytes must return exactly 8 bytes');
    }
    const spanId = Buffer.from(raw).toString('hex');
    if (!/^0{16}$/.test(spanId)) {
      return `00-${tid}-${spanId}-01`;
    }
  }
  throw new Error('trace span id generator returned only zero ids');
}

/**
 * @param {string} traceId
 * @param {{ randomBytes?: (size: number) => Uint8Array, traceState?: unknown }} [options]
 * @returns {{ traceparent: string, 'X-Trace-Id': string, tracestate?: string }}
 */
export function createTraceHeaders(traceId, options = {}) {
  const tid = assertW3cTraceId(traceId);
  const traceState = normalizeW3cTracestate(options.traceState);
  return {
    traceparent: createW3cTraceparent(tid, options),
    'X-Trace-Id': tid,
    ...(traceState ? { tracestate: traceState } : {}),
  };
}
