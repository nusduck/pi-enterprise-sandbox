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

const RUN_STREAM_MAXLEN_MIN = 100;
const RUN_STREAM_MAXLEN_MAX = 1_000_000;

/**
 * `AGENT_RUN_STREAM_MAXLEN`（deployment.md 运行时变量表）。未设置用默认值；非法或越界（[100, 1_000_000] 之外）
 * 回退默认值并告警——不抛错：两处装配都在 try 里，抛错会让 stream 被静默置空，比用默认值更糟。
 */
export function runStreamMaxLenFromEnv(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = (m) => console.warn(m),
): number {
  const raw = String(env.AGENT_RUN_STREAM_MAXLEN ?? '').trim();
  if (raw === '') return RUN_STREAM_MAXLEN;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= RUN_STREAM_MAXLEN_MIN && n <= RUN_STREAM_MAXLEN_MAX) return n;
  warn(`[agent] AGENT_RUN_STREAM_MAXLEN=${raw} is not an integer in [${RUN_STREAM_MAXLEN_MIN}, ${RUN_STREAM_MAXLEN_MAX}]; using ${RUN_STREAM_MAXLEN}`);
  return RUN_STREAM_MAXLEN;
}

/**
 * Cancel signal TTL (ms). Signal-only; MySQL remains fact source for cancel intent.
 * Long enough to outlive typical run + recovery windows.
 */
export const CANCEL_SIGNAL_TTL_MS = 86_400_000;

/** BullMQ logical queue name for Agent runs (keys under {bull}:agent-runs:… by default prefix). */
export const AGENT_RUNS_QUEUE_NAME = 'agent-runs';

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
 * @param runId Crockford ULID
 * @returns {string}
 */
export function runLeaseKey(runId: string) {
  return `run:lease:${assertRunId(runId)}`;
}

/**
 * @param runId Crockford ULID
 * @returns {string}
 */
export function runCancelKey(runId: string) {
  return `run:cancel:${assertRunId(runId)}`;
}

/**
 * @param runId Crockford ULID
 * @returns {string}
 */
export function runStreamKey(runId: string) {
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
 * @param agentSessionId Crockford ULID
 * @returns {string}
 */
export function sessionLockKey(agentSessionId: string) {
  return `agent:session-lock:${assertAgentSessionId(agentSessionId)}`;
}
