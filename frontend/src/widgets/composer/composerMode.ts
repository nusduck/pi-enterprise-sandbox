/**
 * Composer mode resolution (ADR 0003 §7) — pure helpers for tests + UI.
 */

export type ComposerMode = 'idle' | 'running' | 'waiting_approval' | 'waiting_input';

export type ComposerModeInput = {
  isStreaming?: boolean;
  runStatus?: string | null;
  hasPendingApproval?: boolean;
};

const RUNNING_STATUSES = new Set([
  'queued',
  'restoring_session',
  'running',
  'cancel_requested',
]);

/**
 * Resolve composer mode from stream + run entity state.
 *
 * Priority: waiting_approval > running > idle.
 */
export function resolveComposerMode(input: ComposerModeInput): ComposerMode {
  const status = input.runStatus || null;
  if (input.hasPendingApproval || status === 'waiting_approval') {
    return 'waiting_approval';
  }
  if (status === 'waiting_input') return 'waiting_input';
  if (input.isStreaming || (status != null && RUNNING_STATUSES.has(status))) {
    return 'running';
  }
  return 'idle';
}

/** True when the run can accept steer (must be actively running). */
export function canSteer(mode: ComposerMode, runStatus?: string | null): boolean {
  return mode === 'running' && runStatus === 'running';
}

/** True when follow-up is allowed (running or waiting_approval). */
export function canFollowUp(mode: ComposerMode): boolean {
  return mode === 'running' || mode === 'waiting_approval';
}

/** True when Stop should be offered. */
export function canStop(mode: ComposerMode): boolean {
  return mode === 'running' || mode === 'waiting_approval' || mode === 'waiting_input';
}

/**
 * Whether an interrupted run (or message) should show a Resume entry.
 */
export function shouldShowResumeEntry(opts: {
  runStatus?: string | null;
  lastMessageInterrupted?: boolean;
  isStreaming?: boolean;
}): boolean {
  if (opts.isStreaming) return false;
  if (opts.runStatus === 'interrupted') return true;
  if (opts.lastMessageInterrupted) return true;
  return false;
}
