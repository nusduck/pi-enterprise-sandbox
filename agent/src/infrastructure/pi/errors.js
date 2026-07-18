/**
 * Typed errors for Pi session adaptation / runtime factory (PR-05).
 */

export class PiSessionAdapterError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    super(message, meta.cause !== undefined ? { cause: meta.cause } : undefined);
    this.name = 'PiSessionAdapterError';
    this.code = meta.code ?? 'PI_SESSION_ADAPTER_ERROR';
  }
}

export class PiRuntimeFactoryError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    super(message, meta.cause !== undefined ? { cause: meta.cause } : undefined);
    this.name = 'PiRuntimeFactoryError';
    this.code = meta.code ?? 'PI_RUNTIME_FACTORY_ERROR';
  }
}
