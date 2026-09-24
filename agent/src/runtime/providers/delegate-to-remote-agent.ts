/**
 * `delegate_to_remote_agent` —— 把自包含任务发给运维登记的远端 A2A Agent，前台等结果
 * （docs/design/a2a-remote-delegation.md D4/D5）。
 *
 * - 远端清单是进程级的（`A2A_REMOTE_AGENTS_JSON`，boot 时解析，不合法即拒绝启动）；
 *   本 Run 能调哪些，看 `RunServices.remoteDelegation.agents`（AgentVersion 白名单）。
 *   两者都满足才发——清单里有、版本没授权，或版本授权了、清单里已经没了，一律拒。
 * - 模型只给远端 id，给不了 URL：地址只来自登记表，没有 SSRF 面。
 * - 风险分类 `external_high`（tool-names.ts `EXTERNAL_HOST_TOOL_NAMES`），平台默认需要审批；
 *   审批在 `tools/pre-execute` 挂载点，本工具体只在批准后才会被调用。
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
import { parseRemoteAgentRegistry, type RemoteAgentEntry } from './a2a-remote-registry.js';

export const DELEGATE_TO_REMOTE_AGENT_TOOL_NAME = 'delegate_to_remote_agent';

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = typeof args[key] === 'string' ? (args[key] as string).trim() : '';
  if (!value) throw new RemoteA2aError('DELEGATION_ARGUMENT_INVALID', `${key} is required`);
  return value;
}

/** 工具体。单独导出，单测不必起插件树。 */
export async function executeRemoteDelegation(
  deps: { registry: readonly RemoteAgentEntry[]; client: Pick<RemoteA2aClient, 'delegate'> },
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
  const callId = currentToolExecutionContext()?.callId;
  if (!callId) {
    throw new RemoteA2aError('DELEGATION_CONTEXT_MISSING', 'no tool call id in scope');
  }
  return deps.client.delegate({
    entry,
    prompt,
    messageId: deriveMessageId(services.runId, callId),
    ...(signal ? { signal } : {}),
  });
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
      return executeRemoteDelegation({ registry, client }, args, exec?.signal);
    },
  });
}
