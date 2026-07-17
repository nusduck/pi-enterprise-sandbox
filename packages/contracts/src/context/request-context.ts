/**
 * Full-chain RequestContext contract (plan §6).
 *
 * Required on every external and internal request path so org/user/trace
 * remain auditable end-to-end.
 */

import { isUlid, type Ulid } from '../ids.ts';
import {
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  isSpanId,
  isTraceId,
  normalizeSpanId,
  normalizeTraceId,
  parseTraceparent,
  type SpanId,
  type TraceId,
} from './trace.ts';
import {
  EXTERNAL_CONTEXT_HEADERS,
  getHeader,
  INTERNAL_CONTEXT_HEADERS,
} from './headers.ts';

export const CALLER_TYPES = ['web', 'api', 'a2a', 'worker', 'system'] as const;
export type CallerType = (typeof CALLER_TYPES)[number];

export interface RequestContext {
  orgId: Ulid;
  userId: Ulid;
  conversationId?: Ulid;
  agentSessionId?: Ulid;
  runId?: Ulid;
  sandboxSessionId?: Ulid;
  executionId?: Ulid;
  traceId: TraceId;
  spanId: SpanId;
  requestId: string;
  callerType: CallerType;
  callerId?: string;
}

export interface RequestContextValidation {
  ok: true;
  value: RequestContext;
}

export interface RequestContextValidationFailure {
  ok: false;
  errors: string[];
}

export type RequestContextParseResult =
  | RequestContextValidation
  | RequestContextValidationFailure;

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
    errors.push(`${field} must be a ULID`);
    return undefined;
  }
  return value.toUpperCase();
}

export function isCallerType(value: unknown): value is CallerType {
  return typeof value === 'string' && (CALLER_TYPES as readonly string[]).includes(value);
}

export function parseRequestContext(input: unknown): RequestContextParseResult {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['RequestContext must be an object'] };
  }

  if (!isUlid(input.orgId)) errors.push('orgId must be a ULID');
  if (!isUlid(input.userId)) errors.push('userId must be a ULID');
  if (typeof input.traceId !== 'string' || !isTraceId(input.traceId)) {
    errors.push('traceId must be a 32-char hex W3C trace-id');
  }
  if (typeof input.spanId !== 'string' || !isSpanId(input.spanId)) {
    errors.push('spanId must be a 16-char hex W3C span-id');
  }
  if (typeof input.requestId !== 'string' || input.requestId.length === 0) {
    errors.push('requestId is required');
  }
  if (!isCallerType(input.callerType)) {
    errors.push(`callerType must be one of: ${CALLER_TYPES.join(', ')}`);
  }

  const conversationId = optionalUlid(input.conversationId, 'conversationId', errors);
  const agentSessionId = optionalUlid(input.agentSessionId, 'agentSessionId', errors);
  const runId = optionalUlid(input.runId, 'runId', errors);
  const sandboxSessionId = optionalUlid(input.sandboxSessionId, 'sandboxSessionId', errors);
  const executionId = optionalUlid(input.executionId, 'executionId', errors);

  if (input.callerId !== undefined && input.callerId !== null) {
    if (typeof input.callerId !== 'string' || input.callerId.length === 0) {
      errors.push('callerId must be a non-empty string when present');
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const value: RequestContext = {
    orgId: (input.orgId as string).toUpperCase(),
    userId: (input.userId as string).toUpperCase(),
    traceId: normalizeTraceId(input.traceId as string),
    spanId: normalizeSpanId(input.spanId as string),
    requestId: input.requestId as string,
    callerType: input.callerType as CallerType,
  };

  if (conversationId) value.conversationId = conversationId;
  if (agentSessionId) value.agentSessionId = agentSessionId;
  if (runId) value.runId = runId;
  if (sandboxSessionId) value.sandboxSessionId = sandboxSessionId;
  if (executionId) value.executionId = executionId;
  if (typeof input.callerId === 'string' && input.callerId.length > 0) {
    value.callerId = input.callerId;
  }

  return { ok: true, value };
}

export function isRequestContext(input: unknown): input is RequestContext {
  return parseRequestContext(input).ok;
}

export function assertRequestContext(input: unknown): RequestContext {
  const parsed = parseRequestContext(input);
  if (!parsed.ok) {
    throw new Error(`Invalid RequestContext: ${parsed.errors.join('; ')}`);
  }
  return parsed.value;
}

export function createRequestContext(
  partial: Omit<RequestContext, 'traceId' | 'spanId' | 'requestId'> & {
    traceId?: string;
    spanId?: string;
    requestId?: string;
  },
): RequestContext {
  return assertRequestContext({
    ...partial,
    traceId: partial.traceId ?? generateTraceId(),
    spanId: partial.spanId ?? generateSpanId(),
    requestId: partial.requestId ?? partial.runId ?? generateTraceId().slice(0, 26).toUpperCase(),
  });
}

/**
 * Build internal propagation headers from a validated RequestContext.
 * Does not include Authorization — callers attach service credentials separately.
 */
export function toInternalHeaders(
  context: RequestContext,
  options: { tracestate?: string; flags?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    [INTERNAL_CONTEXT_HEADERS.orgId]: context.orgId,
    [INTERNAL_CONTEXT_HEADERS.userId]: context.userId,
    [INTERNAL_CONTEXT_HEADERS.requestId]: context.requestId,
    [INTERNAL_CONTEXT_HEADERS.traceparent]: formatTraceparent({
      traceId: context.traceId,
      spanId: context.spanId,
      flags: options.flags,
    }),
  };

  if (context.conversationId) {
    headers[INTERNAL_CONTEXT_HEADERS.conversationId] = context.conversationId;
  }
  if (context.agentSessionId) {
    headers[INTERNAL_CONTEXT_HEADERS.agentSessionId] = context.agentSessionId;
  }
  if (context.runId) {
    headers[INTERNAL_CONTEXT_HEADERS.runId] = context.runId;
  }
  if (context.sandboxSessionId) {
    headers[INTERNAL_CONTEXT_HEADERS.sandboxSessionId] = context.sandboxSessionId;
  }
  if (options.tracestate) {
    headers[INTERNAL_CONTEXT_HEADERS.tracestate] = options.tracestate;
  }

  return headers;
}

/**
 * Extract identity + trace fields from internal headers.
 * org/user still must have been set by a trusted service, not the browser.
 */
export function requestContextFromInternalHeaders(
  headers: Record<string, unknown>,
  extras: {
    callerType: CallerType;
    callerId?: string;
    executionId?: string;
    requestIdFallback?: string;
  },
): RequestContextParseResult {
  const orgId = getHeader(headers, INTERNAL_CONTEXT_HEADERS.orgId);
  const userId = getHeader(headers, INTERNAL_CONTEXT_HEADERS.userId);
  const requestId =
    getHeader(headers, INTERNAL_CONTEXT_HEADERS.requestId) ??
    getHeader(headers, EXTERNAL_CONTEXT_HEADERS.requestId) ??
    extras.requestIdFallback;
  const traceparent = parseTraceparent(
    getHeader(headers, INTERNAL_CONTEXT_HEADERS.traceparent),
  );

  return parseRequestContext({
    orgId,
    userId,
    conversationId: getHeader(headers, INTERNAL_CONTEXT_HEADERS.conversationId),
    agentSessionId: getHeader(headers, INTERNAL_CONTEXT_HEADERS.agentSessionId),
    runId: getHeader(headers, INTERNAL_CONTEXT_HEADERS.runId),
    sandboxSessionId: getHeader(headers, INTERNAL_CONTEXT_HEADERS.sandboxSessionId),
    executionId: extras.executionId,
    traceId: traceparent?.traceId,
    spanId: traceparent?.spanId,
    requestId,
    callerType: extras.callerType,
    callerId: extras.callerId,
  });
}

/** Child span for a nested operation while preserving the same trace id. */
export function childSpanContext(
  parent: RequestContext,
  spanId: string = generateSpanId(),
): RequestContext {
  return assertRequestContext({
    ...parent,
    spanId,
  });
}
