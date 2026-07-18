/**
 * Typed errors for the sole Agent Session state machine (plan §11).
 * State machine never writes storage; callers map these to application errors.
 */

export class InvalidSessionTransitionError extends Error {
  /**
   * @param {string} from
   * @param {string} to
   * @param {string} [message]
   */
  constructor(from, to, message) {
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
  /**
   * @param {unknown} status
   * @param {string} [message]
   */
  constructor(status, message) {
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
  /**
   * @param {string} message
   * @param {{ agentSessionId?: string, expectedToken?: number, actualToken?: number | null }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'SessionFenceConflictError';
    this.code = 'SESSION_FENCE_CONFLICT';
    this.agentSessionId = meta.agentSessionId ?? null;
    this.expectedToken = meta.expectedToken ?? null;
    this.actualToken = meta.actualToken ?? null;
  }
}

export class SessionSnapshotError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, agentSessionId?: string, snapshotVersion?: number | null }} [meta]
   */
  constructor(message, meta = {}) {
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
  /**
   * @param {string} message
   * @param {{
   *   code?: string,
   *   agentSessionId?: string,
   *   recoveryReasonCode?: string | null,
   *   cause?: unknown,
   * }} [meta]
   */
  constructor(message, meta = {}) {
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
  /**
   * @param {string} message
   * @param {{
   *   code?: string,
   *   agentSessionId?: string,
   *   piEntryId?: string | null,
   *   cause?: unknown,
   * }} [meta]
   */
  constructor(message, meta = {}) {
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
