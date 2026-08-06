/**
 * Typed transport error shared by every Agent → Sandbox transport.
 *
 * Its own module so base-url.js and the transports can both raise it without
 * importing each other.
 *
 * `outcomeUnknown === true` is load-bearing: it tells the ledger to record
 * TOOL_OUTCOME_UNKNOWN rather than an ordinary FAILED/CANCELLED, because the
 * Sandbox may still complete the claim even though we lost the answer.
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
