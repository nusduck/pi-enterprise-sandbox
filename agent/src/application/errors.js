/**
 * Application-layer typed errors for Run services (PR-04 T2).
 * Map to HTTP at presentation boundaries; services stay transport-agnostic.
 */

export class ApplicationError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, retryable?: boolean, details?: Record<string, unknown> }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ApplicationError';
    this.code = opts.code ?? 'APPLICATION_ERROR';
    this.retryable = opts.retryable === true;
    this.details = opts.details ?? null;
  }
}

/** Parent-graph mapping race: outer caller should retry the whole transaction. */
export class ParentProvisioningRaceError extends ApplicationError {
  /**
   * @param {string} [message]
   * @param {Record<string, unknown>} [details]
   */
  constructor(message = 'Parent graph provisioning race; retry transaction', details) {
    super(message, {
      code: 'PARENT_PROVISIONING_RACE',
      retryable: true,
      details,
    });
    this.name = 'ParentProvisioningRaceError';
  }
}

/** Same idempotency key + same hash, response not yet completed. */
export class IdempotencyInProgressError extends ApplicationError {
  /**
   * @param {string} [message]
   * @param {Record<string, unknown>} [details]
   */
  constructor(
    message = 'Idempotent operation is still in progress',
    details,
  ) {
    super(message, {
      code: 'IDEMPOTENCY_IN_PROGRESS',
      retryable: true,
      details,
    });
    this.name = 'IdempotencyInProgressError';
  }
}

/** Same idempotency key with a different request body hash. */
export class IdempotencyConflictError extends ApplicationError {
  /**
   * @param {string} [message]
   * @param {Record<string, unknown>} [details]
   */
  constructor(
    message = 'Idempotency key reused with a different request body',
    details,
  ) {
    super(message, {
      code: 'IDEMPOTENCY_CONFLICT',
      retryable: false,
      details,
    });
    this.name = 'IdempotencyConflictError';
  }
}

/** Owner-scoped resource missing (never leak cross-tenant existence). */
export class OwnerScopedNotFoundError extends ApplicationError {
  /**
   * @param {string} message
   * @param {{ resource?: string, id?: string }} [meta]
   */
  constructor(message, meta = {}) {
    super(message, {
      code: 'NOT_FOUND',
      retryable: false,
      details: { resource: meta.resource ?? null, id: meta.id ?? null },
    });
    this.name = 'OwnerScopedNotFoundError';
    this.resource = meta.resource ?? null;
    this.id = meta.id ?? null;
  }
}

/** Input validation failure (messages, trace, sizes, etc.). */
export class ValidationError extends ApplicationError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details) {
    super(message, {
      code: 'VALIDATION_ERROR',
      retryable: false,
      details,
    });
    this.name = 'ValidationError';
  }
}

/**
 * Canonical JSON / hash construction failed.
 */
export class CanonicalJsonError extends ApplicationError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details) {
    super(message, {
      code: 'CANONICAL_JSON_ERROR',
      retryable: false,
      details,
    });
    this.name = 'CanonicalJsonError';
  }
}
