export {
  TRACE_ID_PATTERN,
  SPAN_ID_PATTERN,
  TRACEPARENT_VERSION,
  TRACEPARENT_PATTERN,
  isTraceId,
  isSpanId,
  normalizeTraceId,
  normalizeSpanId,
  parseTraceparent,
  formatTraceparent,
  generateTraceId,
  generateSpanId,
} from './trace.ts';

export type { TraceId, SpanId, TraceFlags, Traceparent } from './trace.ts';

export {
  EXTERNAL_CONTEXT_HEADERS,
  INTERNAL_CONTEXT_HEADERS,
  getHeader,
} from './headers.ts';

export type {
  ExternalContextHeader,
  InternalContextHeader,
} from './headers.ts';

export {
  CALLER_TYPES,
  isCallerType,
  parseRequestContext,
  isRequestContext,
  assertRequestContext,
  createRequestContext,
  toInternalHeaders,
  requestContextFromInternalHeaders,
  childSpanContext,
} from './request-context.ts';

export type {
  CallerType,
  RequestContext,
  RequestContextParseResult,
} from './request-context.ts';
