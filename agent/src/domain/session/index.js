/**
 * Agent Session domain (plan §11 + PR-05 recovery/fencing).
 * No storage writes live here.
 */

export {
  InvalidSessionTransitionError,
  InvalidSessionStatusError,
  SessionFenceConflictError,
  SessionSnapshotError,
  SessionRecoveryRequiredError,
  SessionJournalError,
} from './errors.js';

export {
  SESSION_STATUS,
  ALL_SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
  TERMINAL_SESSION_STATUS_SET,
  RUNNABLE_SESSION_STATUSES,
  SESSION_TRANSITIONS,
  isSessionStatus,
  isTerminalSessionStatus,
} from './session-status.js';

export {
  RECOVERY_REASON_CODE,
  ALL_RECOVERY_REASON_CODES,
  RECOVERY_REASON_CODE_SET,
  isRecoveryReasonCode,
  assertRecoveryReasonCode,
} from './recovery-reason.js';

export {
  SessionStateMachine,
  sessionStateMachine,
} from './session-state-machine.js';
