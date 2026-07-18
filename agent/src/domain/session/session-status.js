/**
 * Plan §11 Agent Session statuses (uppercase) — exact formal vocabulary.
 *
 * Six statuses: CREATING | ACTIVE | SUSPENDED | CLOSING | CLOSED | FAILED.
 * RECOVERY_REQUIRED is **not** a status — it is recovery_reason_code on a
 * SUSPENDED session (plan §12.5 + PR-05).
 *
 * Exact adjacent edges (no CREATING→CLOSED, ACTIVE→CLOSED, SUSPENDED→CLOSED):
 *   CREATING → ACTIVE | FAILED
 *   ACTIVE   → CLOSING | SUSPENDED | FAILED
 *   SUSPENDED → ACTIVE | FAILED
 *   CLOSING  → CLOSED
 *   CLOSED / FAILED terminal
 */

/** @typedef {typeof SESSION_STATUS[keyof typeof SESSION_STATUS]} SessionStatus */

export const SESSION_STATUS = Object.freeze({
  CREATING: 'CREATING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  CLOSING: 'CLOSING',
  CLOSED: 'CLOSED',
  FAILED: 'FAILED',
});

/** All formal plan §11 statuses (no RECOVERY_REQUIRED). */
export const ALL_SESSION_STATUSES = Object.freeze(Object.values(SESSION_STATUS));

/** Terminal statuses — no further legal transitions. */
export const TERMINAL_SESSION_STATUSES = Object.freeze([
  SESSION_STATUS.CLOSED,
  SESSION_STATUS.FAILED,
]);

export const TERMINAL_SESSION_STATUS_SET = new Set(TERMINAL_SESSION_STATUSES);

/**
 * Statuses that may accept runs / snapshot commits.
 */
export const RUNNABLE_SESSION_STATUSES = Object.freeze([
  SESSION_STATUS.ACTIVE,
]);

/**
 * Exact allowed transitions (plan §11 adjacent edges).
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const SESSION_TRANSITIONS = Object.freeze({
  [SESSION_STATUS.CREATING]: Object.freeze([
    SESSION_STATUS.ACTIVE,
    SESSION_STATUS.FAILED,
  ]),
  [SESSION_STATUS.ACTIVE]: Object.freeze([
    SESSION_STATUS.CLOSING,
    SESSION_STATUS.SUSPENDED,
    SESSION_STATUS.FAILED,
  ]),
  [SESSION_STATUS.SUSPENDED]: Object.freeze([
    SESSION_STATUS.ACTIVE,
    SESSION_STATUS.FAILED,
  ]),
  [SESSION_STATUS.CLOSING]: Object.freeze([SESSION_STATUS.CLOSED]),
  [SESSION_STATUS.CLOSED]: Object.freeze([]),
  [SESSION_STATUS.FAILED]: Object.freeze([]),
});

/**
 * @param {unknown} status
 * @returns {status is SessionStatus}
 */
export function isSessionStatus(status) {
  return typeof status === 'string' && Object.hasOwn(SESSION_TRANSITIONS, status);
}

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isTerminalSessionStatus(status) {
  return typeof status === 'string' && TERMINAL_SESSION_STATUS_SET.has(status);
}
