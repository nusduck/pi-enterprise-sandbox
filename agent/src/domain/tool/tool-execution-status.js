/**
 * ToolExecution statuses justified by plan §8.12 schema + platform tool events.
 *
 * Schema stores free-form VARCHAR(32); these are the only production values.
 * No migration: transitions enforced transactionally in repositories.
 *
 * Note: tool_executions has no org_id/user_id — owner scope is via owned Run join.
 */

export const TOOL_EXECUTION_STATUS = Object.freeze({
  /** Policy accepted call; execution not started. */
  PROPOSED: 'PROPOSED',
  /** Policy require_approval; durable pending, tool must not execute. */
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  /** tool.execution.started */
  RUNNING: 'RUNNING',
  /** tool.execution.completed */
  SUCCEEDED: 'SUCCEEDED',
  /** tool.execution.failed or policy deny */
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  /**
   * Ambiguous / unknown outcome (PR-07B). Terminal fail-closed.
   * ONLY reachable from RUNNING; no outgoing transitions.
   * Must not be used for ordinary tool errors (those stay FAILED).
   */
  UNKNOWN: 'UNKNOWN',
});

/** @type {readonly string[]} */
export const TOOL_EXECUTION_STATUSES = Object.freeze(
  Object.values(TOOL_EXECUTION_STATUS),
);

export const TOOL_SOURCE = Object.freeze({
  SANDBOX: 'sandbox',
  MCP: 'mcp',
  INTERNAL: 'internal',
});

/** @type {readonly string[]} */
export const TOOL_SOURCES = Object.freeze(Object.values(TOOL_SOURCE));

export const TOOL_RISK_LEVEL = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

/** @type {readonly string[]} */
export const TOOL_RISK_LEVELS = Object.freeze(Object.values(TOOL_RISK_LEVEL));

const TERMINAL = new Set([
  TOOL_EXECUTION_STATUS.SUCCEEDED,
  TOOL_EXECUTION_STATUS.FAILED,
  TOOL_EXECUTION_STATUS.CANCELLED,
  TOOL_EXECUTION_STATUS.UNKNOWN,
]);

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isToolExecutionStatus(status) {
  return (
    typeof status === 'string' &&
    TOOL_EXECUTION_STATUSES.includes(/** @type {any} */ (status))
  );
}

/**
 * @param {unknown} status
 */
export function assertToolExecutionStatus(status) {
  if (!isToolExecutionStatus(status)) {
    throw new Error(`Invalid tool execution status: ${String(status)}`);
  }
  return /** @type {string} */ (status);
}

/**
 * @param {string} status
 */
export function isTerminalToolExecutionStatus(status) {
  return TERMINAL.has(status);
}

/**
 * Allowed transitions (transactionally enforced).
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const TOOL_EXECUTION_TRANSITIONS = Object.freeze({
  [TOOL_EXECUTION_STATUS.PROPOSED]: Object.freeze([
    TOOL_EXECUTION_STATUS.RUNNING,
    TOOL_EXECUTION_STATUS.WAITING_APPROVAL,
    TOOL_EXECUTION_STATUS.FAILED,
    TOOL_EXECUTION_STATUS.CANCELLED,
  ]),
  [TOOL_EXECUTION_STATUS.WAITING_APPROVAL]: Object.freeze([
    // Approval replay claims the exact durable tool call before executing it.
    TOOL_EXECUTION_STATUS.RUNNING,
    TOOL_EXECUTION_STATUS.CANCELLED,
    TOOL_EXECUTION_STATUS.FAILED,
  ]),
  [TOOL_EXECUTION_STATUS.RUNNING]: Object.freeze([
    TOOL_EXECUTION_STATUS.SUCCEEDED,
    TOOL_EXECUTION_STATUS.FAILED,
    TOOL_EXECUTION_STATUS.CANCELLED,
    // Explicit ambiguous completion only (not ordinary errors).
    TOOL_EXECUTION_STATUS.UNKNOWN,
  ]),
  [TOOL_EXECUTION_STATUS.SUCCEEDED]: Object.freeze([]),
  [TOOL_EXECUTION_STATUS.FAILED]: Object.freeze([]),
  [TOOL_EXECUTION_STATUS.CANCELLED]: Object.freeze([]),
  [TOOL_EXECUTION_STATUS.UNKNOWN]: Object.freeze([]),
});

/**
 * @param {string} from
 * @param {string} to
 */
export function canTransitionToolExecution(from, to) {
  const allowed = TOOL_EXECUTION_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * @param {unknown} source
 */
export function assertToolSource(source) {
  if (!TOOL_SOURCES.includes(/** @type {any} */ (source))) {
    throw new Error(`Invalid tool_source: ${String(source)}`);
  }
  return /** @type {string} */ (source);
}

/**
 * @param {unknown} risk
 */
export function assertToolRiskLevel(risk) {
  if (!TOOL_RISK_LEVELS.includes(/** @type {any} */ (risk))) {
    throw new Error(`Invalid risk_level: ${String(risk)}`);
  }
  return /** @type {string} */ (risk);
}
