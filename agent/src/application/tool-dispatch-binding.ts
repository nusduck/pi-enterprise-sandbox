/**
 * 派发边界上的 sandbox 请求绑定（2026-09-17，STATUS G2）。
 *
 * `FencedToolGovernanceRecorder.recordToolStarted` 在 DSH 下就是派发边界：
 * `tools/pre-execute` 放行之后、调用执行面之前。账本在那一刻推进到 RUNNING，
 * sandbox 工具还要把**请求指纹 + 当前 fence** 写进同一行、同一事务——崩溃恢复
 * 与审计据此区分「派发了什么、是哪个 fence 派发的」。
 *
 * 复用 `ToolExecutionRepository.bindSandboxRequest`（ACTIVE session、fence、会话 /
 * 沙箱会话一致、仅 RUNNING、NULL→set CAS 或完全相同幂等）。它此前没有调用方：
 * 旧引擎时代由沙箱桥在派发前调用，换 DSH 后这条接线断了。
 */

import { computeSandboxToolRequestHash } from './sandbox-request-binder.js';
import { TOOL_EXECUTION_STATUS, TOOL_SOURCE } from '../domain/tool/tool-execution-status.js';

/** 过渡期宽松类型：仓储与行对象仍是 JS 形状。 */
type Loose = any;

/**
 * 为已 RUNNING 的 sandbox 工具行绑定请求；非 sandbox 工具或非 RUNNING 原样返回。
 *
 * 会话没有 `sandboxSessionId` 时不绑定（`dsh-run-executor` 对这种会话刻意不拒跑），
 * fence 仍由调用方事务里的 `assertExecutionFence` 在 FOR UPDATE 下核过。
 * 同一 toolCallId 换了参数重来时，绑定冲突抛 ConflictError——派发前 fail-closed。
 */
export async function bindDispatchedSandboxRequest(input: {
  repos: Loose;
  toolExecution: Loose;
  toolName: string;
  args: unknown;
  executionFenceToken: number;
  context: { orgId: string; userId: string; runId: string; agentSessionId: string; conversationId?: string | null; sandboxSessionId?: string | null };
}): Promise<Loose> {
  const { toolExecution, context } = input;
  if (
    toolExecution?.status !== TOOL_EXECUTION_STATUS.RUNNING ||
    toolExecution.toolSource !== TOOL_SOURCE.SANDBOX ||
    !context.sandboxSessionId ||
    !context.conversationId
  ) {
    return toolExecution;
  }
  const { requestHash, requestHashVersion } = computeSandboxToolRequestHash({
    toolName: input.toolName,
    args: input.args,
  });
  const bound = await input.repos.toolExecutions.bindSandboxRequest({
    toolExecutionId: toolExecution.toolExecutionId,
    runId: context.runId,
    toolCallId: toolExecution.toolCallId,
    toolName: input.toolName,
    agentSessionId: context.agentSessionId,
    conversationId: context.conversationId,
    sandboxSessionId: context.sandboxSessionId,
    requestHash,
    requestHashVersion,
    executionFenceToken: input.executionFenceToken,
    orgId: context.orgId,
    userId: context.userId,
  });
  return bound.toolExecution;
}
