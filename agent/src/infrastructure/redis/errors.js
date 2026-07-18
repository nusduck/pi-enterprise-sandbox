/**
 * Explicit Redis infrastructure errors (no silent localhost/memory fallback).
 */

export class RedisConfigError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'RedisConfigError';
    this.code = 'REDIS_CONFIG_ERROR';
  }
}

export class RedisDependencyError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'RedisDependencyError';
    this.code = 'REDIS_DEPENDENCY_ERROR';
  }
}

export class RedisValidationError extends Error {
  /**
   * @param {string} message
   * @param {{ field?: string }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'RedisValidationError';
    this.code = 'REDIS_VALIDATION_ERROR';
    this.field = meta.field ?? null;
  }
}

export class LeaseError extends Error {
  /**
   * @param {string} message
   * @param {{ runId?: string, code?: string }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'LeaseError';
    this.code = meta.code ?? 'LEASE_ERROR';
    this.runId = meta.runId ?? null;
  }
}

/**
 * Session lock coordination error (not a Session status transition).
 */
export class SessionLockError extends Error {
  /**
   * @param {string} message
   * @param {{ agentSessionId?: string, code?: string }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'SessionLockError';
    this.code = meta.code ?? 'SESSION_LOCK_ERROR';
    this.agentSessionId = meta.agentSessionId ?? null;
  }
}
