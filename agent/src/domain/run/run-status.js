/**
 * Plan §10 Run statuses (uppercase). Sole vocabulary for new Run authority.
 */

/** @typedef {typeof RUN_STATUS[keyof typeof RUN_STATUS]} RunStatus */

export const RUN_STATUS = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  QUEUED: 'QUEUED',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  WAITING_INPUT: 'WAITING_INPUT',
  CANCELLING: 'CANCELLING',
  RETRYING: 'RETRYING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

/** All plan §10 statuses. */
export const ALL_RUN_STATUSES = Object.freeze(Object.values(RUN_STATUS));

/** Terminal set (plan §10). */
export const TERMINAL_RUN_STATUSES = Object.freeze([
  RUN_STATUS.SUCCEEDED,
  RUN_STATUS.FAILED,
  RUN_STATUS.CANCELLED,
]);

export const TERMINAL_RUN_STATUS_SET = new Set(TERMINAL_RUN_STATUSES);

/**
 * Non-terminal statuses (recoverable by workers after restart).
 */
export const NON_TERMINAL_RUN_STATUSES = Object.freeze(
  ALL_RUN_STATUSES.filter((s) => !TERMINAL_RUN_STATUS_SET.has(s)),
);

/**
 * Allowed transitions exactly as plan §10 (no extra edges).
 * Keys and values are uppercase status strings.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const RUN_TRANSITIONS = Object.freeze({
  [RUN_STATUS.ACCEPTED]: Object.freeze([RUN_STATUS.QUEUED]),
  [RUN_STATUS.QUEUED]: Object.freeze([
    RUN_STATUS.STARTING,
    RUN_STATUS.CANCELLING,
  ]),
  [RUN_STATUS.STARTING]: Object.freeze([
    RUN_STATUS.RUNNING,
    RUN_STATUS.RETRYING,
    RUN_STATUS.FAILED,
  ]),
  [RUN_STATUS.RUNNING]: Object.freeze([
    RUN_STATUS.SUCCEEDED,
    RUN_STATUS.WAITING_APPROVAL,
    RUN_STATUS.WAITING_INPUT,
    RUN_STATUS.CANCELLING,
    RUN_STATUS.RETRYING,
    RUN_STATUS.FAILED,
  ]),
  [RUN_STATUS.WAITING_APPROVAL]: Object.freeze([RUN_STATUS.RUNNING]),
  [RUN_STATUS.WAITING_INPUT]: Object.freeze([RUN_STATUS.RUNNING]),
  [RUN_STATUS.CANCELLING]: Object.freeze([RUN_STATUS.CANCELLED]),
  [RUN_STATUS.RETRYING]: Object.freeze([
    RUN_STATUS.QUEUED,
    RUN_STATUS.FAILED,
  ]),
  [RUN_STATUS.SUCCEEDED]: Object.freeze([]),
  [RUN_STATUS.FAILED]: Object.freeze([]),
  [RUN_STATUS.CANCELLED]: Object.freeze([]),
});

/**
 * @param {unknown} status
 * @returns {status is RunStatus}
 */
export function isRunStatus(status) {
  return typeof status === 'string' && Object.hasOwn(RUN_TRANSITIONS, status);
}

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isTerminalRunStatus(status) {
  return typeof status === 'string' && TERMINAL_RUN_STATUS_SET.has(status);
}
