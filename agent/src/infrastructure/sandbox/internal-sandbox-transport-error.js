/**
 * The error type every internal-plane Sandbox transport throws, and the two
 * throw helpers built on it.
 *
 * Its own module so the transport and its payload validator share one error
 * identity without a cycle. `failOutcomeUnknown` is the only path that sets
 * `outcomeUnknown`, keeping TOOL_OUTCOME_UNKNOWN reserved for genuinely
 * ambiguous post-claim outcomes.
 */

/**
 * Typed transport error with stable `.code` for mapTransportError / callers.
 * When `outcomeUnknown === true`, ledger must record TOOL_OUTCOME_UNKNOWN
 * (never ordinary FAILED/CANCELLED) — Sandbox may still complete the claim.
 */
export class InternalSandboxTransportError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{
   *   httpStatus?: number,
   *   retryable?: boolean,
   *   outcomeUnknown?: boolean,
   * }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'InternalSandboxTransportError';
    this.code = code;
    if (extra.httpStatus != null) this.httpStatus = extra.httpStatus;
    if (extra.retryable != null) this.retryable = extra.retryable;
    // Strict boolean only — never truthy coercion from strings.
    if (extra.outcomeUnknown === true) {
      this.outcomeUnknown = true;
    }
  }
}

/**
 * @param {string} code
 * @param {string} message
 * @param {{
 *   httpStatus?: number,
 *   retryable?: boolean,
 *   outcomeUnknown?: boolean,
 * }} [extra]
 * @returns {never}
 */
export function fail(code, message, extra) {
  throw new InternalSandboxTransportError(code, message, extra);
}

/**
 * Ambiguous post-dispatch outcome: never retry; never map to ordinary
 * CANCELLED/FAILED/TIMEOUT for ledger solidification.
 *
 * @param {string} message
 * @param {{ httpStatus?: number }} [extra]
 * @returns {never}
 */
export function failOutcomeUnknown(message, extra = {}) {
  throw new InternalSandboxTransportError(
    'TOOL_OUTCOME_UNKNOWN',
    message,
    {
      ...extra,
      outcomeUnknown: true,
      retryable: false,
    },
  );
}
