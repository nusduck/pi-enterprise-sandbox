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
   * @param {unknown} status
   * @returns {asserts status is string}
   */
  assertStatus(status) {
    if (!isRunStatus(status)) {
      throw new InvalidRunStatusError(status);
    }
  }

  /**
   * @param {unknown} status
   * @returns {boolean}
   */
  isTerminal(status) {
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
   * @param {string} from
   * @returns {readonly string[]}
   */
  allowedTargets(from) {
    this.assertStatus(from);
    return RUN_TRANSITIONS[from];
  }

  /**
   * @param {string} from
   * @param {string} to
   * @returns {boolean}
   */
  canTransition(from, to) {
    if (!isRunStatus(from) || !isRunStatus(to)) return false;
    return RUN_TRANSITIONS[from].includes(to);
  }

  /**
   * Validate and return the target status. No I/O.
   * @param {string} from
   * @param {string} to
   * @returns {string}
   */
  transition(from, to) {
    this.assertStatus(from);
    this.assertStatus(to);
    if (!RUN_TRANSITIONS[from].includes(to)) {
      throw new InvalidRunTransitionError(from, to);
    }
    return to;
  }

  /**
   * Assert transition is allowed; throw typed error otherwise.
   * @param {string} from
   * @param {string} to
   */
  assertTransition(from, to) {
    this.transition(from, to);
  }

  /**
   * Normalize legacy runtime outcomes only through the explicit mapper.
   * @param {unknown} outcome
   * @returns {string}
   */
  mapLegacyOutcome(outcome) {
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
