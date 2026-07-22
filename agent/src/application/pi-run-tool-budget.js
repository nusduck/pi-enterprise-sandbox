/**
 * Per-Run convergence guard for Pi's otherwise open-ended coding-agent loop.
 *
 * Pi intentionally keeps calling the model while it requests tools. That is
 * useful interactively, but a worker Run needs a finite service boundary. This
 * adapter uses the public Agent hook points exposed by AgentSession; it does
 * not patch Pi's installed source or bypass its policy hooks.
 */

export const DEFAULT_MAX_TOOL_CALLS_PER_RUN = 12;
export const DEFAULT_MAX_IDENTICAL_TOOL_CALLS = 2;
export const DEFAULT_MAX_MODEL_TURNS_PER_RUN = 14;

function positiveInt(value, name, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function resolvePiRunToolBudget(env = process.env) {
  return Object.freeze({
    maxToolCalls: positiveInt(
      env.AGENT_RUN_MAX_TOOL_CALLS,
      'AGENT_RUN_MAX_TOOL_CALLS',
      DEFAULT_MAX_TOOL_CALLS_PER_RUN,
    ),
    maxIdenticalToolCalls: positiveInt(
      env.AGENT_RUN_MAX_IDENTICAL_TOOL_CALLS,
      'AGENT_RUN_MAX_IDENTICAL_TOOL_CALLS',
      DEFAULT_MAX_IDENTICAL_TOOL_CALLS,
    ),
    maxModelTurns: positiveInt(
      env.AGENT_RUN_MAX_MODEL_TURNS,
      'AGENT_RUN_MAX_MODEL_TURNS',
      DEFAULT_MAX_MODEL_TURNS_PER_RUN,
    ),
  });
}

function stableValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function fingerprint(toolName, args) {
  return `${String(toolName)}:${JSON.stringify(stableValue(args ?? {}))}`;
}

function budgetInstruction(reason) {
  return [
    'Run execution budget reached: do not call any more tools.',
    `Reason: ${reason}.`,
    'Use only the results already collected, state any uncertainty briefly, and give the user a final answer now.',
  ].join('\n');
}

/**
 * Install a temporary convergence guard on a Pi AgentSession.
 *
 * Policy hooks already installed by AgentSession always run first. Once a
 * budget is reached, the next model turn receives no tools plus an explicit
 * instruction to answer. A tool attempt after that point is blocked as a
 * final defensive measure.
 *
 * @param {object} session
 * @param {{ maxToolCalls?: number, maxIdenticalToolCalls?: number, maxModelTurns?: number }} [limits]
 * @returns {{ supported: boolean, dispose: () => void, snapshot: () => object }}
 */
export function installPiRunToolBudget(session, limits = {}) {
  const agent = session?.agent;
  if (!agent || !agent.state || !Array.isArray(agent.state.tools)) {
    return {
      supported: false,
      dispose() {},
      snapshot: () => ({ supported: false }),
    };
  }

  const maxToolCalls = positiveInt(
    limits.maxToolCalls,
    'maxToolCalls',
    DEFAULT_MAX_TOOL_CALLS_PER_RUN,
  );
  const maxIdenticalToolCalls = positiveInt(
    limits.maxIdenticalToolCalls,
    'maxIdenticalToolCalls',
    DEFAULT_MAX_IDENTICAL_TOOL_CALLS,
  );
  const maxModelTurns = positiveInt(
    limits.maxModelTurns,
    'maxModelTurns',
    DEFAULT_MAX_MODEL_TURNS_PER_RUN,
  );

  const priorBeforeToolCall = agent.beforeToolCall;
  const priorPrepareNextTurn = agent.prepareNextTurnWithContext;
  const seen = new Map();
  let toolCalls = 0;
  let modelTurns = 0;
  let exhaustedReason = null;

  const exhaust = (reason) => {
    if (!exhaustedReason) exhaustedReason = reason;
  };

  agent.beforeToolCall = async (context, signal) => {
    // Keep governance/approval hooks authoritative; a budget must never turn a
    // policy-denied action into an allowed one.
    const policyResult = await priorBeforeToolCall?.(context, signal);
    if (policyResult?.block) return policyResult;

    if (exhaustedReason) {
      return {
        block: true,
        reason: `RUN_TOOL_BUDGET_EXHAUSTED: ${exhaustedReason}. Give a final answer without more tools.`,
      };
    }

    const key = fingerprint(context?.toolCall?.name, context?.args);
    const identicalCalls = seen.get(key) ?? 0;
    if (identicalCalls >= maxIdenticalToolCalls) {
      exhaust(`identical tool call limit (${maxIdenticalToolCalls})`);
      return {
        block: true,
        reason: `RUN_TOOL_REPEAT_LIMIT: identical ${context?.toolCall?.name ?? 'tool'} call limit reached. Give a final answer without more tools.`,
      };
    }
    if (toolCalls >= maxToolCalls) {
      exhaust(`tool call limit (${maxToolCalls})`);
      return {
        block: true,
        reason: `RUN_TOOL_BUDGET_EXHAUSTED: tool call limit (${maxToolCalls}) reached. Give a final answer without more tools.`,
      };
    }

    seen.set(key, identicalCalls + 1);
    toolCalls += 1;
    if (toolCalls >= maxToolCalls) {
      // Let this already-authorized tool finish, then force the following
      // model turn to synthesize rather than requesting another tool.
      exhaust(`tool call limit (${maxToolCalls})`);
    }
    return policyResult;
  };

  agent.prepareNextTurnWithContext = async (turn, signal) => {
    const priorSnapshot = await priorPrepareNextTurn?.(turn, signal);
    modelTurns += 1;
    if (modelTurns >= maxModelTurns) {
      exhaust(`model turn limit (${maxModelTurns})`);
    }
    if (!exhaustedReason) return priorSnapshot;

    const priorContext = priorSnapshot?.context ?? turn.context;
    return {
      ...priorSnapshot,
      context: {
        ...priorContext,
        // Context-level removal is intentional and temporary. It stops the
        // next provider request from producing another valid tool call while
        // preserving the session's normal tool set for later Runs.
        tools: [],
        systemPrompt: `${String(priorContext?.systemPrompt ?? '')}\n\n${budgetInstruction(exhaustedReason)}`,
      },
    };
  };

  let disposed = false;
  return {
    supported: true,
    dispose() {
      if (disposed) return;
      disposed = true;
      agent.beforeToolCall = priorBeforeToolCall;
      agent.prepareNextTurnWithContext = priorPrepareNextTurn;
    },
    snapshot: () => ({
      supported: true,
      toolCalls,
      modelTurns,
      exhausted: exhaustedReason != null,
      exhaustedReason,
      maxToolCalls,
      maxIdenticalToolCalls,
      maxModelTurns,
    }),
  };
}
