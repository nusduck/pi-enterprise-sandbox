/**
 * Typed errors for the sole Agent Session state machine (plan §11).
 * State machine never writes storage; callers map these to application errors.
 */

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export class InvalidSessionTransitionError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;
  from: Loose;
  to: Loose;

  constructor(from: string, to: string, message?: string) {
    super(
      message ??
        `Invalid session transition: ${String(from)} → ${String(to)} (plan §11)`,
    );
    this.name = 'InvalidSessionTransitionError';
    this.code = 'INVALID_SESSION_TRANSITION';
    this.from = from;
    this.to = to;
  }
}

export class InvalidSessionStatusError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;
  status: Loose;

  constructor(status: unknown, message?: string) {
    super(
      message ??
        `Invalid session status: ${String(status)} (expected plan §11 uppercase)`,
    );
    this.name = 'InvalidSessionStatusError';
    this.code = 'INVALID_SESSION_STATUS';
    this.status = status;
  }
}

export class SessionFenceConflictError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: string;
  agentSessionId: Loose;
  expectedToken: Loose;
  actualToken: Loose;

  constructor(message: string, meta: { agentSessionId?: string, expectedToken?: number, actualToken?: number | null } = {}) {
    super(message);
    this.name = 'SessionFenceConflictError';
    this.code = 'SESSION_FENCE_CONFLICT';
    this.agentSessionId = meta.agentSessionId ?? null;
    this.expectedToken = meta.expectedToken ?? null;
    this.actualToken = meta.actualToken ?? null;
  }
}

export class SessionSnapshotError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: Loose;
  agentSessionId: Loose;
  snapshotVersion: Loose;

  constructor(message: string, meta: { code?: string, agentSessionId?: string, snapshotVersion?: number | null } = {}) {
    super(message);
    this.name = 'SessionSnapshotError';
    this.code = meta.code ?? 'SESSION_SNAPSHOT_ERROR';
    this.agentSessionId = meta.agentSessionId ?? null;
    this.snapshotVersion = meta.snapshotVersion ?? null;
  }
}

/**
 * Durable recovery is required — Session is (or will be) SUSPENDED with
 * recovery_reason_code. Callers must not text-inject history or auto-replay
 * side effects.
 */
export class SessionRecoveryRequiredError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: Loose;
  agentSessionId: Loose;
  recoveryReasonCode: Loose;

  /**
   * @param message
   * @param {{
   *   code?: string,
   *   agentSessionId?: string,
   *   recoveryReasonCode?: string | null,
   *   cause?: unknown,
   * }} [meta]
   */
  constructor(message: string, meta: { code?: string, agentSessionId?: string, recoveryReasonCode?: string | null, cause?: unknown, } = {}) {
    super(
      message,
      meta.cause !== undefined ? { cause: meta.cause } : undefined,
    );
    this.name = 'SessionRecoveryRequiredError';
    this.code = meta.code ?? 'RECOVERY_REQUIRED';
    this.agentSessionId = meta.agentSessionId ?? null;
    this.recoveryReasonCode = meta.recoveryReasonCode ?? 'RECOVERY_REQUIRED';
  }
}

/**
 * Pi JSONL journal append / load failures (idempotency hash conflict, scope).
 */
export class SessionJournalError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: Loose;
  agentSessionId: Loose;
  piEntryId: Loose;

  /**
   * @param message
   * @param {{
   *   code?: string,
   *   agentSessionId?: string,
   *   piEntryId?: string | null,
   *   cause?: unknown,
   * }} [meta]
   */
  constructor(message: string, meta: { code?: string, agentSessionId?: string, piEntryId?: string | null, cause?: unknown, } = {}) {
    super(
      message,
      meta.cause !== undefined ? { cause: meta.cause } : undefined,
    );
    this.name = 'SessionJournalError';
    this.code = meta.code ?? 'SESSION_JOURNAL_ERROR';
    this.agentSessionId = meta.agentSessionId ?? null;
    this.piEntryId = meta.piEntryId ?? null;
  }
}
