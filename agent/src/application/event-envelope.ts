/**
 * 规范 Run 事件信封与入库前脱敏（纯函数）。
 *
 * 从 `fenced-run-event-recorder.ts` 搬出：6 个应用层模块只需要这两个纯函数，
 * 不需要 recorder 类（事务/围栏/去重）。recorder 本体改从这里 import，
 * 调用方直接引用本模块，不再经 recorder / dsh-run-executor / index.ts 转手。
 */

import {
  redactInlineSecrets,
  redactPayload,
} from '../lib/event-redaction.js';

export type RunEventContext = {
  orgId: string;
  userId: string;
  conversationId: string;
  agentSessionId: string;
  runId: string;
  traceId: string;
  sandboxSessionId?: string | null;
};

export type CanonicalRunEventEnvelope = {
  eventId: string;
  eventVersion: number;
  sequence: number;
  type: string;
  timestamp: string;
  context: {
    orgId: string;
    userId: string;
    conversationId: string;
    agentSessionId: string;
    runId: string;
    traceId: string;
    spanId: string | null;
    sandboxSessionId?: string | null;
  };
  data: Record<string, unknown>;
};

/**
 * Build plan §15.3 envelope (pure).
 *
 * @param {{
 *   eventId: string,
 *   sequence: number,
 *   type: string,
 *   timestamp: string | Date,
 *   context: RunEventContext & { spanId?: string | null },
 *   data?: Record<string, unknown>,
 *   eventVersion?: number,
 * }} input
 * @returns {CanonicalRunEventEnvelope}
 */
export function buildCanonicalEnvelope(input: { eventId: string, sequence: number, type: string, timestamp: string | Date, context: RunEventContext & { spanId?: string | null }, data?: Record<string, unknown>, eventVersion?: number, }) {
  const ts =
    input.timestamp instanceof Date
      ? input.timestamp.toISOString()
      : String(input.timestamp);
  const ctx = input.context;
  const sandboxSessionId =
    ctx.sandboxSessionId != null && String(ctx.sandboxSessionId).trim()
      ? String(ctx.sandboxSessionId)
      : null;
  return Object.freeze({
    eventId: String(input.eventId),
    eventVersion: input.eventVersion ?? 1,
    sequence: Number(input.sequence),
    type: String(input.type),
    timestamp: ts,
    context: Object.freeze({
      orgId: String(ctx.orgId),
      userId: String(ctx.userId),
      conversationId: String(ctx.conversationId),
      agentSessionId: String(ctx.agentSessionId),
      runId: String(ctx.runId),
      traceId: String(ctx.traceId ?? ''),
      spanId: ctx.spanId != null ? String(ctx.spanId) : null,
      // Browser download/upload/list need the sandbox session ULID. Agent
      // session alone cannot build /api/files/artifact-download URLs.
      ...(sandboxSessionId ? { sandboxSessionId } : {}),
    }),
    data: Object.freeze(
      input.data && typeof input.data === 'object' && !Array.isArray(input.data)
        ? { ...input.data }
        : {},
    ),
  });
}

/**
 * Redact event data for durable storage (secrets never stored).
 *
 * 薄包装，不是 `redactPayload` 的重复：处理信封层才有的三种形状——
 * null → `{}`、字符串 → `{ text }`（行内脱敏）、非对象 → `{ value }`——
 * 对象才走 `redactPayload` 的键级脱敏。
 * @param data
 * @returns {Record<string, unknown>}
 */
export function redactEventData(data: unknown) {
  if (data == null) return {};
  if (typeof data === 'string') {
    return { text: redactInlineSecrets(data) };
  }
  const redacted = redactPayload(data);
  if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
    return (redacted as Record<string, unknown>);
  }
  return { value: redacted };
}
