/**
 * Run-level budget accounting (ADR §4.9).
 * Counters are process-local; limits may come from create-run body or defaults.
 */

/** @typedef {object} BudgetLimits
 * @property {number|null} [max_steps]
 * @property {number|null} [max_tool_calls]
 * @property {number|null} [max_run_duration]  seconds
 * @property {number|null} [max_llm_tokens]
 * @property {number|null} [max_cost]
 * @property {number|null} [max_consecutive_tool_failures]
 * @property {number|null} [max_processes]
 */

/** @typedef {object} BudgetUsage
 * @property {number} steps
 * @property {number} tool_calls
 * @property {number} llm_tokens
 * @property {number} cost
 * @property {number} consecutive_tool_failures
 * @property {number} processes
 * @property {number} started_at
 */

export const DEFAULT_BUDGET_LIMITS = Object.freeze({
  max_steps: 50,
  max_tool_calls: 100,
  max_run_duration: 600,
  max_llm_tokens: 500_000,
  max_cost: null,
  max_consecutive_tool_failures: 8,
  max_processes: 10,
});

/**
 * Normalize partial budget overrides against defaults.
 * Explicit `null` means unlimited for that dimension.
 * @param {Partial<BudgetLimits>|null|undefined} overrides
 * @returns {BudgetLimits}
 */
export function resolveBudgetLimits(overrides = null) {
  const out = { ...DEFAULT_BUDGET_LIMITS };
  if (!overrides || typeof overrides !== 'object') return out;
  for (const key of Object.keys(DEFAULT_BUDGET_LIMITS)) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      const v = overrides[key];
      if (v === null) {
        out[key] = null;
      } else if (v === undefined || v === '') {
        // keep default
      } else {
        const n = Number(v);
        out[key] = Number.isFinite(n) && n >= 0 ? n : out[key];
      }
    }
  }
  return out;
}

/**
 * @param {Partial<BudgetLimits>|null|undefined} [limits]
 */
export function createBudgetTracker(limits = null) {
  const resolved = resolveBudgetLimits(limits);
  /** @type {BudgetUsage} */
  const usage = {
    steps: 0,
    tool_calls: 0,
    llm_tokens: 0,
    cost: 0,
    consecutive_tool_failures: 0,
    processes: 0,
    started_at: Date.now(),
  };

  let nearWarned = false;
  let exceeded = false;
  /** @type {string|null} */
  let exceededReason = null;

  function durationSeconds() {
    return (Date.now() - usage.started_at) / 1000;
  }

  /**
   * @returns {{ exceeded: boolean, reason?: string, dimension?: string, usage: object, limits: BudgetLimits }}
   */
  function check() {
    if (exceeded) {
      return {
        exceeded: true,
        reason: exceededReason || 'budget_exceeded',
        usage: snapshot(),
        limits: resolved,
      };
    }
    const checks = [
      ['max_steps', usage.steps, 'steps'],
      ['max_tool_calls', usage.tool_calls, 'tool_calls'],
      ['max_llm_tokens', usage.llm_tokens, 'llm_tokens'],
      ['max_cost', usage.cost, 'cost'],
      ['max_consecutive_tool_failures', usage.consecutive_tool_failures, 'consecutive_tool_failures'],
      ['max_processes', usage.processes, 'processes'],
      ['max_run_duration', durationSeconds(), 'run_duration'],
    ];
    for (const [limitKey, value, dim] of checks) {
      const lim = resolved[limitKey];
      if (lim == null) continue;
      if (value > lim || (limitKey === 'max_run_duration' && value >= lim && lim === 0)) {
        // strict: value > limit; for duration also treat == when limit is 0
        if (value > lim) {
          exceeded = true;
          exceededReason = `${dim} exceeded limit ${lim} (used ${typeof value === 'number' ? (Number.isInteger(value) ? value : value.toFixed(2)) : value})`;
          return {
            exceeded: true,
            reason: exceededReason,
            dimension: dim,
            usage: snapshot(),
            limits: resolved,
          };
        }
      }
      // duration: >= limit means exceeded (time is continuous)
      if (limitKey === 'max_run_duration' && value >= lim) {
        exceeded = true;
        exceededReason = `run_duration exceeded limit ${lim}s`;
        return {
          exceeded: true,
          reason: exceededReason,
          dimension: 'run_duration',
          usage: snapshot(),
          limits: resolved,
        };
      }
    }
    return { exceeded: false, usage: snapshot(), limits: resolved };
  }

  /**
   * True when any dimension is at ≥80% of its limit (for converge hints).
   */
  function isNearLimit() {
    const ratios = [];
    const map = [
      [resolved.max_steps, usage.steps],
      [resolved.max_tool_calls, usage.tool_calls],
      [resolved.max_llm_tokens, usage.llm_tokens],
      [resolved.max_cost, usage.cost],
      [resolved.max_processes, usage.processes],
      [resolved.max_run_duration, durationSeconds()],
    ];
    for (const [lim, val] of map) {
      if (lim == null || lim <= 0) continue;
      ratios.push(val / lim);
    }
    return ratios.some((r) => r >= 0.8);
  }

  function consumeNearWarning() {
    if (nearWarned) return false;
    if (!isNearLimit()) return false;
    nearWarned = true;
    return true;
  }

  function recordStep() {
    usage.steps += 1;
    return check();
  }

  function recordToolCall({ isError = false, isProcessStart = false, isProcessEnd = false } = {}) {
    usage.tool_calls += 1;
    // Only adjust failure streak when explicitly marked (legacy single-shot path).
    // Prefer recordToolResult on tool_end so tool_start does not reset the streak.
    if (isError) {
      usage.consecutive_tool_failures += 1;
    }
    if (isProcessStart) usage.processes += 1;
    if (isProcessEnd && usage.processes > 0) usage.processes -= 1;
    return check();
  }

  /**
   * Update failure/process counters without incrementing tool_calls
   * (use after tool_end when tool_start already counted the call).
   * Success resets consecutive failures; errors increment.
   */
  function recordToolResult({ isError = false, isProcessEnd = false } = {}) {
    if (isError) {
      usage.consecutive_tool_failures += 1;
    } else {
      usage.consecutive_tool_failures = 0;
    }
    if (isProcessEnd && usage.processes > 0) usage.processes -= 1;
    return check();
  }

  function recordUsage({ tokens = 0, cost = 0 } = {}) {
    if (tokens) usage.llm_tokens += Number(tokens) || 0;
    if (cost) usage.cost += Number(cost) || 0;
    return check();
  }

  function snapshot() {
    return {
      steps: usage.steps,
      tool_calls: usage.tool_calls,
      llm_tokens: usage.llm_tokens,
      cost: usage.cost,
      consecutive_tool_failures: usage.consecutive_tool_failures,
      processes: usage.processes,
      duration_seconds: durationSeconds(),
      started_at: usage.started_at,
    };
  }

  return {
    limits: resolved,
    recordStep,
    recordToolCall,
    recordToolResult,
    recordUsage,
    check,
    isNearLimit,
    consumeNearWarning,
    snapshot,
    get exceeded() {
      return exceeded;
    },
    get exceededReason() {
      return exceededReason;
    },
  };
}
