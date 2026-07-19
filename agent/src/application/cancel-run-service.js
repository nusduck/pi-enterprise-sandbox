/**
 * CancelRunService (PR-04 T2) — durable cancel intent + optional signal.
 *
 * Under one MySQL transaction:
 * 1. Resolve trusted external auth → owner.
 * 2. Load run owner-scoped.
 * 3. Terminal: idempotent return of existing intent; NO new intent write,
 *    NO Redis cancel signal.
 * 4. Non-terminal: persist cancel intent (first-writer wins). If sole
 *    RunStateMachine permits current → CANCELLING, CAS + durable status
 *    event + Outbox. A parked WAITING_INPUT Run has no Worker to finish the
 *    cancellation, so the same transaction first closes its interaction/tool
 *    ledger and then commits CANCELLING→CANCELLED.
 *    Otherwise intent alone. Never invent edges.
 * 5. COMMIT, then set Redis CancelSignal (non-terminal only).
 *
 * Redis failure must not erase MySQL intent; response indicates signal pending.
 * Only a parked WAITING_INPUT Run is terminalized by the API transaction;
 * active/queued Runs are still terminalized by the Worker.
 */

import { ConflictError } from '../infrastructure/mysql/errors.js';
import { RUN_STATUS, runStateMachine } from '../domain/run/index.js';
import { INTERACTION_STATUS } from '../domain/interaction/interaction-status.js';
import { TOOL_EXECUTION_STATUS } from '../domain/tool/tool-execution-status.js';
import { assertUlid, isLegacyOrUuidIdentity } from '../domain/shared/ulid.js';
import { AGGREGATE_TYPE_RUN } from '../infrastructure/outbox/outbox-status.js';
import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';
import {
  buildCanonicalEnvelope,
  redactEventData,
} from './fenced-run-event-recorder.js';
import { applyRunTransitionInTxn } from './run-transition.js';
import {
  OwnerScopedNotFoundError,
  ValidationError,
} from './errors.js';

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
  const cleanData = redactEventData(data ?? {});
  const context = {
    orgId: run.orgId,
    userId: run.userId,
    conversationId: run.conversationId,
    agentSessionId: run.agentSessionId,
    runId: run.runId,
    traceId: run.traceId,
    spanId: null,
  };
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
 * @typedef {{
 *   runId: string,
 *   status: string,
 *   cancelRequested: boolean,
 *   cancelRequestedAt: string | null,
 *   transitionedToCancelling: boolean,
 *   signalPending: boolean,
 *   terminal: boolean,
 * }} CancelRunResponse
 */

export class CancelRunService {
  /**
   * @param {{
   *   transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> },
   *   createRepositories: (db: any) => {
   *     organizations: any,
   *     externalRefs: any,
   *     runs: any,
   *     runEvents: any,
   *     outbox: any,
   *   },
   *   cancelSignal: { request: (runId: string, meta?: { reason?: string, requestedBy?: string }) => Promise<void> },
   *   generateId: () => string,
   *   now?: () => Date,
   *   runStateMachine?: import('../domain/run/run-state-machine.js').RunStateMachine,
   *   defaultProvider?: string,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.transactionManager?.run) {
      throw new Error('CancelRunService requires transactionManager.run');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('CancelRunService requires createRepositories(db)');
    }
    if (!deps.cancelSignal || typeof deps.cancelSignal.request !== 'function') {
      throw new Error('CancelRunService requires cancelSignal.request()');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('CancelRunService requires generateId()');
    }
    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.cancelSignal = deps.cancelSignal;
    this.generateId = deps.generateId;
    this.now = deps.now ?? (() => new Date());
    this.stateMachine = deps.runStateMachine ?? runStateMachine;
    this.defaultProvider = deps.defaultProvider;
  }

  /**
   * @param {{
   *   runId: string,
   *   auth: {
   *     provider?: string,
   *     externalOrgId: string,
   *     externalUserId: string,
   *   },
   *   reason?: string | null,
   * }} input
   * @returns {Promise<CancelRunResponse>}
   */
  async execute(input) {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('CancelRun input is required');
    }
    if (typeof input.runId !== 'string' || !input.runId.trim()) {
      throw new ValidationError('runId is required');
    }
    if (isLegacyOrUuidIdentity(input.runId)) {
      throw new OwnerScopedNotFoundError('Run not found', {
        resource: 'runs',
        id: input.runId,
      });
    }
    let runId;
    try {
      runId = assertUlid(input.runId, 'runId');
    } catch {
      throw new OwnerScopedNotFoundError('Run not found', {
        resource: 'runs',
        id: input.runId,
      });
    }
    if (!input.auth) {
      throw new ValidationError('auth (trusted external subjects) is required');
    }

    const committed = await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const resolver = new ExternalIdentityResolver(
        {
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
        },
        { defaultProvider: this.defaultProvider },
      );

      let owner;
      try {
        owner = await resolver.resolveOwner(input.auth);
      } catch (err) {
        if (err instanceof OwnerScopedNotFoundError) {
          throw new OwnerScopedNotFoundError('Run not found', {
            resource: 'runs',
            id: runId,
          });
        }
        throw err;
      }

      const scope = { orgId: owner.orgId, userId: owner.userId };
      const run = await repos.runs.getById(runId, scope, { forUpdate: true });
      if (!run) {
        throw new OwnerScopedNotFoundError('Run not found', {
          resource: 'runs',
          id: runId,
        });
      }

      // Terminal: idempotent — do not write new cancel intent, do not signal.
      if (this.stateMachine.isTerminal(run.status)) {
        return {
          runId,
          status: run.status,
          cancelRequested: run.cancelRequestedAt != null,
          cancelRequestedAt: run.cancelRequestedAt,
          transitionedToCancelling: false,
          terminal: true,
          skipSignal: true,
          requestedBy: run.cancelRequestedBy,
          reason: run.cancelReason,
        };
      }

      // Non-terminal: durable MySQL cancel intent (first-writer wins).
      const withIntent = await repos.runs.setCancelIntent(runId, scope, {
        reason: input.reason ?? null,
        requestedBy: owner.userId,
        requestedAt: this.now(),
      });

      let transitionedToCancelling = false;
      let status = withIntent.status;

      if (withIntent.status === RUN_STATUS.WAITING_INPUT) {
        if (!repos.interactions || !repos.toolExecutions) {
          throw new Error(
            'parked Run cancellation requires interactions and toolExecutions repositories',
          );
        }
        const interactions = await repos.interactions.listByRunId(
          runId,
          scope,
          { forUpdate: true },
        );
        const pendingInteractions = interactions.filter(
          (candidate) => candidate.status === INTERACTION_STATUS.PENDING,
        );
        if (pendingInteractions.length > 1) {
          throw new ConflictError(
            'WAITING_INPUT Run has multiple pending interactions',
            { resource: 'runs', id: runId },
          );
        }
        const interaction =
          pendingInteractions[0] ??
          [...interactions].reverse().find((candidate) =>
            [
              INTERACTION_STATUS.RESOLVED,
              INTERACTION_STATUS.CANCELLED,
            ].includes(candidate.status),
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
          toolExecution.agentSessionId !== withIntent.agentSessionId ||
          toolExecution.toolCallId !== interaction.toolCallId
        ) {
          throw new ConflictError(
            'parked interaction tool binding is inconsistent',
            { resource: 'interactions', id: interaction.interactionId },
          );
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
          const cancelledInteraction =
            await repos.interactions.cancelPendingForRun(runId, scope);
          if (
            !cancelledInteraction.changed ||
            cancelledInteraction.interaction?.interactionId !==
              interaction.interactionId
          ) {
            throw new ConflictError(
              'parked interaction cancel CAS lost race',
              { resource: 'interactions', id: interaction.interactionId },
            );
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
              reason: withIntent.cancelReason ?? null,
            },
            errorCode: 'RUN_CANCELLED',
            setCompletedAt: true,
          });
          toolExecution = cancelledTool.toolExecution;
        }
        if (toolWasCancellable || interactionCancelled) {
          if (interactionCancelled) {
            await appendEventInTxn({
              repos,
              run: withIntent,
              eventType: 'interaction.cancelled',
              data: {
                interactionId: interaction.interactionId,
                interactionType: interaction.interactionType,
                status: INTERACTION_STATUS.CANCELLED,
                toolExecutionId: toolExecution.toolExecutionId,
                toolCallId: toolExecution.toolCallId,
                cancelledBy: owner.userId,
              },
              generateId: this.generateId,
              now: this.now,
            });
          }
          if (toolWasCancellable) {
            await appendEventInTxn({
              repos,
              run: withIntent,
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
              generateId: this.generateId,
              now: this.now,
            });
          }
        }

        const transitions = [
          [RUN_STATUS.WAITING_INPUT, RUN_STATUS.RUNNING, 'run.status.changed'],
          [RUN_STATUS.RUNNING, RUN_STATUS.CANCELLING, 'run.status.changed'],
          [RUN_STATUS.CANCELLING, RUN_STATUS.CANCELLED, 'run.cancelled'],
        ];
        for (const [from, to, eventType] of transitions) {
          this.stateMachine.assertTransition(from, to);
          const transitioned = await applyRunTransitionInTxn({
            repos,
            runId,
            scope,
            from,
            to,
            traceId: withIntent.traceId,
            generateId: this.generateId,
            eventType,
            statusReason: withIntent.cancelReason,
            completedAt: to === RUN_STATUS.CANCELLED ? this.now() : undefined,
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
        status = RUN_STATUS.CANCELLED;
        transitionedToCancelling = true;
      }

      if (
        withIntent.status !== RUN_STATUS.WAITING_INPUT &&
        this.stateMachine.canTransition(withIntent.status, RUN_STATUS.CANCELLING)
      ) {
        this.stateMachine.assertTransition(
          withIntent.status,
          RUN_STATUS.CANCELLING,
        );
        const toCancelling = await applyRunTransitionInTxn({
          repos,
          runId,
          scope,
          from: withIntent.status,
          to: RUN_STATUS.CANCELLING,
          traceId: withIntent.traceId,
          generateId: this.generateId,
          eventType: 'run.status.changed',
          statusReason: withIntent.cancelReason,
          payloadExtra: { cancelRequested: true },
        });
        if (toCancelling.ok) {
          status = toCancelling.run.status;
          transitionedToCancelling = true;

        } else {
          const reloaded = toCancelling.current ??
            (await repos.runs.requireById(runId, scope));
          status = reloaded.status;
          transitionedToCancelling = [
            RUN_STATUS.CANCELLING,
            RUN_STATUS.CANCELLED,
          ].includes(status);
        }
      }

      return {
        runId,
        status,
        cancelRequested: true,
        cancelRequestedAt: withIntent.cancelRequestedAt,
        transitionedToCancelling,
        terminal: status === RUN_STATUS.CANCELLED,
        skipSignal: status === RUN_STATUS.CANCELLED,
        requestedBy: owner.userId,
        reason: withIntent.cancelReason,
      };
    });

    let signalPending = false;
    if (!committed.skipSignal) {
      try {
        await this.cancelSignal.request(runId, {
          reason: committed.reason ?? undefined,
          requestedBy: committed.requestedBy ?? undefined,
        });
      } catch {
        signalPending = true;
      }
    }

    return {
      runId: committed.runId,
      status: committed.status,
      cancelRequested: committed.cancelRequested,
      cancelRequestedAt: committed.cancelRequestedAt,
      transitionedToCancelling: committed.transitionedToCancelling,
      signalPending,
      terminal: committed.terminal,
    };
  }
}
