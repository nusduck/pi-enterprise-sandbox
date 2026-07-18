/**
 * Approval statuses (plan §8.16). Schema has no unique on tool_execution_id —
 * idempotency is enforced by locking the tool_execution row and selecting
 * existing pending/terminal approvals before insert (B2).
 *
 * Decision/resolution APIs are PR-09; B2 only creates PENDING durable facts.
 */

export const APPROVAL_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
});

/** @type {readonly string[]} */
export const APPROVAL_STATUSES = Object.freeze(Object.values(APPROVAL_STATUS));

const TERMINAL = new Set([
  APPROVAL_STATUS.APPROVED,
  APPROVAL_STATUS.REJECTED,
  APPROVAL_STATUS.EXPIRED,
  APPROVAL_STATUS.CANCELLED,
]);

/**
 * @param {unknown} status
 */
export function isApprovalStatus(status) {
  return (
    typeof status === 'string' &&
    APPROVAL_STATUSES.includes(/** @type {any} */ (status))
  );
}

/**
 * @param {unknown} status
 */
export function assertApprovalStatus(status) {
  if (!isApprovalStatus(status)) {
    throw new Error(`Invalid approval status: ${String(status)}`);
  }
  return /** @type {string} */ (status);
}

/**
 * @param {string} status
 */
export function isTerminalApprovalStatus(status) {
  return TERMINAL.has(status);
}

/**
 * Typed durable pending signal for PiRunExecutor (not an in-process waiter).
 * B2: policy returns block + this signal; does NOT transition Run to
 * WAITING_APPROVAL (resume/checkpoint is PR-09).
 *
 * @typedef {{
 *   kind: 'DURABLE_APPROVAL_PENDING',
 *   approvalId: string,
 *   toolExecutionId: string,
 *   toolCallId: string,
 *   toolName: string,
 *   runId: string,
 *   status: 'PENDING',
 * }} DurableApprovalPendingSignal
 */

export const DURABLE_APPROVAL_PENDING = 'DURABLE_APPROVAL_PENDING';
