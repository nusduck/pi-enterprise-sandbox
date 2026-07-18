/**
 * Explicit mapping from legacy in-process runtime outcomes → plan §10 statuses.
 *
 * Only this function may normalize legacy runtime strings into the new
 * RunStateMachine vocabulary. Do not scatter ad-hoc maps elsewhere.
 */

import { RUN_STATUS } from './run-status.js';
import { UnknownLegacyOutcomeError } from './errors.js';

/**
 * Fixed exact-match map for known legacy outcomes.
 * @type {Readonly<Record<string, string>>}
 */
export const LEGACY_RUNTIME_OUTCOME_MAP = Object.freeze({
  completed: RUN_STATUS.SUCCEEDED,
  failed: RUN_STATUS.FAILED,
  budget_exceeded: RUN_STATUS.FAILED,
  rejected: RUN_STATUS.FAILED,
  cancelled: RUN_STATUS.CANCELLED,
  waiting_approval: RUN_STATUS.WAITING_APPROVAL,
  waiting_input: RUN_STATUS.WAITING_INPUT,
  // Common lower-case lifecycle strings seen in process-local RunManager.
  queued: RUN_STATUS.QUEUED,
  running: RUN_STATUS.RUNNING,
});

/**
 * Normalize a legacy runtime outcome string to plan §10 uppercase status.
 *
 * Rules (task brief):
 * - completed => SUCCEEDED
 * - failed / budget_exceeded / rejected => FAILED
 * - cancelled => CANCELLED
 * - waiting_* => WAITING_* (uppercase snake)
 *
 * Unknown outcomes throw {@link UnknownLegacyOutcomeError}.
 *
 * @param {unknown} outcome
 * @returns {string}
 */
export function mapLegacyRuntimeOutcome(outcome) {
  if (typeof outcome !== 'string' || outcome.length === 0) {
    throw new UnknownLegacyOutcomeError(outcome);
  }

  const raw = outcome.trim();
  if (!raw) throw new UnknownLegacyOutcomeError(outcome);

  const lower = raw.toLowerCase();
  if (Object.hasOwn(LEGACY_RUNTIME_OUTCOME_MAP, lower)) {
    return LEGACY_RUNTIME_OUTCOME_MAP[lower];
  }

  // waiting_* => WAITING_*
  if (lower.startsWith('waiting_')) {
    const suffix = lower.slice('waiting_'.length);
    if (!suffix || !/^[a-z][a-z0-9_]*$/.test(suffix)) {
      throw new UnknownLegacyOutcomeError(outcome);
    }
    return `WAITING_${suffix.toUpperCase()}`;
  }

  // Already a plan §10 status (uppercase) — accept as identity.
  if (Object.hasOwn(RUN_STATUS, raw)) {
    return raw;
  }

  throw new UnknownLegacyOutcomeError(outcome);
}
