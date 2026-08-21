/**
 * Normalising what comes back from the Sandbox transport.
 *
 * Public ProcessStatus projection for the four process_* tools, plus the
 * bind/transport error mappers. UNKNOWN is reserved for genuinely ambiguous
 * post-claim outcomes; ordinary validation and bind failures keep explicit
 * codes so a Run is never marked unknown for a knowable reason.
 */

import { normalizeProcessStatus } from '../../../domain/process-status.js';
import { toolErr } from '../result.js';

export function normalizeProcessTransportResult(toolName, data) {
  if (!toolName.startsWith('process_') || !data || typeof data !== 'object') {
    return data;
  }
  if (toolName === 'process_read' && data.status == null) return data;
  const fallback = toolName === 'process_start' || toolName === 'process_kill'
    ? 'running'
    : null;
  return { ...data, status: normalizeProcessStatus(data.status, fallback) };
}

/**
 * Bind failures stay explicit codes — never UNKNOWN (UNKNOWN is only for
 * ambiguous post-claim transport outcomes later).
 * @param {unknown} err
 */
export function mapBindError(err) {
  const code =
    /** @type {any} */ (err)?.code ||
    (/** @type {any} */ (err)?.name === 'NotFoundError'
      ? 'TOOL_EXECUTION_NOT_FOUND'
      : /** @type {any} */ (err)?.name === 'ConflictError'
        ? 'SANDBOX_REQUEST_BIND_CONFLICT'
        : 'SANDBOX_REQUEST_BIND_FAILED');
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'sandbox request bind failed';
  // Ordinary bind/ledger failures are never mapped to UNKNOWN.
  const safeCode =
    String(code) === 'UNKNOWN' || String(code) === 'TOOL_OUTCOME_UNKNOWN'
      ? 'SANDBOX_REQUEST_BIND_FAILED'
      : String(code);
  return toolErr(safeCode, msg);
}

/**
 * Stable ledger / one-shot outcome codes from Sandbox internal transport.
 * Must pass through to tool details — never collapse into SANDBOX_ERROR.
 * (Bare "UNKNOWN" remains remapped; "TOOL_OUTCOME_UNKNOWN" is intentional.)
 */
const PRESERVED_TRANSPORT_ERROR_CODES = new Set([
  'IN_PROGRESS',
  'TOOL_OUTCOME_UNKNOWN',
  'CANCELLED',
]);

/**
 * Detect authoritative outcome-unknown from transport only.
 * Accepts strict boolean marker and/or exact code TOOL_OUTCOME_UNKNOWN.
 * Does not accept string "true", 1, or arbitrary details.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransportOutcomeUnknown(err) {
  const e = /** @type {any} */ (err);
  if (!e || typeof e !== 'object') return false;
  if (e.outcomeUnknown === true) return true;
  return e.code === 'TOOL_OUTCOME_UNKNOWN';
}

/**
 * @param {unknown} err
 */
export function mapTransportError(err) {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'sandbox transport error';

  // Ambiguous Sandbox outcome: fixed code + fixed boolean marker only.
  // Never spread arbitrary error fields into tool details (anti-spoof).
  if (isTransportOutcomeUnknown(err)) {
    return toolErr('TOOL_OUTCOME_UNKNOWN', msg, { outcomeUnknown: true });
  }

  const code =
    /** @type {any} */ (err)?.code ||
    (/** @type {any} */ (err)?.message?.includes('SANDBOX_TRANSPORT')
      ? 'SANDBOX_TRANSPORT_UNAVAILABLE'
      : 'SANDBOX_ERROR');
  const codeStr = String(code);
  // Preserve IN_PROGRESS / CANCELLED. Only remap bare UNKNOWN.
  const safeCode = PRESERVED_TRANSPORT_ERROR_CODES.has(codeStr)
    ? codeStr
    : codeStr === 'UNKNOWN'
      ? 'SANDBOX_ERROR'
      : codeStr;
  // read/readSkill hit a single line wider than the sandbox's max_bytes cap.
  // Unlike every other read-truncation path, this one has no partial content
  // or nextOffset to offer — give the model a way forward instead of a bare
  // "line too large" dead end.
  const safeMsg =
    safeCode === 'FILE_LINE_TOO_LARGE'
      ? `${msg}. This line has no newline within the read byte budget (e.g. minified or single-line data). Use bash with grep/head/cut, or python, to inspect it in byte ranges instead of read.`
      : msg;
  // No extra details object — avoid leaking transport internals.
  return toolErr(safeCode, safeMsg);
}
