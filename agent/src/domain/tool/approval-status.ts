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

export function isApprovalStatus(status: unknown) {
  return (
    typeof status === 'string' &&
    APPROVAL_STATUSES.includes((status as any))
  );
}

export function assertApprovalStatus(status: unknown) {
  if (!isApprovalStatus(status)) {
    throw new Error(`Invalid approval status: ${String(status)}`);
  }
  return (status as string);
}

export function isTerminalApprovalStatus(status: string) {
  // @ts-expect-error 未校验string传入闭合联合，运行时需窄化守卫，存活代码先用expect-error收敛 —— TS2345: Argument of type 'string' is not assignable to parameter of 
  return TERMINAL.has(status);
}

export const DURABLE_APPROVAL_PENDING = 'DURABLE_APPROVAL_PENDING';
