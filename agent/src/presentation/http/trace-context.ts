/**
 * W3C trace context 的严格解析。阶段 C 的 TS 转换。
 *
 * "严格"是本模块的全部意义：traceparent/tracestate 来自外部调用方，
 * 宽松解析等于让别人往我们的追踪树里注入任意内容。每条拒绝规则都对应
 * 规范里的一句话，改这里之前先读规范。
 */
import { randomBytes } from 'node:crypto';

/** 解析出的父级 trace 上下文。 */
export interface TraceparentContext {
  readonly traceId: string;
  readonly parentSpanId: string;
  readonly traceFlags: string;
}

/** 解析后交给下游的完整上下文；没有父级时后两项为 null。 */
export interface RequestTraceContext {
  readonly traceId: string;
  readonly parentSpanId: string | null;
  readonly traceFlags: string | null;
  readonly traceState?: string;
}

/** 只需要读头。用最小结构，测试替身不必实现整个 IncomingMessage。 */
export interface TraceHeaderCarrier {
  readonly headers?: Record<string, string | string[] | undefined> | undefined;
}

/** Strict W3C traceparent parse. */
export function parseTraceparentContext(value: unknown): TraceparentContext | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = value.trim().split('-');
  if (parts.length !== 4) return null;
  const [version, traceId, spanId, flags] = parts as [string, string, string, string];
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
export function parseTracestate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!raw || raw.length > 512 || /[^\x20-\x7e]/.test(raw)) return null;
  const members = raw.split(',');
  if (members.length > 32) return null;
  const keys = new Set<string>();
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

export function parseTraceparent(value: unknown): string | null {
  return parseTraceparentContext(value)?.traceId ?? null;
}

export function resolveRequestTraceContext(
  req: TraceHeaderCarrier,
  bodyTrace?: unknown,
): RequestTraceContext {
  const headers = req.headers || {};
  const parent = parseTraceparentContext(
    headers['traceparent'] || headers['Traceparent'],
  );
  if (parent) {
    const traceState = parseTracestate(
      headers['tracestate'] || headers['Tracestate'] || headers['TraceState'],
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

export function resolveRequestTraceId(req: TraceHeaderCarrier, bodyTrace?: unknown): string {
  return resolveRequestTraceContext(req, bodyTrace).traceId;
}
