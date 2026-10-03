/**
 * `delegate_to_remote_agent` —— 把自包含任务发给运维登记的远端 Agent，前台等结果
 * （docs/design/a2a-remote-delegation.md D4/D5、hiagent-remote-delegation.md §4）。
 *
 * - 远端清单是进程级的（`A2A_REMOTE_AGENTS_JSON`，boot 时解析，不合法即拒绝启动）；
 *   本 Run 能调哪些，看 `RunServices.remoteDelegation.agents`（AgentVersion 白名单）。
 *   两者都满足才发——清单里有、版本没授权，或版本授权了、清单里已经没了，一律拒。
 * - 模型只给远端 id，给不了 URL：地址只来自登记表，没有 SSRF 面。
 * - 风险分类 `external_high`（tool-names.ts `EXTERNAL_HOST_TOOL_NAMES`），平台默认风险 medium、
 *   不审批（2026-10-03 产品决定）；AgentVersion 调回 high 时审批在 `tools/pre-execute`
 *   挂载点，本工具体只在批准后才会被调用。
 * - `protocol: "hiagent"` 的远端走火山应用 API：同一平台会话里连续委派默认续用上一次的
 *   远端会话（绑定存在服务端，模型拿不到也传不进远端会话 ID，见 H3）；`new_conversation`
 *   为 true 时强制新建。对 A2A 远端该参数被忽略（一问一答，无续聊）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { currentRunServices } from './run-services.js';
import { currentToolExecutionContext } from './tool-execution-context.js';
import {
  RemoteA2aClient,
  RemoteA2aError,
  deriveMessageId,
  type RemoteDelegationResult,
} from './a2a-remote-client.js';
import {
  HiAgentClient,
  HiAgentError,
  isHiAgentSessionInvalid,
} from './hiagent-client.js';
import {
  parseRemoteAgentRegistry,
  type A2aRemoteAgentEntry,
  type HiAgentRemoteAgentEntry,
  type RemoteAgentEntry,
} from './a2a-remote-registry.js';

export const DELEGATE_TO_REMOTE_AGENT_TOOL_NAME = 'delegate_to_remote_agent';

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = typeof args[key] === 'string' ? (args[key] as string).trim() : '';
  if (!value) throw new RemoteA2aError('DELEGATION_ARGUMENT_INVALID', `${key} is required`);
  return value;
}

export interface RemoteDelegationDeps {
  readonly registry: readonly RemoteAgentEntry[];
  readonly client: Pick<RemoteA2aClient, 'delegate'>;
  readonly hiagent?: Pick<HiAgentClient, 'createConversation' | 'chat'>;
}

/** 工具体。单独导出，单测不必起插件树。 */
export async function executeRemoteDelegation(
  deps: RemoteDelegationDeps,
  rawArgs: unknown,
  signal?: AbortSignal,
): Promise<RemoteDelegationResult> {
  const services = currentRunServices()?.remoteDelegation;
  if (!services || services.agents.length === 0) {
    throw new RemoteA2aError(
      'DELEGATION_NOT_CONFIGURED',
      'this agent is not configured to call remote agents',
    );
  }
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const agent = requiredString(args, 'agent');
  requiredString(args, 'description');
  const prompt = requiredString(args, 'prompt');
  const entry = deps.registry.find((e) => e.id === agent);
  if (!services.agents.includes(agent) || !entry) {
    const available = services.agents.filter((id) => deps.registry.some((e) => e.id === id));
    throw new RemoteA2aError(
      'DELEGATION_AGENT_NOT_ALLOWED',
      `"${agent}" is not a remote agent you can call; available: ${available.join(', ') || '(none)'}`,
    );
  }
  if (entry.protocol === 'hiagent') {
    return executeHiAgentDelegation(deps, entry, { prompt, newConversation: args.new_conversation === true }, signal);
  }
  const callId = currentToolExecutionContext()?.callId;
  if (!callId) {
    throw new RemoteA2aError('DELEGATION_CONTEXT_MISSING', 'no tool call id in scope');
  }
  return deps.client.delegate({
    entry: entry as A2aRemoteAgentEntry,
    prompt,
    messageId: deriveMessageId(services.runId, callId),
    ...(signal ? { signal } : {}),
  });
}

/**
 * HiAgent 分支（H3/H4/H5）：续聊绑定读写、失效重建且只重试一次。
 * 远端会话 ID 只在服务端流转：查绑定、建会话、落绑定——模型参数里没有它。
 */
async function executeHiAgentDelegation(
  deps: RemoteDelegationDeps,
  entry: HiAgentRemoteAgentEntry,
  task: { prompt: string; newConversation: boolean },
  signal?: AbortSignal,
): Promise<RemoteDelegationResult> {
  const services = currentRunServices()?.remoteDelegation;
  const hiagent = deps.hiagent;
  if (!services?.scope || !services.bindings || !hiagent) {
    throw new RemoteA2aError('DELEGATION_CONTEXT_MISSING', 'hiagent delegation needs run scope and bindings');
  }
  const userId = services.scope.userId;
  const opts = signal ? { signal } : {};
  const stored = task.newConversation
    ? null
    : await services.bindings.getBinding(entry.id);
  let remoteConversationId = stored;
  if (!remoteConversationId) {
    remoteConversationId = await hiagent.createConversation({ entry, userId, ...opts });
    await services.bindings.setBinding(entry.id, remoteConversationId);
  }
  try {
    const answer = await hiagent.chat({ entry, userId, remoteConversationId, prompt: task.prompt, ...opts });
    return { remoteAgent: entry.id, taskId: answer.taskId, state: 'completed', text: answer.text, artifacts: [] };
  } catch (err) {
    // 远端会话失效：删绑定、新建、只重试一次；其他错误直接按工具错误返回。
    if (!stored || !isHiAgentSessionInvalid(err)) throw err;
    await services.bindings.clearBinding(entry.id);
    const retryId = await hiagent.createConversation({ entry, userId, ...opts });
    await services.bindings.setBinding(entry.id, retryId);
    const answer = await hiagent.chat({ entry, userId, remoteConversationId: retryId, prompt: task.prompt, ...opts });
    return { remoteAgent: entry.id, taskId: answer.taskId, state: 'completed', text: answer.text, artifacts: [] };
  }
}

function renderText(value: RemoteDelegationResult): string {
  const files = value.artifacts.length
    ? `\n\nFiles from ${value.remoteAgent}:\n` +
      value.artifacts.map((a) => `- ${a.name}${a.url ? ` (${a.url})` : ''}`).join('\n')
    : '';
  return (value.text || `Remote agent ${value.remoteAgent} finished without a text answer.`) + files;
}

const NULLABLE_STRING = { oneOf: [{ type: 'string' as const }, { type: 'null' as const }] };

export const name = 'delegate-to-remote-agent';
export const inject = ['tools'] as const;

export function* apply(ctx: Context & Record<string, any>) {
  // 进程级：清单与客户端（含卡片缓存）只建一次。清单不合法在这里抛，boot 失败。
  const registry = parseRemoteAgentRegistry(process.env);
  const client = new RemoteA2aClient();
  const hiagent = new HiAgentClient();
  yield ctx.tools.register({
    name: DELEGATE_TO_REMOTE_AGENT_TOOL_NAME,
    description:
      'Send a self-contained task to a remote agent run by another team or system, and wait for its answer. ' +
      'Only the remote agents listed under "Delegation" in your instructions are available. ' +
      'The task leaves this organization: include only what the remote agent needs.',
    parameters: {
      type: 'object',
      required: ['agent', 'description', 'prompt'],
      properties: {
        agent: {
          type: 'string',
          description: 'Id of the remote agent, exactly as listed under "Delegation".',
        },
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the task, for display.',
        },
        prompt: {
          type: 'string',
          description: 'The complete, self-contained task for the remote agent.',
        },
        new_conversation: {
          type: 'boolean',
          description:
            'Start a fresh remote conversation instead of continuing the previous one. ' +
            'Only applies to HiAgent remotes (they continue context within a session); ignored otherwise.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          remoteAgent: { type: 'string' },
          taskId: NULLABLE_STRING,
          state: { type: 'string' },
          text: { type: 'string' },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                mimeType: NULLABLE_STRING,
                url: NULLABLE_STRING,
              },
              required: ['name', 'mimeType', 'url'],
            },
          },
        },
        required: ['remoteAgent', 'taskId', 'state', 'text', 'artifacts'],
      },
      render: (_args: unknown, value: unknown) => [
        { type: 'text' as const, text: renderText(value as RemoteDelegationResult) },
      ],
    },
    async execute(args: unknown, exec: { signal?: AbortSignal } | undefined) {
      return executeRemoteDelegation({ registry, client, hiagent }, args, exec?.signal);
    },
  });
}

// Re-exported for tests: session-invalid is the H5 retry trigger.
export { HiAgentError, isHiAgentSessionInvalid };
