/**
 * Resume preparation for a Run that was parked mid-turn.
 *
 * Two durable park points, verified against MySQL before Pi is touched again:
 * an approval decision (approved tools are claimed and executed once with
 * their original toolCallId and arguments; rejected ones only add a
 * continuation result) and an ask_user answer recovered into its parked
 * tool-result slot.
 *
 * Split out of pi-run-executor.js — both take the executor explicitly rather
 * than reading it off `this`.
 */

import { assertUlid } from '../domain/shared/ulid.js';
import { redactPayload } from '../lib/event-redaction.js';
import { sanitizeStatusReason } from './sanitize-status-reason.js';
import { ConflictError } from '../infrastructure/mysql/errors.js';
import { integrityFingerprint } from '../infrastructure/mysql/repositories/tool-execution-repository.js';
import { APPROVAL_STATUS } from '../domain/tool/approval-status.js';
import { TOOL_EXECUTION_STATUS } from '../domain/tool/tool-execution-status.js';
import { INTERACTION_STATUS } from '../domain/interaction/interaction-status.js';
import {
  findToolCallArgumentsInSession,
  replaceSuspendedToolResultInSession,
} from './pi-run-input.js';

/**
 * The arguments an approved tool must be re-executed with.
 *
 * `toolExecution.argumentsJson` is the ledger's *redacted* `$payload`, not the
 * original: any string over `DEFAULT_MAX_STRING` (512) comes back truncated
 * with `_bytes`/`_sha256`/`_truncated` siblings. Replaying that both fails the
 * args-integrity check ("tool_call_id replay conflicts with existing args
 * integrity") and would run the approved tool on truncated input.
 *
 * The Pi session still holds the assistant message that emitted the call, so
 * it is the authority. The ledger view is used only when it provably equals the
 * original — its fingerprint matches the stored `$integrity` — which is the
 * common short-argument case.
 *
 * @param replaySession
 * @param toolExecution
 * @returns {Record<string, unknown>}
 */
function resolveApprovedReplayArgs(replaySession: Record<string, any>, toolExecution: { toolCallId: string, toolName: string, argumentsJson?: unknown, _argsIntegrity?: string | null }): Record<string, unknown> | null {
  const recovered = findToolCallArgumentsInSession(
    replaySession,
    toolExecution.toolCallId,
  );
  if (recovered.found) return recovered.args;

  const ledgerArgs = toolExecution.argumentsJson ?? {};
  const durableFingerprint = toolExecution._argsIntegrity;
  if (
    durableFingerprint &&
    integrityFingerprint(ledgerArgs) === durableFingerprint
  ) {
    return (ledgerArgs as Record<string, unknown>);
  }

  // 2026-08-31（ADR 0009 D5 / 计划 H4.5）：这里原来**抛**
  // `APPROVED_TOOL_ARGS_UNRECOVERABLE`。当时必须抛——application 要亲自
  // 拿这组参数去执行工具，拿不准就不能跑。
  //
  // 现在执行者是循环：application 只回一段续跑提示，参数由模型重新发出，
  // 再由 `tools/pre-execute` 按**指纹**核对那条 APPROVED 记录。所以这里
  // 恢复不出参数只影响**审计条目写得细不细**，不影响正确性——
  // 而抛出去会把一次本来合法的续跑直接打死。返回 null，调用方照常继续。
  return null;
}

/**
 * Verify the worker-provided resume context against MySQL. Approved tools are
 * claimed and executed once with their original toolCallId and arguments;
 * rejected tools only add a continuation result.
 */
export async function prepareApprovalResume(executor, {
  approvalResume,
  runtimeSession,
  run,
  scope,
  signal,
}) {
  const approvalId = assertUlid(
    approvalResume.approvalId,
    'approvalId',
  );
  const durable = await executor.tx.run(async (trx) => {
    const repos = executor.createRepositories(trx);
    const approval = await repos.approvals.getById(approvalId, scope);
    const toolExecution = await repos.toolExecutions.getById(
      approval.toolExecutionId,
      scope,
    );
    return { approval, toolExecution };
  });
  const { approval, toolExecution } = durable;
  if (
    approval.runId !== run.runId ||
    toolExecution.runId !== run.runId ||
    approval.toolExecutionId !== toolExecution.toolExecutionId ||
    approvalResume.toolExecutionId !== toolExecution.toolExecutionId
  ) {
    throw new ConflictError('approval resume parent binding mismatch', {
      resource: 'approvals',
      id: approvalId,
    });
  }
  if (
    approvalResume.status &&
    approvalResume.status !== approval.status
  ) {
    throw new ConflictError('approval resume status changed', {
      resource: 'approvals',
      id: approvalId,
    });
  }

  const replaySession = {
    agent: runtimeSession.agent,
    sessionManager:
      executor._runtime?.sessionManager ?? runtimeSession.sessionManager,
  };

  if (approval.status === APPROVAL_STATUS.REJECTED) {
    if (toolExecution.status !== TOOL_EXECUTION_STATUS.FAILED) {
      throw new ConflictError(
        `rejected approval has non-terminal tool ${toolExecution.status}`,
        { resource: 'tool_executions', id: toolExecution.toolExecutionId },
      );
    }
    const content = [
      {
        type: 'text',
        text: `Approval ${approvalId} was rejected. The tool was not executed.`,
      },
    ];
    replaceSuspendedToolResultInSession(replaySession, {
      toolCallId: toolExecution.toolCallId,
      toolName: toolExecution.toolName,
      content,
      details: {
        approvalId,
        approvalRejected: true,
      },
      isError: true,
    });
    return (
      `[Approval resolution] Approval ${approvalId} for ` +
      `${toolExecution.toolName} was rejected. The tool was not executed. ` +
      'Continue the task without retrying or bypassing the rejected operation.'
    );
  }

  if (approval.status !== APPROVAL_STATUS.APPROVED) {
    throw new ConflictError(`approval is not resolved: ${approval.status}`, {
      resource: 'approvals',
      id: approvalId,
    });
  }
  if (toolExecution.status !== TOOL_EXECUTION_STATUS.WAITING_APPROVAL) {
    throw new ConflictError(
      `approved tool is ${toolExecution.status}, expected WAITING_APPROVAL`,
      { resource: 'tool_executions', id: toolExecution.toolExecutionId },
    );
  }
  // ── 2026-08-31（ADR 0009 D5 / 计划 H4.5）：重放交回循环 ─────────────────
  //
  // 这里原来是 application 自己认领并执行被批准的工具：
  //   `runtimeSession.getToolDefinition(name).execute(toolCallId, args, …)`
  //   然后把结果 splice 进会话的 tool-result 槽。
  //
  // **那条路在 DSH 下已经跑不通了**：DSH 的 session（`runtime-factory.ts` 里
  // 构造的那个）根本没有 `getToolDefinition`，所以这一支只会抛
  // "Pi runtime cannot replay approved tool"——即「审批能停泊，但批准之后
  // 续不回去」。不是本次重构把它弄坏的，是 Pi→DSH 之后它就一直是坏的。
  //
  // 新形状：**application 只负责停下来和重新跑起来，执行者是循环**。
  // 这里只回一段续跑提示；模型重新发起同一个调用，`tools/pre-execute` 按
  // 「工具名 + 参数指纹」查到那条 APPROVED 记录，直接放行（一次性消费）。
  // 于是预算、账本、脱敏、租户 guard 这些挂载点**照常全部生效**——
  // 而 application 自己 execute 时它们是全被绕过去的。
  //
  // 指纹绑的是字节：人批准的是 A 这组参数，模型如果改了任何一个字符，
  // 指纹对不上就查不到那条批准，于是重新走一次审批。ADR D5 要的
  // 「同意之后、落地之前 args 指纹对不上必须拒绝」由此满足。
  // 只为审计留一条「续跑已发起」。真正的执行与它的账本条目由循环那边的
  // post-execute 挂载点记——那里才有真实结果、真实耗时、真实脱敏。
  // 参数恢复不出来时记 `{}`，不阻断续跑（见 resolveApprovedReplayArgs）。
  const replayArgs = resolveApprovedReplayArgs(replaySession, toolExecution) ?? {};

  await executor._governanceRecorder.recordToolStarted({
    toolCallId: toolExecution.toolCallId,
    toolName: toolExecution.toolName,
    args: replayArgs,
    approvalId,
  });

  return (
    `[Approval resolution] Approval ${approvalId} was granted for ` +
    `${toolExecution.toolName}. Re-issue exactly that call with exactly the ` +
    `same arguments as before — it will now be allowed to run once. ` +
    `Changing any argument revokes the approval and will ask a human again.`
  );
}

/**
 * Recover a durable ask_user answer into the parked tool-result slot, then
 * continue the existing Pi session with a short continuation prompt.
 */
export async function prepareInteractionResume(executor, {
  interactionResume,
  runtimeSession,
  run,
  scope,
  signal,
}) {
  const interactionId = assertUlid(
    interactionResume.interactionId,
    'interactionId',
  );
  const durable = await executor.tx.run(async (trx) => {
    const repos = executor.createRepositories(trx);
    const interaction = await repos.interactions.getById(interactionId, scope);
    const toolExecution = await repos.toolExecutions.getById(
      interaction.toolExecutionId,
      scope,
    );
    return { interaction, toolExecution };
  });
  const { interaction, toolExecution } = durable;
  if (
    interaction.runId !== run.runId ||
    interaction.agentSessionId !== run.agentSessionId ||
    interaction.toolCallId !== toolExecution.toolCallId ||
    interactionResume.toolExecutionId !== toolExecution.toolExecutionId ||
    interactionResume.toolCallId !== toolExecution.toolCallId
  ) {
    throw new ConflictError('interaction resume parent binding mismatch', {
      resource: 'interactions',
      id: interactionId,
    });
  }
  if (
    interaction.status !== INTERACTION_STATUS.RESOLVED ||
    interactionResume.status !== interaction.status
  ) {
    throw new ConflictError('interaction is not durably resolved', {
      resource: 'interactions',
      id: interactionId,
    });
  }
  if (
    interactionResume.responseHash &&
    interaction.responseHash !== interactionResume.responseHash
  ) {
    throw new ConflictError('interaction response hash changed', {
      resource: 'interactions',
      id: interactionId,
    });
  }
  if (signal?.aborted) throw new Error('interaction resume aborted');

  const response = interaction.responseJson;
  const responseText =
    typeof response === 'string' ? response : JSON.stringify(response);
  const content = [
    {
      type: 'text',
      text: `User response: ${responseText}`,
    },
  ];
  replaceSuspendedToolResultInSession(
    {
      agent: runtimeSession.agent,
      sessionManager:
        executor._runtime?.sessionManager ?? runtimeSession.sessionManager,
    },
    {
      toolCallId: toolExecution.toolCallId,
      toolName: toolExecution.toolName,
      content,
      details: {
        interactionId,
        interactionType: interaction.interactionType,
        responseHash: interaction.responseHash,
      },
      isError: false,
      appendIfMissing: true,
    },
  );
  return (
    `[User interaction resolved] The user answered the ${interaction.interactionType} ` +
    `request ${interactionId}. Continue the task using the answer already ` +
    'recorded in the tool result; do not ask the same question again.'
  );
}
