/**
 * Explicit Redis infrastructure errors (no silent localhost/memory fallback).
 */

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export class RedisConfigError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;

  constructor(message: string) {
    super(message);
    this.name = 'RedisConfigError';
    this.code = 'REDIS_CONFIG_ERROR';
  }
}

export class RedisDependencyError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;

  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'RedisDependencyError';
    this.code = 'REDIS_DEPENDENCY_ERROR';
  }
}

export class RedisValidationError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;
  field: Loose;

  constructor(message: string, meta: { field?: string } = {}) {
    super(message);
    this.name = 'RedisValidationError';
    this.code = 'REDIS_VALIDATION_ERROR';
    this.field = meta.field ?? null;
  }
}

export class LeaseError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: Loose;
  runId: Loose;

  constructor(message: string, meta: { runId?: string, code?: string } = {}) {
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
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: Loose;
  agentSessionId: Loose;

  constructor(message: string, meta: { agentSessionId?: string, code?: string } = {}) {
    super(message);
    this.name = 'SessionLockError';
    this.code = meta.code ?? 'SESSION_LOCK_ERROR';
    this.agentSessionId = meta.agentSessionId ?? null;
  }
}
