/**
 * Error code taxonomy (plan §26).
 *
 * Codes are stable machine-readable identifiers. Categories group related codes.
 * Stack traces must never be returned to browsers or A2A clients.
 */

export const ERROR_CODE_CATEGORIES = [
  'AUTH',
  'TENANT',
  'CONVERSATION',
  'SESSION',
  'RUN',
  'TOOL',
  'SANDBOX',
  'PROCESS',
  'DATASET',
  'ARTIFACT',
  'MCP',
  'APPROVAL',
  'A2A',
  'INTERNAL',
] as const;

export type ErrorCodeCategory = (typeof ERROR_CODE_CATEGORIES)[number];

/** Pattern: CATEGORY_SNAKE_REASON, e.g. RUN_NOT_FOUND. */
export const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/**
 * Seed catalog of known codes. Services may add codes that still match
 * {@link ERROR_CODE_PATTERN} and a known category prefix.
 */
export const KNOWN_ERROR_CODES = [
  // AUTH_*
  'AUTH_REQUIRED',
  'AUTH_INVALID_TOKEN',
  'AUTH_EXPIRED',
  'AUTH_FORBIDDEN',
  // TENANT_*
  'TENANT_NOT_FOUND',
  'TENANT_SUSPENDED',
  'TENANT_ACCESS_DENIED',
  'TENANT_CONTEXT_REQUIRED',
  // CONVERSATION_*
  'CONVERSATION_NOT_FOUND',
  'CONVERSATION_ACCESS_DENIED',
  'CONVERSATION_CLOSED',
  // SESSION_*
  'SESSION_NOT_FOUND',
  'SESSION_ACCESS_DENIED',
  'SESSION_NOT_ACTIVE',
  'SESSION_RESTORE_FAILED',
  // RUN_*
  'RUN_NOT_FOUND',
  'RUN_ACCESS_DENIED',
  'RUN_INVALID_TRANSITION',
  'RUN_ALREADY_TERMINAL',
  'RUN_CANCEL_FAILED',
  'RUN_INITIALIZATION_TIMEOUT',
  // TOOL_*
  'TOOL_NOT_ALLOWED',
  'TOOL_VALIDATION_FAILED',
  'TOOL_EXECUTION_FAILED',
  'TOOL_TIMEOUT',
  // SANDBOX_*
  'SANDBOX_UNAVAILABLE',
  'SANDBOX_SESSION_NOT_FOUND',
  'SANDBOX_PATH_DENIED',
  'SANDBOX_QUOTA_EXCEEDED',
  'SANDBOX_EXECUTION_FAILED',
  // PROCESS_*
  'PROCESS_NOT_FOUND',
  'PROCESS_NOT_RUNNING',
  'PROCESS_SIGNAL_FAILED',
  // DATASET_*
  'DATASET_NOT_FOUND',
  'DATASET_UPLOAD_FAILED',
  'DATASET_TOO_LARGE',
  'DATASET_TYPE_DENIED',
  // ARTIFACT_*
  'ARTIFACT_NOT_FOUND',
  'ARTIFACT_ACCESS_DENIED',
  'ARTIFACT_SUBMIT_FAILED',
  // MCP_*
  'MCP_SERVER_UNAVAILABLE',
  'MCP_TOOL_NOT_FOUND',
  'MCP_CALL_FAILED',
  'MCP_POLICY_DENIED',
  // APPROVAL_*
  'APPROVAL_NOT_FOUND',
  'APPROVAL_ALREADY_RESOLVED',
  'APPROVAL_EXPIRED',
  'APPROVAL_REQUIRED',
  // A2A_*
  'A2A_UNAUTHORIZED',
  'A2A_TASK_NOT_FOUND',
  'A2A_INVALID_REQUEST',
  'A2A_UNSUPPORTED_METHOD',
  // INTERNAL_*
  'INTERNAL_ERROR',
  'INTERNAL_DEPENDENCY_FAILED',
  'INTERNAL_NOT_IMPLEMENTED',
] as const;

export type KnownErrorCode = (typeof KNOWN_ERROR_CODES)[number];
export type ErrorCode = KnownErrorCode | (string & {});

export function isErrorCodeCategory(value: unknown): value is ErrorCodeCategory {
  return (
    typeof value === 'string' &&
    (ERROR_CODE_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isErrorCodeFormat(value: unknown): value is string {
  return typeof value === 'string' && ERROR_CODE_PATTERN.test(value);
}

/** Extract category prefix from a code such as RUN_NOT_FOUND → RUN. */
export function errorCodeCategory(code: string): ErrorCodeCategory | null {
  if (!isErrorCodeFormat(code)) return null;
  const prefix = code.split('_', 1)[0] ?? '';
  return isErrorCodeCategory(prefix) ? prefix : null;
}

export function isKnownErrorCode(value: unknown): value is KnownErrorCode {
  return (
    typeof value === 'string' &&
    (KNOWN_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Accept known catalog codes or well-formed codes under a known category.
 * Rejects free-form strings that would leak internal names.
 */
export function isValidErrorCode(value: unknown): value is ErrorCode {
  if (!isErrorCodeFormat(value)) return false;
  if (isKnownErrorCode(value)) return true;
  return errorCodeCategory(value) !== null;
}
