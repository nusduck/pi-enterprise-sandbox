/**
 * tools/execute 环绕：每 Run 工具数 / 轮次 / deadline。超限停止继续工具。
 */

export const DEFAULT_MAX_TOOL_CALLS = 200;
export const DEFAULT_MAX_MODEL_TURNS = 120;
export const DEFAULT_RUN_DEADLINE_MS = 30 * 60 * 1000;

export interface RunBudgetConfig {
  readonly maxToolCalls: number;
  readonly maxModelTurns: number;
  readonly runDeadlineMs: number;
  readonly startedAt: number;
}

export type BudgetVerdict = { ok: true } | { ok: false; reason: string };

export function resolveRunBudget(env: NodeJS.ProcessEnv = process.env, now = Date.now()): RunBudgetConfig {
  return {
    maxToolCalls: positiveInt(env['AGENT_RUN_MAX_TOOL_CALLS'], DEFAULT_MAX_TOOL_CALLS),
    maxModelTurns: positiveInt(env['AGENT_RUN_MAX_MODEL_TURNS'], DEFAULT_MAX_MODEL_TURNS),
    runDeadlineMs: positiveInt(env['AGENT_RUN_DEADLINE_MS'], DEFAULT_RUN_DEADLINE_MS),
    startedAt: now,
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error('run budget must be a positive integer');
  }
  return n;
}

export class RunBudget {
  private toolCalls = 0;
  private turns = 0;

  constructor(private readonly config: RunBudgetConfig, private readonly now: () => number = Date.now) {}

  recordTurn(): BudgetVerdict {
    this.turns += 1;
    return this.check('model turns');
  }

  recordToolCall(): BudgetVerdict {
    this.toolCalls += 1;
    return this.check('tool calls');
  }

  private check(what: string): BudgetVerdict {
    if (this.now() - this.config.startedAt >= this.config.runDeadlineMs) {
      return { ok: false, reason: `run deadline exceeded after ${what}` };
    }
    if (this.toolCalls > this.config.maxToolCalls) {
      return { ok: false, reason: `tool call budget exceeded (${this.config.maxToolCalls})` };
    }
    if (this.turns > this.config.maxModelTurns) {
      return { ok: false, reason: `model turn budget exceeded (${this.config.maxModelTurns})` };
    }
    return { ok: true };
  }
}

export function wrapExecute<T>(
  budget: RunBudget,
  fn: () => Promise<T>,
): Promise<T> {
  const verdict = budget.recordToolCall();
  if (!verdict.ok) {
    return Promise.reject(new Error(verdict.reason));
  }
  return fn();
}
