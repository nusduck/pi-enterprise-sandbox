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
 * @param status
 * @returns {boolean}
 */
export function isToolExecutionStatus(status: unknown) {
  return (
    typeof status === 'string' &&
    TOOL_EXECUTION_STATUSES.includes((status as any))
  );
}

export function assertToolExecutionStatus(status: unknown) {
  if (!isToolExecutionStatus(status)) {
    throw new Error(`Invalid tool execution status: ${String(status)}`);
  }
  return (status as string);
}

export function isTerminalToolExecutionStatus(status: string) {
  // @ts-expect-error 未校验string传入闭合联合，运行时需窄化守卫，存活代码先用expect-error收敛 —— TS2345: Argument of type 'string' is not assignable to parameter of 
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

export function canTransitionToolExecution(from: string, to: string) {
  const allowed = TOOL_EXECUTION_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function assertToolSource(source: unknown) {
  if (!TOOL_SOURCES.includes((source as any))) {
    throw new Error(`Invalid tool_source: ${String(source)}`);
  }
  return (source as string);
}

export function assertToolRiskLevel(risk: unknown) {
  if (!TOOL_RISK_LEVELS.includes((risk as any))) {
    throw new Error(`Invalid risk_level: ${String(risk)}`);
  }
  return (risk as string);
}
