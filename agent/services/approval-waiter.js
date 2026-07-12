/**
 * Durable-aware approval waiters (B6).
 *
 * Replaces in-tool fixed-time polling:
 * - In-process: deferred promises resolved by decide/resume APIs
 * - Across restart: waiters re-created for waiting_approval runs; decisions
 *   come from sandbox GET /approvals/{id} without a fixed max wait
 *
 * No APPROVAL_MAX_WAIT_MS kill-switch inside tool code paths.
 */

/**
 * @typedef {object} ApprovalDecision
 * @property {'approved'|'rejected'} status
 * @property {string} [reason]
 * @property {string} [approval_id]
 */

/**
 * @typedef {object} PendingApproval
 * @property {string} approval_id
 * @property {string} tool_name
 * @property {string} [tool_call_id]
 * @property {object} [params]
 * @property {string} [run_id]
 * @property {string} [conversation_id]
 * @property {string} [sandbox_session_id]
 * @property {string} [agent_session_id]
 * @property {string} [reason]
 * @property {string} [risk_level]
 * @property {string} [policy_version]
 */

/** @type {Map<string, { resolve: (d: ApprovalDecision) => void, reject: (e: Error) => void, promise: Promise<ApprovalDecision> }>} */
const waiters = new Map();

/** @type {Map<string, PendingApproval>} */
const pendingByApproval = new Map();

/** @type {Map<string, string>} runId → approvalId */
const runToApproval = new Map();

/**
 * Register pending approval context and return a promise that resolves when decided.
 * Idempotent for the same approval_id (returns the same promise).
 *
 * @param {PendingApproval} pending
 * @returns {Promise<ApprovalDecision>}
 */
export function waitForApproval(pending) {
  if (!pending?.approval_id) {
    return Promise.reject(new Error('approval_id required'));
  }
  const id = pending.approval_id;
  pendingByApproval.set(id, { ...pending });
  if (pending.run_id) runToApproval.set(pending.run_id, id);

  const existing = waiters.get(id);
  if (existing) return existing.promise;

  /** @type {{ resolve: (d: ApprovalDecision) => void, reject: (e: Error) => void, promise: Promise<ApprovalDecision> }} */
  const entry = { resolve: () => {}, reject: () => {}, promise: null };
  entry.promise = new Promise((resolve, reject) => {
    entry.resolve = resolve;
    entry.reject = reject;
  });
  // Prevent unhandled rejection if nobody awaits after process teardown
  entry.promise.catch(() => {});
  waiters.set(id, entry);
  return entry.promise;
}

/**
 * Resolve a waiting approval (from decide API or sandbox poll).
 * @param {string} approvalId
 * @param {ApprovalDecision} decision
 * @returns {boolean} true if a waiter was resolved
 */
export function resolveApproval(approvalId, decision) {
  const entry = waiters.get(approvalId);
  if (!entry) return false;
  waiters.delete(approvalId);
  entry.resolve({
    status: decision.status,
    reason: decision.reason,
    approval_id: approvalId,
  });
  return true;
}

/**
 * @param {string} approvalId
 */
export function getPendingApproval(approvalId) {
  return pendingByApproval.get(approvalId) || null;
}

/**
 * @param {string} runId
 */
export function getPendingApprovalForRun(runId) {
  const aid = runToApproval.get(runId);
  if (!aid) return null;
  return pendingByApproval.get(aid) || null;
}

/**
 * Clear pending bookkeeping after resume completes (or reject terminal).
 * @param {string} approvalId
 */
export function clearPendingApproval(approvalId) {
  const pending = pendingByApproval.get(approvalId);
  if (pending?.run_id) runToApproval.delete(pending.run_id);
  pendingByApproval.delete(approvalId);
  // Leave waiter if still present so late resolve is harmless
  waiters.delete(approvalId);
}

/**
 * @param {string} runId
 */
export function clearPendingForRun(runId) {
  const aid = runToApproval.get(runId);
  if (aid) clearPendingApproval(aid);
}

/** Test helper */
export function _resetApprovalWaiters() {
  waiters.clear();
  pendingByApproval.clear();
  runToApproval.clear();
}

/**
 * Error thrown to park a run without completing the in-flight tool via poll.
 * Tool ledger stays waiting_approval; resources are released by the runner.
 */
export class ApprovalSuspendedError extends Error {
  /**
   * @param {PendingApproval} pending
   */
  constructor(pending) {
    super(`Approval suspended: ${pending?.approval_id || 'unknown'}`);
    this.name = 'ApprovalSuspendedError';
    this.pending = pending;
  }
}
