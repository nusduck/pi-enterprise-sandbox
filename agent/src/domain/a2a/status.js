/**
 * A2A Task status vocabulary + projection from Internal Run (plan §20.4).
 *
 * A2A Task status is NEVER an independent state machine. Always project from
 * the authoritative Run row / RunEvent payload.
 */

import { RUN_STATUS, isRunStatus } from '../run/run-status.js';

/** @typedef {typeof A2A_TASK_STATUS[keyof typeof A2A_TASK_STATUS]} A2aTaskStatus */

export const A2A_TASK_STATUS = Object.freeze({
  SUBMITTED: 'submitted',
  WORKING: 'working',
  INPUT_REQUIRED: 'input-required',
  AUTH_REQUIRED: 'auth-required',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
});

export const ALL_A2A_TASK_STATUSES = Object.freeze(Object.values(A2A_TASK_STATUS));

export const TERMINAL_A2A_TASK_STATUSES = Object.freeze([
  A2A_TASK_STATUS.COMPLETED,
  A2A_TASK_STATUS.FAILED,
  A2A_TASK_STATUS.CANCELED,
]);

export const TERMINAL_A2A_TASK_STATUS_SET = new Set(TERMINAL_A2A_TASK_STATUSES);

/**
 * Plan §20.4 Internal Run → A2A Task status.
 *
 * WAITING_APPROVAL → auth-required (plan allows auth-required or working+metadata).
 * CANCELLING / RETRYING map to working (in-progress), not a second authority.
 *
 * @param {unknown} runStatus
 * @returns {A2aTaskStatus}
 */
export function projectRunStatusToA2a(runStatus) {
  if (!isRunStatus(runStatus)) {
    // Unknown/corrupt run status must not invent protocol states.
    return A2A_TASK_STATUS.FAILED;
  }
  switch (runStatus) {
    case RUN_STATUS.ACCEPTED:
    case RUN_STATUS.QUEUED:
      return A2A_TASK_STATUS.SUBMITTED;
    case RUN_STATUS.STARTING:
    case RUN_STATUS.RUNNING:
    case RUN_STATUS.RETRYING:
    case RUN_STATUS.CANCELLING:
      return A2A_TASK_STATUS.WORKING;
    case RUN_STATUS.WAITING_INPUT:
      return A2A_TASK_STATUS.INPUT_REQUIRED;
    case RUN_STATUS.WAITING_APPROVAL:
      return A2A_TASK_STATUS.AUTH_REQUIRED;
    case RUN_STATUS.SUCCEEDED:
      return A2A_TASK_STATUS.COMPLETED;
    case RUN_STATUS.FAILED:
      return A2A_TASK_STATUS.FAILED;
    case RUN_STATUS.CANCELLED:
      return A2A_TASK_STATUS.CANCELED;
    default:
      return A2A_TASK_STATUS.FAILED;
  }
}

/**
 * @param {unknown} status
 * @returns {status is A2aTaskStatus}
 */
export function isA2aTaskStatus(status) {
  return typeof status === 'string' && ALL_A2A_TASK_STATUSES.includes(status);
}

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isTerminalA2aTaskStatus(status) {
  return typeof status === 'string' && TERMINAL_A2A_TASK_STATUS_SET.has(status);
}
