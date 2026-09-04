/**
 * Application-layer typed errors for Run services (PR-04 T2).
 * Map to HTTP at presentation boundaries; services stay transport-agnostic.
 */

/** 错误附带的结构化上下文。允许 null：多数子类不传。 */
export type ErrorDetails = Record<string, unknown> | null | undefined;

export class ApplicationError extends Error {
  /** 稳定的机器可读码。表现层按它映射 HTTP，不按 message。 */
  readonly code: string;
  /** 调用方是否可以原样重试。 */
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | null;

  constructor(
    message: string,
    opts: { code?: string; retryable?: boolean; details?: ErrorDetails } = {},
  ) {
    super(message);
    this.name = 'ApplicationError';
    this.code = opts.code ?? 'APPLICATION_ERROR';
    this.retryable = opts.retryable === true;
    this.details = opts.details ?? null;
  }
}

/** Parent-graph mapping race: outer caller should retry the whole transaction. */
export class ParentProvisioningRaceError extends ApplicationError {
  constructor(
    message = 'Parent graph provisioning race; retry transaction',
    details?: ErrorDetails,
  ) {
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
  constructor(
    message = 'Idempotent operation is still in progress',
    details?: ErrorDetails,
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
  constructor(
    message = 'Idempotency key reused with a different request body',
    details?: ErrorDetails,
  ) {
    super(message, {
      code: 'IDEMPOTENCY_CONFLICT',
      retryable: false,
      details,
    });
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * 调用方通过了鉴权，但角色不足以执行这个写操作。
 *
 * 与 404 分开：Agent 目录对 org 内所有成员**可见**，只是不可写——把它压成
 * 404 会让管理员误以为自己建的 Agent 消失了。角色解析不出来（`role` 为 null）
 * 时也走这条路：fail-closed，不回退到"默认允许"。
 */
export class AdminRoleRequiredError extends ApplicationError {
  constructor(message = 'Administrator role is required', details?: ErrorDetails) {
    super(message, { code: 'ADMIN_REQUIRED', retryable: false, details });
    this.name = 'AdminRoleRequiredError';
  }
}

/** Owner-scoped resource missing (never leak cross-tenant existence). */
export class OwnerScopedNotFoundError extends ApplicationError {
  readonly resource: string | null;
  readonly id: string | null;

  constructor(message: string, meta: { resource?: string; id?: string } = {}) {
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
  constructor(message: string, details?: ErrorDetails) {
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
  constructor(message: string, details?: ErrorDetails) {
    super(message, {
      code: 'CANONICAL_JSON_ERROR',
      retryable: false,
      details,
    });
    this.name = 'CanonicalJsonError';
  }
}
