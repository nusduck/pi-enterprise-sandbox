/**
 * A2A domain vocabulary (plan §20) — pure projection helpers, no I/O.
 */

export {
  A2A_TASK_STATUS,
  ALL_A2A_TASK_STATUSES,
  TERMINAL_A2A_TASK_STATUSES,
  TERMINAL_A2A_TASK_STATUS_SET,
  projectRunStatusToA2a,
  isA2aTaskStatus,
  isTerminalA2aTaskStatus,
} from './status.js';

export {
  A2A_SCOPES,
  ALL_A2A_SCOPES,
  DEFAULT_A2A_SCOPES,
  normalizeScopes,
  hasScope,
} from './scopes.js';
