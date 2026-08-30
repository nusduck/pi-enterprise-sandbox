/**
 * Parked WAITING_APPROVAL cancellation (no live worker to observe cancel signal).
 *
 * Mirrors the WAITING_INPUT parked path: close approval/tool ledgers, then
 * WAITING_APPROVAL → RUNNING → CANCELLING → CANCELLED under one transaction.
 * Used by CancelRunService, ExecuteRunService, and RunRecoveryService so a
 * cancel intent never leaves the Run stuck forever.
 */

import { ConflictError } from '../infrastructure/mysql/errors.js';
import { RUN_STATUS, runStateMachine } from '../domain/run/index.js';
import { APPROVAL_STATUS } from '../domain/tool/approval-status.js';
import { TOOL_EXECUTION_STATUS } from '../domain/tool/tool-execution-status.js';
import { assertUlid } from '../domain/shared/ulid.js';
import { AGGREGATE_TYPE_RUN } from '../infrastructure/outbox/outbox-status.js';
import {
  buildCanonicalEnvelope,
  redactEventData,
} from './fenced-run-event-recorder.js';
import { applyRunTransitionInTxn } from './run-transition.js';

const PARKED_TOOL_CANCELLABLE_STATUSES = new Set([
  TOOL_EXECUTION_STATUS.PROPOSED,
  TOOL_EXECUTION_STATUS.WAITING_APPROVAL,
  TOOL_EXECUTION_STATUS.RUNNING,
]);

async function appendEventInTxn({
  repos,
  run,
  eventType,
  data,
  generateId,
  now,
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
    timestamp,
    context,
    data: cleanData,
    eventVersion: 1,
  });
  await repos.outbox.insert({
    outboxId,
    aggregateType: AGGREGATE_TYPE_RUN,
    aggregateId: run.runId,
    eventType,
    payloadJson: {
      eventId: envelope.eventId,
      eventVersion: envelope.eventVersion,
      sequence: envelope.sequence,
      type: envelope.type,
      timestamp: envelope.timestamp,
      context: envelope.context,
      data: envelope.data,
      runId: run.runId,
      orgId: run.orgId,
      userId: run.userId,
    },
  });
}

/**
 * Terminalize a parked WAITING_APPROVAL Run inside an open transaction.
 *
 * @param {{
 *   repos: {
 *     approvals?: any,
 *     toolExecutions?: any,
 *     runs: any,
 *     runEvents: any,
 *     outbox: any,
 *   },
 *   run: object,
 *   scope: { orgId: string, userId: string },
 *   decidedBy: string,
 *   generateId: () => string,
 *   now?: () => Date,
 *   stateMachine?: { assertTransition: (from: string, to: string) => void },
 * }} input
 * @returns {Promise<{ status: string, run: object }>}
 */
export async function terminalizeParkedWaitingApprovalInTxn(input: { repos: { approvals?: any, toolExecutions?: any, runs: any, runEvents: any, outbox: any, }, run: Record<string, any>, scope: { orgId: string, userId: string }, decidedBy: string, generateId: () => string, now?: () => Date, stateMachine?: { assertTransition: (from: string, to: string) => void }, }) {
  const {
    repos,
    run,
    scope,
    decidedBy,
    generateId,
    now = () => new Date(),
    stateMachine = runStateMachine,
  } = input;

  if (run.status !== RUN_STATUS.WAITING_APPROVAL) {
    throw new ConflictError(
      `parked approval cancel requires WAITING_APPROVAL, was ${run.status}`,
      { resource: 'runs', id: run.runId },
    );
  }
  if (!repos.approvals || !repos.toolExecutions) {
    throw new Error(
      'parked approval cancellation requires approvals and toolExecutions repositories',
    );
  }

  const approvals = await repos.approvals.listByRunId(run.runId, scope, {
    forUpdate: true,
  });
  const tools = await repos.toolExecutions.listByRun(run.runId, scope);

  for (const approval of approvals) {
    if (approval.status !== APPROVAL_STATUS.PENDING) continue;
    const decided = await repos.approvals.decideIf({
      approvalId: approval.approvalId,
      orgId: scope.orgId,
      userId: scope.userId,
      fromStatus: APPROVAL_STATUS.PENDING,
      toStatus: APPROVAL_STATUS.CANCELLED,
      decisionBy: decidedBy,
      decisionReason: run.cancelReason ?? 'run cancelled while waiting approval',
    });
    if (decided.changed) {
      await appendEventInTxn({
        repos,
        run,
        eventType: 'approval.resolved',
        data: {
          approvalId: approval.approvalId,
          toolExecutionId: approval.toolExecutionId,
          decision: 'cancel',
          status: APPROVAL_STATUS.CANCELLED,
          reason: run.cancelReason ?? null,
          decisionBy: decidedBy,
          parkedCancellation: true,
        },
        generateId,
        now,
      });
    }
  }

  // Cancel any non-terminal tool still parked for this Run (PENDING or already
  // APPROVED-but-unexecuted both leave the tool WAITING_APPROVAL).
  for (const tool of tools) {
    if (!PARKED_TOOL_CANCELLABLE_STATUSES.has(tool.status)) continue;
    const cancelledTool = await repos.toolExecutions.transitionStatus({
      toolExecutionId: tool.toolExecutionId,
      orgId: scope.orgId,
      userId: scope.userId,
      fromStatus: tool.status,
      toStatus: TOOL_EXECUTION_STATUS.CANCELLED,
      resultJson: {
        cancelled: true,
        reason: run.cancelReason ?? null,
        parkedCancellation: true,
      },
      errorCode: 'RUN_CANCELLED',
      setCompletedAt: true,
    });
    await appendEventInTxn({
      repos,
      run,
      eventType: 'tool.execution.failed',
      data: {
        toolExecutionId: cancelledTool.toolExecution.toolExecutionId,
        toolCallId: cancelledTool.toolExecution.toolCallId,
        toolName: cancelledTool.toolExecution.toolName,
        status: TOOL_EXECUTION_STATUS.CANCELLED,
        cancelled: true,
        isError: true,
        errorCode: 'RUN_CANCELLED',
        parkedCancellation: true,
      },
      generateId,
      now,
    });
  }

  // APPROVED approvals stay APPROVED as historical facts; the tool was cancelled
  // above so resume will not re-execute. REJECTED/CANCELLED already terminal.

  const transitions = [
    [RUN_STATUS.WAITING_APPROVAL, RUN_STATUS.RUNNING, 'run.status.changed'],
    [RUN_STATUS.RUNNING, RUN_STATUS.CANCELLING, 'run.status.changed'],
    [RUN_STATUS.CANCELLING, RUN_STATUS.CANCELLED, 'run.cancelled'],
  ];
  let current = run;
  for (const [from, to, eventType] of transitions) {
    stateMachine.assertTransition(from, to);
    const transitioned = await applyRunTransitionInTxn({
      repos,
      runId: run.runId,
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
        `parked approval cancellation conflict at ${from} → ${to}`,
        { resource: 'runs', id: run.runId },
      );
    }
    current = transitioned.run;
  }

  // Defensive: ensure no residual PENDING approval remains after cancel.
  const after = await repos.approvals.listByRunId(run.runId, scope);
  if (after.some((a) => a.status === APPROVAL_STATUS.PENDING)) {
    throw new ConflictError('pending approval remained after parked cancel', {
      resource: 'runs',
      id: run.runId,
    });
  }

  return { status: RUN_STATUS.CANCELLED, run: current };
}
