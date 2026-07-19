/** Durable user-interaction lifecycle states. */

export const INTERACTION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  RESOLVED: 'RESOLVED',
  CANCELLED: 'CANCELLED',
});

/**
 * Continuation phase is separate from the request lifecycle. RESOLVED is the
 * immutable user-answer fact; this phase fences the Worker/Pi hand-off across
 * a process crash.
 */
export const INTERACTION_RESUME_PHASE = Object.freeze({
  NONE: 'NONE',
  READY: 'READY',
  CLAIMED: 'CLAIMED',
  APPLIED: 'APPLIED',
});

export function assertInteractionResumePhase(value) {
  const phase = String(value || '').trim().toUpperCase();
  if (!Object.values(INTERACTION_RESUME_PHASE).includes(phase)) {
    throw new Error(`Invalid interaction resume phase: ${String(value)}`);
  }
  return phase;
}

export const DURABLE_INTERACTION_PENDING = 'DURABLE_INTERACTION_PENDING';

export function assertInteractionStatus(value) {
  const status = String(value || '').trim().toUpperCase();
  if (!Object.values(INTERACTION_STATUS).includes(status)) {
    throw new Error(`Invalid interaction status: ${String(value)}`);
  }
  return status;
}

export function isTerminalInteractionStatus(value) {
  return [
    INTERACTION_STATUS.RESOLVED,
    INTERACTION_STATUS.CANCELLED,
  ].includes(String(value || '').toUpperCase());
}

export const INTERACTION_TYPES = Object.freeze(['input', 'select', 'confirm']);

export function assertInteractionType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!INTERACTION_TYPES.includes(type)) {
    throw new Error(`interaction_type must be one of ${INTERACTION_TYPES.join(', ')}`);
  }
  return type;
}
