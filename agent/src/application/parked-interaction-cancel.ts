/**
 * Parked WAITING_INPUT cancellation (no live worker to observe cancel signal).
 *
 * Sibling of {@link ./parked-approval-cancel.js}: close the interaction/tool
 * ledgers, then WAITING_INPUT → RUNNING → CANCELLING → CANCELLED under one
 * transaction.
 *
 * This lived inline in CancelRunService, which was fine while a direct cancel
 * was the only way a parked Run could be cancelled. Two callers now need it:
 *
 * - CancelRunService, for the Run the user named;
 * - RunRecoveryService, for a Run that got cancel intent without a live worker
 *   — a sub-agent child reached by a parent's cancel cascade is exactly that.
 *   Its WAITING_APPROVAL twin was already handled there; leaving WAITING_INPUT
 *   out meant a child parked on `ask_user` stayed parked forever.
 */

import { ConflictError } from '../infrastructure/mysql/errors.js';
import { RUN_STATUS, runStateMachine } from '../domain/run/index.js';
import { INTERACTION_STATUS } from '../domain/interaction/interaction-status.js';
import { TOOL_EXECUTION_STATUS } from '../domain/tool/tool-execution-status.js';
import { assertUlid } from '../domain/shared/ulid.js';
import { AGGREGATE_TYPE_RUN } from '../infrastructure/outbox/outbox-status.js';
import {
  buildCanonicalEnvelope,
  redactEventData,
} from './fenced-run-event-recorder.js';
import {
  applyRunTransitionInTxn,
  type RunTransitionRepos,
} from './run-transition.js';

/**
 * 这条路径要用的仓储：状态迁移那三个，外加 interaction 与工具执行——
 * 取消一个 parked WAITING_INPUT 需要同时收尾这两张表。
 */
export type ParkedInteractionRepos = RunTransitionRepos & {
  interactions: any;
  toolExecutions: any;
};

/** Tool states a parked cancel may close; anything else is left alone. */
export const PARKED_TOOL_CANCELLABLE_STATUSES = new Set([
  TOOL_EXECUTION_STATUS.PROPOSED,
  TOOL_EXECUTION_STATUS.WAITING_APPROVAL,
  TOOL_EXECUTION_STATUS.RUNNING,
]);

/**
 * @param {{
 *   repos: object,
 *   run: object,
 *   eventType: string,
 *   data: object,
 *   generateId: () => string,
 *   now: () => Date,
 * }} args
 */
async function appendEventInTxn({ repos, run, eventType, data, generateId, now }: {
  repos: RunTransitionRepos;
  [key: string]: any;
}) {
  const timestamp = now();
  const eventId = assertUlid(generateId(), 'eventId');
  const outboxId = assertUlid(generateId(), 'outboxId');
  const context = {
    orgId: run.orgId,
    userId: run.userId,
    conversationId: run.conversationId,
    agentSessionId: run.agentSessionId,
    runId: run.runId,
    traceId: run.traceId,
    spanId: null,
  };
  const cleanData = redactEventData(data ?? {});
  const stored = await repos.runEvents.append({
    eventId,
    runId: run.runId,
    orgId: run.orgId,
    userId: run.userId,
    eventType,
    eventVersion: 1,
    payloadJson: { context, data: cleanData },
    traceId: run.traceId,
    spanId: null,
    createdAt: timestamp,
  });
  const envelope = buildCanonicalEnvelope({
    eventId: stored.eventId,
    sequence: stored.sequenceNo,
    type: eventType,
    eventVersion: 1,
    timestamp,
    context,
    data: cleanData,
  });
  await repos.outbox.insert({
    outboxId,
    aggregateType: AGGREGATE_TYPE_RUN,
    aggregateId: run.runId,
    eventType,
    payloadJson: {
      eventId: envelope.eventId,
      sequence: envelope.sequence,
      type: envelope.type,
      eventVersion: envelope.eventVersion,
      timestamp: envelope.timestamp,
      context: envelope.context,
      data: envelope.data,
      runId: run.runId,
      orgId: run.orgId,
      userId: run.userId,
    },
  });
  return stored;
}

/**
 * Terminalise one WAITING_INPUT Run whose cancel intent is already durable.
 *
 * @param {{
 *   repos: object,
 *   run: object,
 *   scope: { orgId: string, userId: string },
 *   cancelledBy: string,
 *   generateId: () => string,
 *   now?: () => Date,
 *   stateMachine?: { assertTransition: (from: string, to: string) => void },
 * }} input
 * @returns {Promise<{ status: string }>}
 */
export async function terminalizeParkedWaitingInputInTxn(input: { repos: ParkedInteractionRepos, run: Record<string, any>, scope: { orgId: string, userId: string }, cancelledBy: string, generateId: () => string, now?: () => Date, stateMachine?: { assertTransition: (from: string, to: string) => void }, }) {
  const {
    repos,
    run,
    scope,
    cancelledBy,
    generateId,
    now = () => new Date(),
    stateMachine = runStateMachine,
  } = input;

  if (run.status !== RUN_STATUS.WAITING_INPUT) {
    throw new ConflictError(
      `parked interaction cancel requires WAITING_INPUT, was ${run.status}`,
      { resource: 'runs', id: run.runId },
    );
  }
  if (!repos.interactions || !repos.toolExecutions) {
    throw new Error(
      'parked Run cancellation requires interactions and toolExecutions repositories',
    );
  }

  const runId = run.runId;
  const interactions = await repos.interactions.listByRunId(runId, scope, {
    forUpdate: true,
  });
  const pendingInteractions = interactions.filter(
    (candidate) => candidate.status === INTERACTION_STATUS.PENDING,
  );
  if (pendingInteractions.length > 1) {
    throw new ConflictError('WAITING_INPUT Run has multiple pending interactions', {
      resource: 'runs',
      id: runId,
    });
  }
  const interaction =
    pendingInteractions[0] ??
    [...interactions]
      .reverse()
      .find((candidate) =>
        [INTERACTION_STATUS.RESOLVED, INTERACTION_STATUS.CANCELLED].includes(
          candidate.status,
        ),
      );
  if (!interaction) {
    throw new ConflictError(
      'WAITING_INPUT Run has no durable interaction to cancel',
      { resource: 'runs', id: runId },
    );
  }

  let toolExecution = await repos.toolExecutions.getById(
    interaction.toolExecutionId,
    scope,
    { forUpdate: true },
  );
  if (
    toolExecution.runId !== runId ||
    toolExecution.agentSessionId !== run.agentSessionId ||
    toolExecution.toolCallId !== interaction.toolCallId
  ) {
    throw new ConflictError('parked interaction tool binding is inconsistent', {
      resource: 'interactions',
      id: interaction.interactionId,
    });
  }
  if (
    !PARKED_TOOL_CANCELLABLE_STATUSES.has(toolExecution.status) &&
    ![
      TOOL_EXECUTION_STATUS.SUCCEEDED,
      TOOL_EXECUTION_STATUS.FAILED,
      TOOL_EXECUTION_STATUS.CANCELLED,
    ].includes(toolExecution.status)
  ) {
    // UNKNOWN is terminal but deliberately has no outgoing transition;
    // do not claim a safe cancellation over an ambiguous side effect.
    throw new ConflictError(
      `parked interaction tool is ${toolExecution.status}; cannot cancel safely`,
      { resource: 'tool_executions', id: toolExecution.toolExecutionId },
    );
  }

  let interactionCancelled = false;
  if (interaction.status === INTERACTION_STATUS.PENDING) {
    const cancelledInteraction = await repos.interactions.cancelPendingForRun(
      runId,
      scope,
    );
    if (
      !cancelledInteraction.changed ||
      cancelledInteraction.interaction?.interactionId !==
        interaction.interactionId
    ) {
      throw new ConflictError('parked interaction cancel CAS lost race', {
        resource: 'interactions',
        id: interaction.interactionId,
      });
    }
    interactionCancelled = true;
  }

  const toolWasCancellable = PARKED_TOOL_CANCELLABLE_STATUSES.has(
    toolExecution.status,
  );
  if (toolWasCancellable) {
    const cancelledTool = await repos.toolExecutions.transitionStatus({
      toolExecutionId: toolExecution.toolExecutionId,
      orgId: scope.orgId,
      userId: scope.userId,
      fromStatus: toolExecution.status,
      toStatus: TOOL_EXECUTION_STATUS.CANCELLED,
      resultJson: {
        interactionId: interaction.interactionId,
        cancelled: true,
        reason: run.cancelReason ?? null,
      },
      errorCode: 'RUN_CANCELLED',
      setCompletedAt: true,
    });
    toolExecution = cancelledTool.toolExecution;
  }

  if (interactionCancelled) {
    await appendEventInTxn({
      repos,
      run,
      eventType: 'interaction.cancelled',
      data: {
        interactionId: interaction.interactionId,
        interactionType: interaction.interactionType,
        status: INTERACTION_STATUS.CANCELLED,
        toolExecutionId: toolExecution.toolExecutionId,
        toolCallId: toolExecution.toolCallId,
        cancelledBy,
      },
      generateId,
      now,
    });
  }
  if (toolWasCancellable) {
    await appendEventInTxn({
      repos,
      run,
      eventType: 'tool.execution.failed',
      data: {
        interactionId: interaction.interactionId,
        toolExecutionId: toolExecution.toolExecutionId,
        toolCallId: toolExecution.toolCallId,
        toolName: toolExecution.toolName,
        status: TOOL_EXECUTION_STATUS.CANCELLED,
        cancelled: true,
        isError: true,
        errorCode: 'RUN_CANCELLED',
      },
      generateId,
      now,
    });
  }

  const transitions = [
    [RUN_STATUS.WAITING_INPUT, RUN_STATUS.RUNNING, 'run.status.changed'],
    [RUN_STATUS.RUNNING, RUN_STATUS.CANCELLING, 'run.status.changed'],
    [RUN_STATUS.CANCELLING, RUN_STATUS.CANCELLED, 'run.cancelled'],
  ];
  for (const [from, to, eventType] of transitions) {
    stateMachine.assertTransition(from, to);
    const transitioned = await applyRunTransitionInTxn({
      repos,
      runId,
      scope,
      from,
      to,
      traceId: run.traceId,
      generateId,
      eventType,
      statusReason: run.cancelReason,
      completedAt: to === RUN_STATUS.CANCELLED ? now() : undefined,
      payloadExtra: {
        cancelRequested: true,
        parkedCancellation: true,
      },
    });
    if (!transitioned.ok) {
      throw new ConflictError(
        `parked Run cancellation conflict at ${from} → ${to}`,
        { resource: 'runs', id: runId },
      );
    }
  }

  return { status: RUN_STATUS.CANCELLED };
}
