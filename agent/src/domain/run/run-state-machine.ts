/**
 * Sole RunStateMachine (plan §10).
 *
 * - Exact statuses/transitions, uppercase.
 * - Terminal set.
 * - Invalid transitions throw typed {@link InvalidRunTransitionError}.
 * - Does **not** write storage; repositories apply transitions under its control.
 */

import {
  ALL_RUN_STATUSES,
  isRunStatus,
  isTerminalRunStatus,
  RUN_STATUS,
  RUN_TRANSITIONS,
  TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_STATUS_SET,
} from './run-status.js';
import {
  InvalidRunStatusError,
  InvalidRunTransitionError,
} from './errors.js';
import { mapLegacyRuntimeOutcome } from './legacy-status.js';

/**
 * The single process-wide state machine instance. Services should use this
 * (or construct their own for tests) rather than ad-hoc transition tables.
 */
export class RunStateMachine {
  /**
   * @param status
   * @returns {asserts status is string}
   */
  assertStatus(status: unknown) {
    if (!isRunStatus(status)) {
      throw new InvalidRunStatusError(status);
    }
  }

  /**
   * @param status
   * @returns {boolean}
   */
  isTerminal(status: unknown) {
    return isTerminalRunStatus(status);
  }

  /**
   * @returns {readonly string[]}
   */
  terminalStatuses() {
    return TERMINAL_RUN_STATUSES;
  }

  /**
   * @returns {readonly string[]}
   */
  allStatuses() {
    return ALL_RUN_STATUSES;
  }

  /**
   * @param from
   * @returns {readonly string[]}
   */
  allowedTargets(from: string) {
    this.assertStatus(from);
    return RUN_TRANSITIONS[from];
  }

  /**
   * @param from
   * @param to
   * @returns {boolean}
   */
  canTransition(from: string, to: string) {
    if (!isRunStatus(from) || !isRunStatus(to)) return false;
    return RUN_TRANSITIONS[from].includes(to);
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
    if (!RUN_TRANSITIONS[from].includes(to)) {
      throw new InvalidRunTransitionError(from, to);
    }
    return to;
  }

  /**
   * Assert transition is allowed; throw typed error otherwise.
   * @param from
   * @param to
   */
  assertTransition(from: string, to: string) {
    this.transition(from, to);
  }

  /**
   * Normalize legacy runtime outcomes only through the explicit mapper.
   * @param outcome
   * @returns {string}
   */
  mapLegacyOutcome(outcome: unknown) {
    return mapLegacyRuntimeOutcome(outcome);
  }
}

/** Shared singleton — preferred entry for application services. */
export const runStateMachine = new RunStateMachine();

export {
  RUN_STATUS,
  RUN_TRANSITIONS,
  TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_STATUS_SET,
  ALL_RUN_STATUSES,
  isRunStatus,
  isTerminalRunStatus,
};
