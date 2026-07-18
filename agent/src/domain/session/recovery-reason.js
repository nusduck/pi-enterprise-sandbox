/**
 * Recovery reason codes for Agent Sessions (PR-05).
 *
 * These are **not** statuses. When recovery is required, status remains
 * SUSPENDED and recovery_reason_code is set (plan §12.5).
 */

/** @typedef {typeof RECOVERY_REASON_CODE[keyof typeof RECOVERY_REASON_CODE]} RecoveryReasonCode */

export const RECOVERY_REASON_CODE = Object.freeze({
  /** Snapshot vs message/event journal checksum or version mismatch. */
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  /** Worker lost lease mid-run; durable reconciliation needed. */
  LEASE_LOST: 'LEASE_LOST',
  /** Pi snapshot missing or checksum failed; rebuild from journal. */
  SNAPSHOT_INVALID: 'SNAPSHOT_INVALID',
  /** SDK / snapshot_format incompatibility. */
  VERSION_INCOMPATIBLE: 'VERSION_INCOMPATIBLE',
});

export const ALL_RECOVERY_REASON_CODES = Object.freeze(
  Object.values(RECOVERY_REASON_CODE),
);

export const RECOVERY_REASON_CODE_SET = new Set(ALL_RECOVERY_REASON_CODES);

/**
 * @param {unknown} code
 * @returns {boolean}
 */
export function isRecoveryReasonCode(code) {
  return typeof code === 'string' && RECOVERY_REASON_CODE_SET.has(code);
}

/**
 * @param {unknown} code
 * @param {string} [field]
 * @returns {string}
 */
export function assertRecoveryReasonCode(code, field = 'recoveryReasonCode') {
  if (!isRecoveryReasonCode(code)) {
    throw new Error(
      `Invalid ${field}: expected known recovery reason code, got ${String(code)}`,
    );
  }
  return /** @type {string} */ (code);
}
