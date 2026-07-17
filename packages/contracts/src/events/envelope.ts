/**
 * Platform event envelope schema (plan §15.3).
 *
 * {
 *   "eventId": "01K...",
 *   "eventVersion": 1,
 *   "sequence": 18,
 *   "type": "tool.execution.completed",
 *   "timestamp": "2026-07-18T04:31:22.417Z",
 *   "context": { orgId, userId, conversationId?, agentSessionId?, runId?, traceId, spanId },
 *   "data": {}
 * }
 */

import { isIso8601Utc, isUlid, type Iso8601Utc, type Ulid } from '../ids.ts';
import { isSpanId, isTraceId, normalizeSpanId, normalizeTraceId } from '../context/trace.ts';
import { isPlatformEventType, type PlatformEventType } from './types.ts';

export const PLATFORM_EVENT_VERSION = 1 as const;

export interface PlatformEventContext {
  orgId: Ulid;
  userId: Ulid;
  conversationId?: Ulid;
  agentSessionId?: Ulid;
  runId?: Ulid;
  traceId: string;
  spanId: string;
}

export interface PlatformEventEnvelope<
  TType extends PlatformEventType = PlatformEventType,
  TData extends Record<string, unknown> = Record<string, unknown>,
> {
  eventId: Ulid;
  eventVersion: number;
  sequence: number;
  type: TType;
  timestamp: Iso8601Utc;
  context: PlatformEventContext;
  data: TData;
}

export interface ParseEnvelopeSuccess<T extends PlatformEventEnvelope = PlatformEventEnvelope> {
  ok: true;
  value: T;
}

export interface ParseEnvelopeFailure {
  ok: false;
  errors: string[];
}

export type ParseEnvelopeResult<T extends PlatformEventEnvelope = PlatformEventEnvelope> =
  | ParseEnvelopeSuccess<T>
  | ParseEnvelopeFailure;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalUlid(
  value: unknown,
  field: string,
  errors: string[],
): Ulid | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isUlid(value)) {
    errors.push(`context.${field} must be a ULID`);
    return undefined;
  }
  return value.toUpperCase();
}

export function parsePlatformEventContext(
  input: unknown,
): { ok: true; value: PlatformEventContext } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['context must be an object'] };
  }
  if (!isUlid(input.orgId)) errors.push('context.orgId must be a ULID');
  if (!isUlid(input.userId)) errors.push('context.userId must be a ULID');
  if (typeof input.traceId !== 'string' || !isTraceId(input.traceId)) {
    errors.push('context.traceId must be a 32-char hex W3C trace-id');
  }
  if (typeof input.spanId !== 'string' || !isSpanId(input.spanId)) {
    errors.push('context.spanId must be a 16-char hex W3C span-id');
  }

  const conversationId = optionalUlid(input.conversationId, 'conversationId', errors);
  const agentSessionId = optionalUlid(input.agentSessionId, 'agentSessionId', errors);
  const runId = optionalUlid(input.runId, 'runId', errors);

  if (errors.length > 0) return { ok: false, errors };

  const value: PlatformEventContext = {
    orgId: (input.orgId as string).toUpperCase(),
    userId: (input.userId as string).toUpperCase(),
    traceId: normalizeTraceId(input.traceId as string),
    spanId: normalizeSpanId(input.spanId as string),
  };
  if (conversationId) value.conversationId = conversationId;
  if (agentSessionId) value.agentSessionId = agentSessionId;
  if (runId) value.runId = runId;
  return { ok: true, value };
}

/**
 * Validate a platform event envelope.
 * @param options.strictType when true (default), `type` must be in the catalog.
 */
export function parsePlatformEventEnvelope(
  input: unknown,
  options: { strictType?: boolean } = {},
): ParseEnvelopeResult {
  const strictType = options.strictType !== false;
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['envelope must be an object'] };
  }

  if (!isUlid(input.eventId)) {
    errors.push('eventId must be a ULID');
  }

  if (
    typeof input.eventVersion !== 'number' ||
    !Number.isInteger(input.eventVersion) ||
    input.eventVersion < 1
  ) {
    errors.push('eventVersion must be a positive integer');
  }

  if (
    typeof input.sequence !== 'number' ||
    !Number.isInteger(input.sequence) ||
    input.sequence < 0
  ) {
    errors.push('sequence must be a non-negative integer');
  }

  if (strictType) {
    if (!isPlatformEventType(input.type)) {
      errors.push('type must be a known platform event type');
    }
  } else if (typeof input.type !== 'string' || input.type.length === 0) {
    errors.push('type must be a non-empty string');
  }

  if (!isIso8601Utc(input.timestamp)) {
    errors.push('timestamp must be ISO 8601 UTC');
  }

  const contextResult = parsePlatformEventContext(input.context);
  if (!contextResult.ok) {
    errors.push(...contextResult.errors);
  }

  if (input.data === undefined) {
    // data is required in the schema; empty object is allowed.
    errors.push('data is required (use {} when empty)');
  } else if (!isPlainObject(input.data)) {
    errors.push('data must be an object');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const value: PlatformEventEnvelope = {
    eventId: (input.eventId as string).toUpperCase(),
    eventVersion: input.eventVersion as number,
    sequence: input.sequence as number,
    type: input.type as PlatformEventType,
    timestamp: input.timestamp as string,
    context: contextResult.ok
      ? contextResult.value
      : (undefined as unknown as PlatformEventContext),
    data: input.data as Record<string, unknown>,
  };

  return { ok: true, value };
}

export function isPlatformEventEnvelope(
  input: unknown,
  options?: { strictType?: boolean },
): input is PlatformEventEnvelope {
  return parsePlatformEventEnvelope(input, options).ok;
}

export function makePlatformEventEnvelope<
  TType extends PlatformEventType,
  TData extends Record<string, unknown> = Record<string, unknown>,
>(input: {
  eventId: string;
  sequence: number;
  type: TType;
  timestamp: string;
  context: PlatformEventContext;
  data?: TData;
  eventVersion?: number;
}): PlatformEventEnvelope<TType, TData> {
  const candidate = {
    eventId: input.eventId,
    eventVersion: input.eventVersion ?? PLATFORM_EVENT_VERSION,
    sequence: input.sequence,
    type: input.type,
    timestamp: input.timestamp,
    context: input.context,
    data: (input.data ?? {}) as TData,
  };
  const parsed = parsePlatformEventEnvelope(candidate);
  if (!parsed.ok) {
    throw new Error(`Invalid platform event envelope: ${parsed.errors.join('; ')}`);
  }
  return parsed.value as PlatformEventEnvelope<TType, TData>;
}
