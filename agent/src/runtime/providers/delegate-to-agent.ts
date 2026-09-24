/**
 * `delegate_to_agent` —— 把一段自包含任务交给同 org 的另一个 Agent，前台等结果
 * （docs/design/agent-delegation.md D1/D5）。
 *
 * ## 为什么不扩展出厂 `subagent`
 *
 * 出厂工具的参数表写死在包里，provider 能力位 `persona: false`；给它加「目标 Agent」
 * 要么 fork 包，要么在 patch 上改 schema，两者升级 DSH 时都会静默失效。
 * 同构分身继续走出厂 `subagent`，异构委派走这里。
 *
 * ## 按 Run 取服务
 *
 * 工具在 boot 时注册一次，白名单与 spawn 端口都是按 Run 的，所以在**调用时**从
 * `currentRunServices()` 取（与 durable-subagent 同一纪律）。取不到 = 本 Run 没有
 * 委派能力，直接拒——不回退到任何进程内默认。
 */
import type { Context } from '@deepseek-ai/cordis';
import { currentRunServices, type DelegatedChildStatus } from './run-services.js';
import { currentToolExecutionContext } from './tool-execution-context.js';

export const DELEGATE_TO_AGENT_TOOL_NAME = 'delegate_to_agent';

/** 与 durable-subagent 相同的轮询节奏：200 ms 起、指数退避到 2 s。 */
const POLL_MIN_DELAY_MS = 200;
const POLL_MAX_DELAY_MS = 2_000;

/** 与 `RUN_STATUS` 的终态一致。 */
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

/** 带稳定码的工具错误：码写进消息开头，模型与前端都能读到。 */
export class DelegationToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'DelegationToolError';
    this.code = code;
  }
}

export interface DelegateResult {
  readonly agent: string;
  readonly childRunId: string;
  readonly status: string;
  readonly statusReason: string | null;
  readonly resultSummary: string | null;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = typeof args[key] === 'string' ? (args[key] as string).trim() : '';
  if (!value) throw new DelegationToolError('DELEGATION_ARGUMENT_INVALID', `${key} is required`);
  return value;
}

/** 等 `ms` 或等到取消，先到先走，退出前一定摘监听器。 */
function sleepOrAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish);
  });
}

/**
 * 工具体。单独导出，单测不必起插件树。
 */
export async function executeDelegation(
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<DelegateResult> {
  const services = currentRunServices()?.delegation;
  if (!services || services.agents.length === 0) {
    throw new DelegationToolError(
      'DELEGATION_NOT_CONFIGURED',
      'this agent is not configured to delegate to other agents',
    );
  }
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const agent = requiredString(args, 'agent');
  const label = requiredString(args, 'description');
  const task = requiredString(args, 'prompt');
  if (!services.agents.includes(agent)) {
    throw new DelegationToolError(
      'DELEGATION_AGENT_NOT_ALLOWED',
      `"${agent}" is not an agent you can delegate to; available: ${services.agents.join(', ')}`,
    );
  }
  // callId 是幂等键：同一次调用重试领回已建的子 Run，而不是再建一个。
  const callId = currentToolExecutionContext()?.callId;
  if (!callId) {
    throw new DelegationToolError('DELEGATION_CONTEXT_MISSING', 'no tool call id in scope');
  }

  let runId: string;
  try {
    ({ runId } = await services.spawn({ callId, agent, task, label }));
  } catch (err) {
    // spawn 的限额与目标不可用都带稳定码（SubagentLimitError）；原样转成工具错误，
    // 模型读到的是「为什么不行」，而不是一段内部异常。
    const code = (err as { code?: unknown })?.code;
    if (typeof code === 'string' && code !== '') {
      throw new DelegationToolError(code, (err as Error).message);
    }
    throw err;
  }

  let delayMs = POLL_MIN_DELAY_MS;
  let last: DelegatedChildStatus | null = null;
  while (!signal?.aborted) {
    last = await services.status(runId);
    if (last && TERMINAL.has(last.status)) break;
    await sleepOrAbort(delayMs, signal);
    delayMs = Math.min(delayMs * 2, POLL_MAX_DELAY_MS);
  }
  // 被取消时如实报告最后一次看到的状态；子 Run 的取消由父 Run 的级联负责。
  return {
    agent,
    childRunId: runId,
    status: last?.status ?? 'UNKNOWN',
    statusReason: last?.statusReason == null ? null : String(last.statusReason),
    resultSummary: last?.resultSummary ?? null,
  };
}

function renderText(value: DelegateResult): string {
  if (value.status === 'SUCCEEDED') {
    return value.resultSummary || `Agent ${value.agent} finished without a final message.`;
  }
  const reason = value.statusReason ? ` (${value.statusReason})` : '';
  return `Agent ${value.agent} did not finish: ${value.status.toLowerCase()}${reason}.` +
    (value.resultSummary ? `\n${value.resultSummary}` : '');
}

const NULLABLE_STRING = { oneOf: [{ type: 'string' as const }, { type: 'null' as const }] };

export const name = 'delegate-to-agent';
export const inject = ['tools'] as const;

export function* apply(ctx: Context & Record<string, any>) {
  yield ctx.tools.register({
    name: DELEGATE_TO_AGENT_TOOL_NAME,
    description:
      'Hand a self-contained task to another agent in this organization and wait for its answer. ' +
      'Only the agents listed under "Delegation" in your instructions are available. ' +
      'The other agent does not see this conversation or your workspace: give it everything it needs.',
    parameters: {
      type: 'object',
      required: ['agent', 'description', 'prompt'],
      properties: {
        agent: {
          type: 'string',
          description: 'Name of the agent to delegate to, exactly as listed under "Delegation".',
        },
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          description: 'The complete, self-contained task for the other agent.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agent: { type: 'string' },
          childRunId: { type: 'string' },
          status: { type: 'string' },
          // 出厂 schema 子集只接受单一 type，可空用 oneOf 表达。
          statusReason: NULLABLE_STRING,
          resultSummary: NULLABLE_STRING,
        },
        required: ['agent', 'childRunId', 'status', 'statusReason', 'resultSummary'],
      },
      render: (_args: unknown, value: unknown) => [
        { type: 'text' as const, text: renderText(value as DelegateResult) },
      ],
    },
    async execute(args: unknown, exec: { signal?: AbortSignal } | undefined) {
      return executeDelegation(args, exec?.signal);
    },
  });
}
