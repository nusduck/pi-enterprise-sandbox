/**
 * Unified error response contract (plan §26).
 *
 * Wire JSON:
 * {
 *   "error": {
 *     "code": "RUN_NOT_FOUND",
 *     "message": "The requested run was not found.",
 *     "requestId": "01...",
 *     "traceId": "..."
 *   }
 * }
 */

import { isUlid } from '../ids.ts';
import { isValidErrorCode, type ErrorCode } from './codes.ts';
import { isTraceId, normalizeTraceId } from '../context/trace.ts';

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  requestId: string;
  traceId: string;
  /** Optional safe details for clients; never stack traces. */
  details?: Record<string, unknown>;
}

export interface ErrorResponse {
  error: ErrorBody;
}

export interface ParseErrorResponseResult {
  ok: true;
  value: ErrorResponse;
}

export interface ParseErrorResponseFailure {
  ok: false;
  errors: string[];
}

export type ParseErrorResponseOutcome =
  | ParseErrorResponseResult
  | ParseErrorResponseFailure;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runtime validation for the public error envelope.
 * Does not accept stack, cause, or nested exception fields at the top level.
 */
export function parseErrorResponse(input: unknown): ParseErrorResponseOutcome {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['root must be an object'] };
  }
  if (!isPlainObject(input.error)) {
    return { ok: false, errors: ['error must be an object'] };
  }

  const body = input.error;
  if (!isValidErrorCode(body.code)) {
    errors.push('error.code must be a categorized ERROR_CODE');
  }
  if (typeof body.message !== 'string' || body.message.trim().length === 0) {
    errors.push('error.message must be a non-empty string');
  }
  if (typeof body.requestId !== 'string' || body.requestId.length === 0) {
    errors.push('error.requestId is required');
  } else if (!isUlid(body.requestId) && !/^[A-Za-z0-9._:-]{8,128}$/.test(body.requestId)) {
    // Allow ULID (preferred) or opaque request ids from proxies.
    errors.push('error.requestId has invalid format');
  }
  if (typeof body.traceId !== 'string' || !isTraceId(body.traceId)) {
    errors.push('error.traceId must be a 32-char hex W3C trace-id');
  }
  if (body.details !== undefined && !isPlainObject(body.details)) {
    errors.push('error.details must be an object when present');
  }

  // Hard ban of fields that would leak internals to clients.
  for (const banned of ['stack', 'stackTrace', 'exception', 'cause']) {
    if (banned in body) {
      errors.push(`error must not include ${banned}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const response: ErrorResponse = {
    error: {
      code: body.code as ErrorCode,
      message: body.message as string,
      requestId: body.requestId as string,
      traceId: normalizeTraceId(body.traceId as string),
    },
  };
  if (body.details !== undefined) {
    response.error.details = body.details as Record<string, unknown>;
  }
  return { ok: true, value: response };
}

export function isErrorResponse(input: unknown): input is ErrorResponse {
  return parseErrorResponse(input).ok;
}

export function makeErrorResponse(input: {
  code: ErrorCode;
  message: string;
  requestId: string;
  traceId: string;
  details?: Record<string, unknown>;
}): ErrorResponse {
  const parsed = parseErrorResponse({ error: input });
  if (!parsed.ok) {
    throw new Error(`Invalid error response: ${parsed.errors.join('; ')}`);
  }
  return parsed.value;
}
