/** Durable user-interaction response and WAITING_INPUT wake-up coordination. */

import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';
import { OwnerScopedNotFoundError, ValidationError } from './errors.js';
import { sanitizeStatusReason } from './sanitize-status-reason.js';
import { assertUlid, isUlid } from '../domain/shared/ulid.js';
import { RUN_STATUS } from '../domain/run/index.js';
import { INTERACTION_STATUS } from '../domain/interaction/interaction-status.js';
import { TOOL_EXECUTION_STATUS } from '../domain/tool/tool-execution-status.js';
import { InteractionResponseValidationError } from '../domain/interaction/response-validation.js';
import { ConflictError, NotFoundError } from '../infrastructure/mysql/errors.js';
import { AGGREGATE_TYPE_RUN } from '../infrastructure/outbox/outbox-status.js';
import {
  buildCanonicalEnvelope,
  redactEventData,
} from './fenced-run-event-recorder.js';

function requiredUlid(value, field) {
  if (!isUlid(value)) throw new ValidationError(`${field} must be a ULID`);
  return assertUlid(value, field);
}

async function appendEventInTxn({ repos, run, eventType, data, generateId, now }) {
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

export class InteractionResponseService {
  /**
   * @param {{transactionManager:{run:Function},createRepositories:Function,runQueue:{enqueue:(ref:object,options?:object)=>Promise<unknown>},generateId:Function,now?:()=>Date}} deps
   */
  constructor(deps) {
    if (!deps?.transactionManager?.run) {
      throw new Error('InteractionResponseService requires transactionManager');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('InteractionResponseService requires createRepositories');
    }
    if (typeof deps.runQueue?.enqueue !== 'function') {
      throw new Error('InteractionResponseService requires runQueue.enqueue');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('InteractionResponseService requires generateId');
    }
    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.runQueue = deps.runQueue;
    this.generateId = deps.generateId;
    this.now = deps.now ?? (() => new Date());
  }

  async #resolveOwner(auth, repos) {
    return new ExternalIdentityResolver({
      organizations: repos.organizations,
      externalRefs: repos.externalRefs,
    }).resolveOwner(auth);
  }

  async #enqueue(run, interactionId) {
    try {
      await this.runQueue.enqueue(
        {
          runId: run.runId,
          orgId: run.orgId,
          traceId: run.traceId,
        },
        {
          jobId: `${run.runId}-interaction-${interactionId}`,
          attempts: 8,
          backoff: { type: 'exponential', delay: 250 },
        },
      );
      return { queued: true, resumePending: false, resumeError: null };
    } catch (error) {
      return {
        queued: false,
        resumePending: true,
        resumeError: sanitizeStatusReason(error) || 'Run resume enqueue failed',
      };
    }
  }

  async #getInteraction(repos, interactionId, owner, opts = {}) {
    try {
      return await repos.interactions.getById(interactionId, owner, opts);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new OwnerScopedNotFoundError('Interaction not found', {
          resource: 'interactions',
          id: interactionId,
        });
      }
      throw error;
    }
  }

  /** Resolve exactly once, append a redacted event, then best-effort wake Worker. */
  async respond(input) {
    const runId = requiredUlid(input?.runId, 'runId');
    const interactionId = requiredUlid(input?.interactionId, 'interactionId');
    if (!Object.prototype.hasOwnProperty.call(input || {}, 'response')) {
      throw new ValidationError('response is required');
    }

    const resolved = await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      if (!repos.interactions) {
        throw new Error('createRepositories must wire interactions');
      }
      const owner = await this.#resolveOwner(input.auth, repos);
      const run = await repos.runs.getById(runId, owner, { forUpdate: true });
      if (!run) {
        throw new OwnerScopedNotFoundError('Run not found', {
          resource: 'runs',
          id: runId,
        });
      }
      const interaction = await this.#getInteraction(
        repos,
        interactionId,
        owner,
        { forUpdate: true },
      );
      if (
        interaction.runId !== run.runId ||
        interaction.agentSessionId !== run.agentSessionId
      ) {
        throw new ConflictError('interaction does not belong to supplied Run', {
          resource: 'interactions',
          id: interactionId,
        });
      }
      if (
        interaction.status === INTERACTION_STATUS.PENDING &&
        run.status !== RUN_STATUS.WAITING_INPUT
      ) {
        throw new ConflictError(
          `pending interaction requires Run WAITING_INPUT, was ${run.status}`,
          { resource: 'runs', id: runId },
        );
      }
      const toolExecution = await repos.toolExecutions.getById(
        interaction.toolExecutionId,
        owner,
        { forUpdate: true },
      );
      if (
        toolExecution.runId !== run.runId ||
        toolExecution.toolCallId !== interaction.toolCallId ||
        toolExecution.agentSessionId !== run.agentSessionId
      ) {
        throw new ConflictError('interaction tool binding is inconsistent', {
          resource: 'interactions',
          id: interactionId,
        });
      }

      let result;
      try {
        result = await repos.interactions.resolveIfPending({
          interactionId,
          orgId: owner.orgId,
          userId: owner.userId,
          responseJson: input.response,
          respondedBy: owner.userId,
        });
      } catch (error) {
        if (error instanceof InteractionResponseValidationError) {
          throw new ValidationError(error.message);
        }
        throw error;
      }
      if (result.changed) {
        const completed = await repos.toolExecutions.transitionStatus({
          toolExecutionId: toolExecution.toolExecutionId,
          orgId: owner.orgId,
          userId: owner.userId,
          fromStatus: TOOL_EXECUTION_STATUS.RUNNING,
          toStatus: TOOL_EXECUTION_STATUS.SUCCEEDED,
          resultJson: {
            interactionId,
            response: input.response,
          },
          setCompletedAt: true,
        });
        if (completed.changed) {
          await appendEventInTxn({
            repos,
            run,
            eventType: 'tool.execution.completed',
            data: {
              interactionId,
              toolExecutionId: toolExecution.toolExecutionId,
              toolCallId: toolExecution.toolCallId,
              toolName: toolExecution.toolName,
              isError: false,
            },
            generateId: this.generateId,
            now: this.now,
          });
        }
        await appendEventInTxn({
          repos,
          run,
          eventType: 'interaction.resolved',
          data: {
            interactionId,
            interactionType: interaction.interactionType,
            status: INTERACTION_STATUS.RESOLVED,
            respondedBy: owner.userId,
          },
          generateId: this.generateId,
          now: this.now,
        });
      }
      return { run, interaction: result.interaction, changed: result.changed };
    });

    const wake =
      resolved.run.status === RUN_STATUS.WAITING_INPUT
        ? await this.#enqueue(
            resolved.run,
            resolved.interaction.interactionId,
          )
        : { queued: false, resumePending: false, resumeError: null };
    return {
      ok: true,
      interaction_id: resolved.interaction.interactionId,
      run_id: resolved.interaction.runId,
      status: 'resolved',
      changed: resolved.changed,
      queued: wake.queued,
      resumePending: wake.resumePending,
      resume_pending: wake.resumePending,
      resumeError: wake.resumeError,
      resume_error: wake.resumeError,
    };
  }

  /**
   * Re-enqueue resolved WAITING_INPUT Runs after an HTTP/Redis restart. Pending
   * interactions remain parked and are returned for UI rehydration.
   */
  async rehydrateWaiting(input = {}) {
    const limit = input.limit == null ? 100 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ValidationError('limit must be an integer between 1 and 200');
    }
    const snapshot = await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const owner = await this.#resolveOwner(input.auth, repos);
      let runs;
      if (input.runId != null && input.runId !== '') {
        const runId = requiredUlid(input.runId, 'runId');
        const run = await repos.runs.getById(runId, owner);
        if (!run) {
          throw new OwnerScopedNotFoundError('Run not found', {
            resource: 'runs',
            id: runId,
          });
        }
        runs = run.status === RUN_STATUS.WAITING_INPUT ? [run] : [];
      } else {
        runs = await repos.runs.listNonTerminal(owner, {
          statuses: [RUN_STATUS.WAITING_INPUT],
          limit,
        });
      }
      const items = [];
      for (const run of runs) {
        const interactions = await repos.interactions.listByRunId(run.runId, owner);
        const interaction = [...interactions].reverse().find((item) =>
          [INTERACTION_STATUS.PENDING, INTERACTION_STATUS.RESOLVED].includes(item.status),
        );
        if (interaction) items.push({ run, interaction });
      }
      return items;
    });

    const items = [];
    for (const item of snapshot) {
      const wake =
        item.interaction.status === INTERACTION_STATUS.RESOLVED
          ? await this.#enqueue(item.run, item.interaction.interactionId)
          : { queued: false, resumePending: false, resumeError: null };
      const request = item.interaction.requestJson || {};
      items.push({
        run_id: item.run.runId,
        status: 'waiting_input',
        interaction_id: item.interaction.interactionId,
        interaction_type: item.interaction.interactionType,
        title: request.title ?? null,
        message: request.message ?? null,
        options: Array.isArray(request.options) ? request.options : [],
        resolved: item.interaction.status === INTERACTION_STATUS.RESOLVED,
        queued: wake.queued,
        resume_pending: wake.resumePending,
        resume_error: wake.resumeError,
      });
    }
    return { ok: true, count: items.length, items };
  }
}
