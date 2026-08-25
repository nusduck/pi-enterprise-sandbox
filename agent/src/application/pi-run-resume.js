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
import { redactPayload } from '../infrastructure/pi/event-redaction.js';
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
 * @param {object} replaySession
 * @param {{ toolCallId: string, toolName: string, argumentsJson?: unknown, _argsIntegrity?: string | null }} toolExecution
 * @returns {Record<string, unknown>}
 */
function resolveApprovedReplayArgs(replaySession, toolExecution) {
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
    return /** @type {Record<string, unknown>} */ (ledgerArgs);
  }

  const failure = new Error(
    'approved tool replay cannot recover the original arguments: they are ' +
      'absent from the session and the ledger view is redacted',
  );
  /** @type {any} */ (failure).code = 'APPROVED_TOOL_ARGS_UNRECOVERABLE';
  throw failure;
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
  if (typeof runtimeSession.getToolDefinition !== 'function') {
    throw new Error(
      'Pi runtime cannot replay approved tool: getToolDefinition unavailable',
    );
  }
  const definition = runtimeSession.getToolDefinition(toolExecution.toolName);
  if (!definition || typeof definition.execute !== 'function') {
    throw new Error(
      `approved tool definition is unavailable: ${toolExecution.toolName}`,
    );
  }

  // The ledger's argumentsJson is the redacted `$payload`, not the original:
  // a string over DEFAULT_MAX_STRING comes back truncated, which both breaks
  // the args-integrity replay check and would run the approved tool on
  // truncated input. The session holds what the model actually emitted.
  const replayArgs = resolveApprovedReplayArgs(replaySession, toolExecution);

  await executor._governanceRecorder.recordToolStarted({
    toolCallId: toolExecution.toolCallId,
    toolName: toolExecution.toolName,
    args: replayArgs,
    approvalId,
  });

  let result;
  try {
    result = await definition.execute(
      toolExecution.toolCallId,
      replayArgs,
      signal,
      undefined,
      undefined,
    );
  } catch (err) {
    await executor._governanceRecorder.recordToolUnknown({
      toolCallId: toolExecution.toolCallId,
      toolName: toolExecution.toolName,
      args: replayArgs,
      errorCode: 'APPROVED_TOOL_REPLAY_UNCERTAIN',
      result: {
        unknown: true,
        approvalId,
        reason: sanitizeStatusReason(err),
      },
    });
    const failure = new Error(
      `approved tool replay outcome is uncertain: ${sanitizeStatusReason(err) || 'unknown error'}`,
    );
    failure.code = 'APPROVED_TOOL_REPLAY_UNCERTAIN';
    throw failure;
  }

  const isError = Boolean(result?.isError);
  await executor._governanceRecorder.recordToolEnded({
    toolCallId: toolExecution.toolCallId,
    toolName: toolExecution.toolName,
    args: replayArgs,
    isError,
    result: result ?? null,
  });

  const safeResult = redactPayload(result ?? null);
  const fallbackText = JSON.stringify(safeResult ?? null).slice(0, 20_000);
  const content = Array.isArray(result?.content)
    ? result.content
    : [{ type: 'text', text: fallbackText }];
  const rewrote = replaceSuspendedToolResultInSession(replaySession, {
    toolCallId: toolExecution.toolCallId,
    toolName: toolExecution.toolName,
    content,
    details: {
      ...(result?.details && typeof result.details === 'object'
        ? result.details
        : {}),
      approvalId,
      approvalReplay: true,
    },
    isError,
  });
  return (
    `[Approval resolution] Approval ${approvalId} was granted. ` +
    `The original ${toolExecution.toolName} call ` +
    `(toolCallId=${toolExecution.toolCallId}) was executed exactly once with ` +
    `its approved arguments${isError ? ' and returned an error' : ''}. ` +
    (rewrote
      ? 'Its result is recorded in the tool result slot. '
      : `Its redacted result is: ${fallbackText || '(empty)'}. `) +
    'Continue from that result without issuing the same operation again.'
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
