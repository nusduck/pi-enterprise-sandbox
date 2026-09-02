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
  // @ts-expect-error 未校验string传入闭合联合，运行时需窄化守卫，存活代码先用expect-error收敛 —— TS2345: Argument of type 'string' is not assignable to parameter of 
  if (!Object.values(INTERACTION_RESUME_PHASE).includes(phase)) {
    throw new Error(`Invalid interaction resume phase: ${String(value)}`);
  }
  return phase;
}

export const DURABLE_INTERACTION_PENDING = 'DURABLE_INTERACTION_PENDING';

export const INTERACTION_TYPES = Object.freeze(['input', 'select', 'confirm']);

export function assertInteractionType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!INTERACTION_TYPES.includes(type)) {
    throw new Error(`interaction_type must be one of ${INTERACTION_TYPES.join(', ')}`);
  }
  return type;
}
