import { randomBytes } from 'node:crypto';

/**
 * Strict W3C traceparent parse.
 * @param {unknown} value
 */
export function parseTraceparentContext(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = value.trim().split('-');
  if (parts.length !== 4) return null;
  const [version, traceId, spanId, flags] = parts;
  if (!/^[0-9a-fA-F]{2}$/.test(version) || version.toLowerCase() === 'ff') {
    return null;
  }
  if (
    !/^[0-9a-fA-F]{32}$/.test(traceId) ||
    traceId.toLowerCase() === '0'.repeat(32)
  ) {
    return null;
  }
  if (
    !/^[0-9a-fA-F]{16}$/.test(spanId) ||
    spanId.toLowerCase() === '0'.repeat(16)
  ) {
    return null;
  }
  if (!/^[0-9a-fA-F]{2}$/.test(flags)) return null;
  return {
    traceId: traceId.toLowerCase(),
    parentSpanId: spanId.toLowerCase(),
    traceFlags: flags.toLowerCase(),
  };
}

/** Keep the vendor list opaque while rejecting malformed members. */
export function parseTracestate(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 512 || /[^\x20-\x7e]/.test(raw)) return null;
  const members = raw.split(',');
  if (members.length > 32) return null;
  const keys = new Set();
  for (const part of members) {
    const member = part.trim();
    const separator = member.indexOf('=');
    const key = separator > 0 ? member.slice(0, separator) : '';
    const memberValue = separator > 0 ? member.slice(separator + 1) : '';
    if (
      !/^[a-z][a-z0-9_*/-]{0,255}$/.test(key) ||
      !memberValue ||
      memberValue.length > 256 ||
      /[,=]/.test(memberValue) ||
      memberValue.startsWith(' ') ||
      memberValue.endsWith(' ') ||
      keys.has(key)
    ) {
      return null;
    }
    keys.add(key);
  }
  return members.map((part) => part.trim()).join(',');
}

export function parseTraceparent(value) {
  return parseTraceparentContext(value)?.traceId ?? null;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {unknown} [bodyTrace]
 */
export function resolveRequestTraceContext(req, bodyTrace) {
  const headers = req.headers || {};
  const parent = parseTraceparentContext(
    headers.traceparent || headers.Traceparent,
  );
  if (parent) {
    const traceState = parseTracestate(
      headers.tracestate || headers.Tracestate || headers.TraceState,
    );
    return {
      ...parent,
      ...(traceState ? { traceState } : {}),
    };
  }

  const fallback =
    headers['x-trace-id'] ||
    headers['X-Trace-Id'] ||
    (typeof bodyTrace === 'string' ? bodyTrace : null);
  if (typeof fallback === 'string' && /^[0-9a-fA-F]{32}$/.test(fallback.trim())) {
    const traceId = fallback.trim().toLowerCase();
    if (traceId !== '0'.repeat(32)) {
      return {
        traceId,
        parentSpanId: null,
        traceFlags: null,
      };
    }
  }
  return {
    traceId: randomBytes(16).toString('hex'),
    parentSpanId: null,
    traceFlags: null,
  };
}

export function resolveRequestTraceId(req, bodyTrace) {
  return resolveRequestTraceContext(req, bodyTrace).traceId;
}
