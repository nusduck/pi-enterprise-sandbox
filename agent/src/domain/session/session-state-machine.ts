/**
 * Sole Agent Session state machine (plan §11 + PR-05 recovery).
 *
 * - Exact six statuses / adjacent edges only.
 * - Invalid transitions throw typed {@link InvalidSessionTransitionError}.
 * - Does **not** write storage.
 * - RECOVERY_REQUIRED is never a status; use {@link assertSuspendForRecovery}.
 * - Same-status SUSPENDED re-reason is allowed (not a transition).
 */

import {
  ALL_SESSION_STATUSES,
  isSessionStatus,
  isTerminalSessionStatus,
  SESSION_STATUS,
  SESSION_TRANSITIONS,
  TERMINAL_SESSION_STATUSES,
  TERMINAL_SESSION_STATUS_SET,
} from './session-status.js';
import {
  InvalidSessionStatusError,
  InvalidSessionTransitionError,
} from './errors.js';
import {
  assertRecoveryReasonCode,
  RECOVERY_REASON_CODE,
} from './recovery-reason.js';

export class SessionStateMachine {
  /**
   * @param status
   * @returns {asserts status is string}
   */
  assertStatus(status: unknown) {
    if (!isSessionStatus(status)) {
      throw new InvalidSessionStatusError(status);
    }
  }

  /**
   * @param status
   * @returns {boolean}
   */
  isTerminal(status: unknown) {
    return isTerminalSessionStatus(status);
  }

  /**
   * @returns {readonly string[]}
   */
  terminalStatuses() {
    return TERMINAL_SESSION_STATUSES;
  }

  /**
   * @returns {readonly string[]}
   */
  allStatuses() {
    return ALL_SESSION_STATUSES;
  }

  /**
   * @param from
   * @returns {readonly string[]}
   */
  allowedTargets(from: string) {
    this.assertStatus(from);
    return SESSION_TRANSITIONS[from];
  }

  /**
   * @param from
   * @param to
   * @returns {boolean}
   */
  canTransition(from: string, to: string) {
    if (!isSessionStatus(from) || !isSessionStatus(to)) return false;
    return SESSION_TRANSITIONS[from].includes(to);
  }

  /**
   * Validate and return the target status. No I/O.
   * @param from
   * @param to
   * @returns {string}
   */
  transition(from: string, to: string) {
    this.assertStatus(from);
    this.assertStatus(to);
    if (!SESSION_TRANSITIONS[from].includes(to)) {
      throw new InvalidSessionTransitionError(from, to);
    }
    return to;
  }

  assertTransition(from: string, to: string) {
    this.transition(from, to);
  }

  /**
   * Whether (from → to) is legal, including same-status SUSPENDED re-reason.
   * @param from
   * @param to
   * @returns {boolean}
   */
  isLegalEdge(from: string, to: string) {
    if (!isSessionStatus(from) || !isSessionStatus(to)) return false;
    if (from === to && from === SESSION_STATUS.SUSPENDED) return true;
    return this.canTransition(from, to);
  }

  /**
   * Assert legal edge (transition or SUSPENDED re-reason).
   * @param from
   * @param to
   */
  assertLegalEdge(from: string, to: string) {
    this.assertStatus(from);
    this.assertStatus(to);
    if (from === to && from === SESSION_STATUS.SUSPENDED) return;
    this.assertTransition(from, to);
  }

  /**
   * Enter recovery: target status is always SUSPENDED with a recovery reason.
   * Only from ACTIVE (transition) or already SUSPENDED (idempotent re-reason).
   * CREATING→SUSPENDED is illegal.
   *
   * @param from
   * @param [reasonCode]
   * @returns {{ status: string, recoveryReasonCode: string }}
   */
  assertSuspendForRecovery(from: string, reasonCode: string = RECOVERY_REASON_CODE.RECOVERY_REQUIRED) {
    const code = assertRecoveryReasonCode(reasonCode);
    this.assertStatus(from);
    if (from === SESSION_STATUS.SUSPENDED) {
      return { status: SESSION_STATUS.SUSPENDED, recoveryReasonCode: code };
    }
    if (from !== SESSION_STATUS.ACTIVE) {
      throw new InvalidSessionTransitionError(
        from,
        SESSION_STATUS.SUSPENDED,
        `Recovery suspend only from ACTIVE or re-reason SUSPENDED, not ${String(from)}`,
      );
    }
    this.transition(from, SESSION_STATUS.SUSPENDED);
    return { status: SESSION_STATUS.SUSPENDED, recoveryReasonCode: code };
  }

  /**
   * Resume from recovery: SUSPENDED → ACTIVE and clear recovery reason.
   * @param from
   * @returns {{ status: string, recoveryReasonCode: null }}
   */
  assertResumeFromRecovery(from: string) {
    this.transition(from, SESSION_STATUS.ACTIVE);
    return { status: SESSION_STATUS.ACTIVE, recoveryReasonCode: null };
  }
}

/** Shared singleton — preferred entry for application services. */
export const sessionStateMachine = new SessionStateMachine();

export {
  SESSION_STATUS,
  SESSION_TRANSITIONS,
  TERMINAL_SESSION_STATUSES,
  TERMINAL_SESSION_STATUS_SET,
  ALL_SESSION_STATUSES,
  isSessionStatus,
  isTerminalSessionStatus,
};
