/**
 * Typed errors for DSH session adaptation / runtime factory (PR-05).
 */

export class DshSessionAdapterError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    super(message, meta.cause !== undefined ? { cause: meta.cause } : undefined);
    this.name = 'DshSessionAdapterError';
    this.code = meta.code ?? 'DSH_SESSION_ADAPTER_ERROR';
  }
}

export class DshRuntimeFactoryError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    super(message, meta.cause !== undefined ? { cause: meta.cause } : undefined);
    this.name = 'DshRuntimeFactoryError';
    this.code = meta.code ?? 'DSH_RUNTIME_FACTORY_ERROR';
  }
}
