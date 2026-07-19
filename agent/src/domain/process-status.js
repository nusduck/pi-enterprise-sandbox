/**
 * Public ProcessHandle status vocabulary from packages/contracts.
 * Sandbox has a few finer-grained internal states; collapse those only at the
 * public boundary so Run and ToolExecution status vocabularies stay separate.
 */

export const PROCESS_STATUS = Object.freeze({
  STARTING: 'starting',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
  LOST: 'lost',
  ORPHANED: 'orphaned',
});

const PUBLIC_PROCESS_STATUSES = new Set(Object.values(PROCESS_STATUS));
const INTERNAL_PROCESS_STATUS_ALIASES = Object.freeze({
  created: PROCESS_STATUS.STARTING,
  waiting_input: PROCESS_STATUS.RUNNING,
  cancel_requested: PROCESS_STATUS.RUNNING,
});

/**
 * @param {unknown} status
 * @param {string | null} [fallback]
 * @returns {string}
 */
export function normalizeProcessStatus(status, fallback = null) {
  const raw = String(status ?? fallback ?? '').trim().toLowerCase();
  const normalized = INTERNAL_PROCESS_STATUS_ALIASES[raw] ?? raw;
  if (PUBLIC_PROCESS_STATUSES.has(normalized)) return normalized;

  const err = new Error(`Invalid process status: ${String(status)}`);
  /** @type {any} */ (err).code = 'PROCESS_STATUS_INVALID';
  throw err;
}
