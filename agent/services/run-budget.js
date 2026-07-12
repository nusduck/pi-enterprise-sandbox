/**
 * Re-export budget helpers for run-manager convenience.
 * Kept as a thin alias so tests can import either path.
 */
export {
  DEFAULT_BUDGET_LIMITS,
  resolveBudgetLimits,
  createBudgetTracker,
} from './budget.js';
