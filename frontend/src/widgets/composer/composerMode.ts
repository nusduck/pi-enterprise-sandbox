/**
 * Composer mode resolution (ADR 0003 §7) — pure helpers for tests + UI.
 */

export type ComposerMode = 'idle' | 'running' | 'waiting_approval' | 'waiting_input';

/** Interaction sub-mode while the agent is running. */
export type RunningAction = 'steer' | 'follow_up';

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

/** Human labels for mode chips. */
export function composerModeLabel(mode: ComposerMode): string {
  switch (mode) {
    case 'idle':
      return 'New task';
    case 'running':
      return 'Agent running';
    case 'waiting_approval':
      return 'Waiting approval';
    case 'waiting_input':
      return 'Waiting for input';
    default:
      return mode;
  }
}

/** Placeholder text for the composer textarea. */
export function composerPlaceholder(
  mode: ComposerMode,
  action: RunningAction = 'steer',
): string {
  if (mode === 'idle') {
    return 'Type a message… (Ctrl+L new chat)';
  }
  if (mode === 'waiting_approval') {
    return 'Add a note, or approve/reject above…';
  }
  if (mode === 'waiting_input') return 'Answer the agent…';
  if (action === 'follow_up') {
    return 'Follow-up: runs after the current task finishes…';
  }
  return 'Steer: change direction of the current run…';
}

/** Short help under the mode switcher. */
export function runningActionHint(action: RunningAction): string {
  if (action === 'follow_up') {
    return 'Follow-up queues work after the current run finishes.';
  }
  return 'Steer changes the current execution direction as soon as possible.';
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
