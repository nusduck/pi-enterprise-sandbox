/**
 * Typed errors for the sole Run state machine (plan §10).
 * State machine never writes storage; callers map these to HTTP/application errors.
 */

export class InvalidRunTransitionError extends Error {
  /**
   * @param {string} from
   * @param {string} to
   * @param {string} [message]
   */
  constructor(from, to, message) {
    super(
      message ??
        `Invalid run transition: ${String(from)} → ${String(to)} (plan §10)`,
    );
    this.name = 'InvalidRunTransitionError';
    this.code = 'INVALID_RUN_TRANSITION';
    this.from = from;
    this.to = to;
  }
}

export class InvalidRunStatusError extends Error {
  /**
   * @param {unknown} status
   * @param {string} [message]
   */
  constructor(status, message) {
    super(
      message ??
        `Invalid run status: ${String(status)} (expected plan §10 uppercase)`,
    );
    this.name = 'InvalidRunStatusError';
    this.code = 'INVALID_RUN_STATUS';
    this.status = status;
  }
}

export class UnknownLegacyOutcomeError extends Error {
  /**
   * @param {unknown} outcome
   */
  constructor(outcome) {
    super(
      `Unknown legacy runtime outcome: ${String(outcome)} (no plan §10 mapping)`,
    );
    this.name = 'UnknownLegacyOutcomeError';
    this.code = 'UNKNOWN_LEGACY_OUTCOME';
    this.outcome = outcome;
  }
}
