/**
 * Typed errors for DSH session adaptation / runtime factory (PR-05).
 */

export class DshSessionAdapterError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;

  constructor(message: string, meta: { code?: string, cause?: unknown } = {}) {
    super(message, meta.cause !== undefined ? { cause: meta.cause } : undefined);
    this.name = 'DshSessionAdapterError';
    this.code = meta.code ?? 'DSH_SESSION_ADAPTER_ERROR';
  }
}

export class DshRuntimeFactoryError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;

  constructor(message: string, meta: { code?: string, cause?: unknown } = {}) {
    super(message, meta.cause !== undefined ? { cause: meta.cause } : undefined);
    this.name = 'DshRuntimeFactoryError';
    this.code = meta.code ?? 'DSH_RUNTIME_FACTORY_ERROR';
  }
}
