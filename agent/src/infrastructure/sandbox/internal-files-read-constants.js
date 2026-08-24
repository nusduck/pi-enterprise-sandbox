/**
 * Wire constants for the internal-plane files/skills read transport:
 * HTU paths, scopes, the fixed byte ceiling, field bounds, retry defaults,
 * and the logical roots a read path must canonicalise under.
 */

export const FILES_READ_HTU = '/internal/v1/files/read';
export const FILES_READ_TOOL_NAME = 'read';
export const FILES_READ_SCOPE = 'sandbox.files.read';
export const SKILLS_READ_HTU = '/internal/v1/skills/read';
export const SKILLS_READ_SCOPE = 'sandbox.skills.read';
export const READ_MAX_BYTES_FIXED = 262_144;
export const READ_LIMIT_MIN = 1;
export const READ_LIMIT_MAX = 50_000;
export const READ_OFFSET_MIN = 0;
export const READ_PATH_MAX_LEN = 512;
export const IDENTIFIER_MAX_LEN = 255;
export const TOOL_CALL_ID_MAX_LEN = 255;
export const TRACE_ID_MAX_LEN = 255;

/** Default: single attempt (no automatic retry). Tests may raise. */
export const DEFAULT_MAX_ATTEMPTS = 1;
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
/**
 * Largest image the sandbox inlines on a read, in raw bytes.
 *
 * Mirrors `InternalFileReader.IMAGE_MAX_BYTES`; the sandbox is the enforcer and
 * this side re-checks what arrived. Kept equal to MAX_WRITE_BYTES so an image a
 * tool could write is one a read can hand back.
 */
export const READ_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Hard cap on response body.
 *
 * Sized for the larger of the two success shapes: a text read stays within its
 * own 256KiB `maxBytes` budget, while an image read carries
 * READ_IMAGE_MAX_BYTES base64-expanded (~4/3) plus the JSON envelope. This is a
 * transport-level DoS guard only — text content is separately and strictly
 * bounded by `command.maxBytes` in filterFilesReadSuccessResult, so the wider
 * ceiling never loosens what a text read may return.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Safe transport-layer retries only (never business 4xx / 409 ledger). */
export const DEFAULT_RETRYABLE_HTTP_STATUSES = Object.freeze([502, 503, 504]);

export const LOGICAL_WORKSPACE_ROOT = '/home/sandbox/workspace';
export const LOGICAL_SKILL_ROOT = '/home/sandbox/skill';
export const LOGICAL_USER_SKILL_ROOT = '/home/sandbox/skill-user';
/** Longest-first skill roots for path validation. */
export const LOGICAL_SKILL_ROOTS = Object.freeze([
  LOGICAL_SKILL_ROOT,
  LOGICAL_USER_SKILL_ROOT,
]);

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;
export const JS_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export const SUCCESS_TEXT_KEYS = Object.freeze([
  'path',
  'binary',
  'content',
  'truncated',
  'offset',
  'limit',
  'size',
  'returnedLines',
  'nextOffset',
  'mimeType',
]);

export const SUCCESS_BINARY_KEYS = Object.freeze([
  'path',
  'binary',
  'size',
  'mimeType',
  // Present only when the sandbox sniffed the content as an inline image.
  'imageMimeType',
  'imageContent',
  'imageOmitted',
]);

/** Image types the sandbox may sniff and this side will accept. */
export const READ_IMAGE_MIME_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
]);

/** Reasons the sandbox may give for withholding image bytes. */
export const READ_IMAGE_OMITTED_REASONS = Object.freeze(['IMAGE_TOO_LARGE']);

export const BODY_ROOT_KEYS = Object.freeze([
  'path',
  'offset',
  'limit',
  'maxBytes',
  'identity',
  'toolExecutionId',
  'toolCallId',
  'requestHash',
  'requestHashVersion',
]);

export const IDENTITY_KEYS = Object.freeze([
  'orgId',
  'userId',
  'conversationId',
  'agentSessionId',
  'runId',
  'sandboxSessionId',
  'traceId',
  'executionFenceToken',
]);
