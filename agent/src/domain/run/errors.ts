/**
 * Typed errors for the sole Run state machine (plan §10).
 * State machine never writes storage; callers map these to HTTP/application errors.
 */

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export class InvalidRunTransitionError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;
  from: Loose;
  to: Loose;

  constructor(from: string, to: string, message?: string) {
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
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;
  status: Loose;

  constructor(status: unknown, message?: string) {
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
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;
  outcome: Loose;

  constructor(outcome: unknown) {
    super(
      `Unknown legacy runtime outcome: ${String(outcome)} (no plan §10 mapping)`,
    );
    this.name = 'UnknownLegacyOutcomeError';
    this.code = 'UNKNOWN_LEGACY_OUTCOME';
    this.outcome = outcome;
  }
}
