/**
 * Canonical Redis keys and coordination constants (plan §9).
 *
 * Redis holds runtime coordination only — never authoritative Run status.
 * Key builders validate runId (ULID) so arbitrary / namespace-like IDs cannot enter keys.
 */

import { assertAgentSessionId, assertRunId } from './validation.js';

/** Worker lease TTL (ms). SET … PX uses this value. */
export const LEASE_TTL_MS = 30_000;

/** Suggested lease renew interval (ms). Callers schedule renew; not automatic. */
export const LEASE_RENEW_INTERVAL_MS = 10_000;

/** Approximate max entries retained per run stream (XADD MAXLEN ~). */
export const RUN_STREAM_MAXLEN = 10_000;

/**
 * Cancel signal TTL (ms). Signal-only; MySQL remains fact source for cancel intent.
 * Long enough to outlive typical run + recovery windows.
 */
export const CANCEL_SIGNAL_TTL_MS = 86_400_000;

/** BullMQ logical queue name for Agent runs (keys under bull:agent-runs:…). */
export const AGENT_RUNS_QUEUE_NAME = 'agent-runs';

/** Outbox publisher wakeup channel / key (plan §9.2). */
export const OUTBOX_WAKEUP_KEY = 'outbox:wakeup';

/**
 * Job payload must be a pure reference — no conversation/dataset blobs.
 * @type {readonly string[]}
 */
export const RUN_JOB_REF_FIELDS = Object.freeze([
  'runId',
  'orgId',
  'traceId',
]);

/** Optional W3C carrier fields persisted with a BullMQ reference. */
export const RUN_JOB_TRACE_FIELDS = Object.freeze(['traceparent', 'tracestate']);

/**
 * @param {string} runId Crockford ULID
 * @returns {string}
 */
export function runLeaseKey(runId) {
  return `run:lease:${assertRunId(runId)}`;
}

/**
 * @param {string} runId Crockford ULID
 * @returns {string}
 */
export function runCancelKey(runId) {
  return `run:cancel:${assertRunId(runId)}`;
}

/**
 * @param {string} runId Crockford ULID
 * @returns {string}
 */
export function runStreamKey(runId) {
  return `run:stream:${assertRunId(runId)}`;
}

/** Session lock TTL (ms). SET … PX uses this value. Coordination only. */
export const SESSION_LOCK_TTL_MS = 30_000;

/** Suggested session lock renew interval (ms). Callers schedule renew. */
export const SESSION_LOCK_RENEW_INTERVAL_MS = 10_000;

/**
 * Canonical session lock key (PR-05).
 * Absence/busy must never be interpreted as Agent Session status.
 *
 * @param {string} agentSessionId Crockford ULID
 * @returns {string}
 */
export function sessionLockKey(agentSessionId) {
  return `agent:session-lock:${assertAgentSessionId(agentSessionId)}`;
}
