/**
 * Run domain (plan §10) — status vocabulary + sole state machine.
 * No storage writes live here.
 */

export {
  InvalidRunTransitionError,
  InvalidRunStatusError,
  UnknownLegacyOutcomeError,
} from './errors.js';

export {
  RUN_STATUS,
  ALL_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_STATUS_SET,
  NON_TERMINAL_RUN_STATUSES,
  RUN_TRANSITIONS,
  isRunStatus,
  isTerminalRunStatus,
} from './run-status.js';

export {
  LEGACY_RUNTIME_OUTCOME_MAP,
  mapLegacyRuntimeOutcome,
} from './legacy-status.js';

export {
  RunStateMachine,
  runStateMachine,
} from './run-state-machine.js';
