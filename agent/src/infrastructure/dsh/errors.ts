/**
 * Typed errors for DSH session adaptation / runtime factory (PR-05).
 */

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export class DshSessionAdapterError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: Loose;

  constructor(message: string, meta: { code?: string, cause?: unknown } = {}) {
    super(message, meta.cause !== undefined ? { cause: meta.cause } : undefined);
    this.name = 'DshSessionAdapterError';
    this.code = meta.code ?? 'DSH_SESSION_ADAPTER_ERROR';
  }
}

export class DshRuntimeFactoryError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: Loose;

  constructor(message: string, meta: { code?: string, cause?: unknown } = {}) {
    super(message, meta.cause !== undefined ? { cause: meta.cause } : undefined);
    this.name = 'DshRuntimeFactoryError';
    this.code = meta.code ?? 'DSH_RUNTIME_FACTORY_ERROR';
  }
}
