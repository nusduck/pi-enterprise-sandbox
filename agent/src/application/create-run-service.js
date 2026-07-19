/**
 * CreateRunService (PR-04 T2) — durable create path, offline DI.
 *
 * Order of truth:
 * 1. Resolve/provision parents + begin idempotency under internal ULID owner
 *    scope in ONE MySQL transaction.
 * 2. Persist Message, Run(ACCEPTED), RunEvent(run.accepted), Outbox; complete
 *    idempotency response; COMMIT.
 * 3. Enqueue ref-only BullMQ job AFTER commit.
 * 4. Second transaction: sole RunStateMachine ACCEPTED→QUEUED + run.queued
 *    event + Outbox (worker race is idempotent).
 *
 * Queue / projection failure does NOT delete/rollback the committed Run —
 * returns ACCEPTED with a recoverable queueWarning.
 *
 * Idempotent replay: same key+body returns stored response and may safely
 * re-enqueue (jobId=runId) for recoverable statuses; never creates a second Run.
 *
 * No inline Pi/runtime execution. No process-local Map status authority.
 */

import { ConflictError } from '../infrastructure/mysql/errors.js';
import { AGGREGATE_TYPE_RUN } from '../infrastructure/outbox/outbox-status.js';
import { AGENT_RUNS_QUEUE_NAME } from '../infrastructure/redis/constants.js';
import {
  isTerminalRunStatus,
  RUN_STATUS,
  runStateMachine,
} from '../domain/run/index.js';
import { assertUlid, isUlid } from '../domain/shared/ulid.js';
import { hashCreateRunRequest } from './canonical-json.js';
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  ParentProvisioningRaceError,
  ValidationError,
} from './errors.js';
import { RunParentProvisioner } from './parent/run-parent-provisioner.js';
import { normalizeW3cTracestate } from '../infrastructure/sandbox/trace-context.js';

export const CREATE_RUN_OPERATION = 'create_run';
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_PROVISION_RETRIES = 5;

/** Queue warnings returned with status ACCEPTED (HTTP still success). */
export const QUEUE_WARNING = Object.freeze({
  ENQUEUE_FAILED: 'QUEUE_ENQUEUE_FAILED',
  STATUS_PROJECTION_FAILED: 'QUEUE_STATUS_PROJECTION_FAILED',
  REPLAY_RUN_MISSING: 'REPLAY_RUN_MISSING',
  REPLAY_INVALID_STORED: 'REPLAY_INVALID_STORED',
});

/**
 * Statuses for which create-path replay may re-enqueue (deterministic jobId).
 * STARTING/RUNNING are left to recovery reconciliation (no side-effect re-exec).
 */
const REPLAY_ENQUEUE_STATUSES = new Set([
  RUN_STATUS.ACCEPTED,
  RUN_STATUS.QUEUED,
  RUN_STATUS.RETRYING,
]);

/**
 * @typedef {{
 *   runId: string,
 *   status: 'ACCEPTED',
 *   conversationId: string,
 *   eventsUrl: string,
 *   agentSessionId?: string,
 *   queueWarning?: string | null,
 *   replayed?: boolean,
 * }} CreateRunResponse
 */

/**
 * @param {string} runId
 * @returns {string}
 */
export function buildEventsUrl(runId) {
  return `/api/runs/${assertUlid(runId, 'runId')}/events`;
}

/**
 * Normalize W3C trace-id (32 hex, not all-zero) for runs.trace_id CHAR(32).
 * @param {unknown} traceId
 * @returns {string} lowercase
 */
export function normalizeTraceId(traceId) {
  if (typeof traceId !== 'string' || !/^[0-9a-fA-F]{32}$/.test(traceId)) {
    throw new ValidationError(
      'traceId must be a 32-char hex W3C trace-id',
    );
  }
  const normalized = traceId.toLowerCase();
  if (normalized === '0'.repeat(32)) {
    throw new ValidationError(
      'traceId must not be the all-zero W3C invalid id',
    );
  }
  return normalized;
}

/** @param {unknown} traceState @returns {string | null} */
export function normalizeTraceState(traceState) {
  try {
    return normalizeW3cTracestate(traceState);
  } catch (error) {
    throw new ValidationError(
      error instanceof Error ? error.message : 'traceState is invalid',
    );
  }
}

/**
 * @param {unknown} messages
 * @returns {unknown[]}
 */
function requireMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ValidationError('messages must be a non-empty array');
  }
  return messages;
}

export class CreateRunService {
  /**
   * @param {{
   *   transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> },
   *   createRepositories: (db: any) => {
   *     organizations: any,
   *     externalRefs: any,
   *     catalog: any,
   *     conversations: any,
   *     sessions: any,
   *     messages: any,
   *     runs: any,
   *     runEvents: any,
   *     idempotency: any,
   *     outbox: any,
   *   },
   *   generateId: () => string,
   *   now?: () => Date,
   *   runQueue: { enqueue: (ref: { runId: string, orgId: string, traceId: string }) => Promise<unknown> },
   *   runStateMachine?: import('../domain/run/run-state-machine.js').RunStateMachine,
   *   queueName?: string,
   *   idempotencyTtlMs?: number,
   *   maxProvisionRetries?: number,
   *   defaultProvider?: string,
   *   source?: string,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.transactionManager?.run) {
      throw new Error('CreateRunService requires transactionManager.run');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('CreateRunService requires createRepositories(db)');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('CreateRunService requires generateId()');
    }
    if (!deps.runQueue || typeof deps.runQueue.enqueue !== 'function') {
      throw new Error('CreateRunService requires runQueue.enqueue()');
    }
    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.generateId = deps.generateId;
    this.now = deps.now ?? (() => new Date());
    this.runQueue = deps.runQueue;
    this.stateMachine = deps.runStateMachine ?? runStateMachine;
    this.queueName = deps.queueName ?? AGENT_RUNS_QUEUE_NAME;
    this.idempotencyTtlMs =
      deps.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.maxProvisionRetries =
      deps.maxProvisionRetries ?? DEFAULT_MAX_PROVISION_RETRIES;
    this.defaultProvider = deps.defaultProvider;
    this.source = deps.source ?? 'api';
  }

  /**
   * @param {{
   *   messages: unknown[],
   *   auth: {
   *     provider?: string,
   *     externalOrgId: string,
   *     externalUserId: string,
   *     externalConversationId?: string | null,
   *     displayName?: string | null,
   *     email?: string | null,
   *     orgName?: string | null,
   *   },
   *   traceId: string,
   *   traceState?: string | null,
   *   idempotencyKey: string,
   *   agentId?: string | null,
   *   agentProfileId?: string | null,
   *   budget?: unknown,
   *   spanId?: string | null,
   * }} input
   * @returns {Promise<CreateRunResponse>}
   */
  async execute(input) {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('CreateRun input is required');
    }
    const messages = requireMessages(input.messages);
    const traceId = normalizeTraceId(input.traceId);
    const traceState = normalizeTraceState(input.traceState);
    if (
      typeof input.idempotencyKey !== 'string' ||
      !input.idempotencyKey.trim()
    ) {
      throw new ValidationError('idempotencyKey is required');
    }
    const idempotencyKey = input.idempotencyKey.trim();
    if (!input.auth) {
      throw new ValidationError('auth (trusted external subjects) is required');
    }
    const agentId =
      input.agentId == null || input.agentId === ''
        ? null
        : assertUlid(input.agentId, 'agentId');

    const requestHash = hashCreateRunRequest({
      messages,
      externalConversationId: input.auth.externalConversationId ?? null,
      // A2A already used the bound Agent ULID as agentProfileId. Preserve that
      // hash shape across deploys while giving CreateRun an explicit selector.
      agentProfileId: input.agentProfileId ?? agentId,
      agentId:
        agentId && input.agentProfileId && input.agentProfileId !== agentId
          ? agentId
          : null,
      budget: input.budget ?? null,
    });

    let lastRace = null;
    for (let attempt = 0; attempt < this.maxProvisionRetries; attempt += 1) {
      try {
        return await this.#createOnce({
          messages,
          auth: input.auth,
          traceId,
          traceState,
          idempotencyKey,
          requestHash,
          spanId: input.spanId ?? null,
          agentId,
          agentProfileId: input.agentProfileId ?? null,
        });
      } catch (err) {
        if (err instanceof ParentProvisioningRaceError) {
          lastRace = err;
          continue;
        }
        throw err;
      }
    }
    throw (
      lastRace ??
      new ParentProvisioningRaceError(
        'Parent provisioning exhausted retries',
      )
    );
  }

  /**
   * @param {{
   *   messages: unknown[],
   *   auth: object,
   *   traceId: string,
   *   traceState: string | null,
   *   idempotencyKey: string,
   *   requestHash: string,
   *   spanId: string | null,
   *   agentId: string | null,
   *   agentProfileId: string | null,
   * }} ctx
   */
  async #createOnce(ctx) {
    const committed = await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const provisioner = new RunParentProvisioner(
        {
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
          catalog: repos.catalog,
          conversations: repos.conversations,
          sessions: repos.sessions,
        },
        {
          generateId: this.generateId,
          now: this.now,
          defaultProvider: this.defaultProvider,
          db: trx,
        },
      );

      const parents = await provisioner.provision(
        {
          ...ctx.auth,
          externalConversationId: ctx.auth.externalConversationId ?? null,
        },
        { agentId: ctx.agentId },
      );

      const scope = { orgId: parents.orgId, userId: parents.userId };
      const expiresAt = new Date(
        this.now().getTime() + this.idempotencyTtlMs,
      );

      let beginResult;
      try {
        beginResult = await repos.idempotency.begin({
          orgId: scope.orgId,
          userId: scope.userId,
          idempotencyKey: ctx.idempotencyKey,
          operation: CREATE_RUN_OPERATION,
          requestHash: ctx.requestHash,
          expiresAt,
        });
      } catch (err) {
        if (err instanceof ConflictError) {
          throw new IdempotencyConflictError(err.message, {
            idempotencyKey: ctx.idempotencyKey,
          });
        }
        throw err;
      }

      if (beginResult.outcome === 'replay') {
        const stored = beginResult.record.responseJson;
        const resourceId = beginResult.record.resourceId;
        if (!stored || typeof stored !== 'object') {
          return {
            kind: /** @type {const} */ ('replay_invalid'),
            orgId: scope.orgId,
            userId: scope.userId,
            reason: QUEUE_WARNING.REPLAY_INVALID_STORED,
          };
        }
        const runIdRaw = stored.runId ?? resourceId;
        if (typeof runIdRaw !== 'string' || !isUlid(runIdRaw)) {
          return {
            kind: /** @type {const} */ ('replay_invalid'),
            orgId: scope.orgId,
            userId: scope.userId,
            reason: QUEUE_WARNING.REPLAY_INVALID_STORED,
          };
        }
        const runId = assertUlid(runIdRaw, 'runId');
        const conversationId =
          typeof stored.conversationId === 'string' &&
          isUlid(stored.conversationId)
            ? assertUlid(stored.conversationId, 'conversationId')
            : parents.conversationId;

        return {
          kind: /** @type {const} */ ('replay'),
          orgId: scope.orgId,
          userId: scope.userId,
          runId,
          response: {
            runId,
            status: 'ACCEPTED',
            conversationId,
            eventsUrl: String(
              stored.eventsUrl ?? buildEventsUrl(runId),
            ),
            agentSessionId: stored.agentSessionId
              ? String(stored.agentSessionId)
              : undefined,
            replayed: true,
          },
        };
      }

      if (beginResult.outcome === 'in_progress') {
        throw new IdempotencyInProgressError(undefined, {
          idempotencyKey: ctx.idempotencyKey,
        });
      }

      // begun — allocate IDs then persist message → run → event → outbox
      const runId = assertUlid(this.generateId(), 'runId');
      const messageId = assertUlid(this.generateId(), 'messageId');
      const eventId = assertUlid(this.generateId(), 'eventId');
      const outboxId = assertUlid(this.generateId(), 'outboxId');

      const contentJson = {
        messages: ctx.messages,
        agentId: ctx.agentId,
        agentProfileId: ctx.agentProfileId,
      };

      await repos.messages.append({
        messageId,
        conversationId: parents.conversationId,
        orgId: scope.orgId,
        userId: scope.userId,
        agentSessionId: parents.agentSessionId,
        runId,
        role: 'user',
        messageType: 'text',
        contentJson,
      });

      await repos.runs.create({
        runId,
        orgId: scope.orgId,
        userId: scope.userId,
        conversationId: parents.conversationId,
        agentSessionId: parents.agentSessionId,
        agentVersionId: parents.agentVersionId,
        triggeringMessageId: messageId,
        source: this.source,
        status: RUN_STATUS.ACCEPTED,
        queueName: this.queueName,
        traceId: ctx.traceId,
        traceState: ctx.traceState,
        nextEventSequence: 0,
      });

      const acceptedEvent = await repos.runEvents.append({
        eventId,
        runId,
        orgId: scope.orgId,
        userId: scope.userId,
        eventType: 'run.accepted',
        eventVersion: 1,
        payloadJson: {
          status: RUN_STATUS.ACCEPTED,
          conversationId: parents.conversationId,
          agentSessionId: parents.agentSessionId,
          triggeringMessageId: messageId,
        },
          traceId: ctx.traceId,
          traceState: ctx.traceState,
        spanId: ctx.spanId,
      });

      await repos.outbox.insert({
        outboxId,
        aggregateType: AGGREGATE_TYPE_RUN,
        aggregateId: runId,
        eventType: 'run.accepted',
        payloadJson: {
          eventId: acceptedEvent.eventId,
          runId,
          sequence: acceptedEvent.sequenceNo,
          type: 'run.accepted',
          status: RUN_STATUS.ACCEPTED,
          orgId: scope.orgId,
          userId: scope.userId,
          conversationId: parents.conversationId,
        },
      });

      /** @type {CreateRunResponse} */
      const response = {
        runId,
        status: 'ACCEPTED',
        conversationId: parents.conversationId,
        eventsUrl: buildEventsUrl(runId),
        agentSessionId: parents.agentSessionId,
      };

      await repos.idempotency.complete({
        orgId: scope.orgId,
        userId: scope.userId,
        idempotencyKey: ctx.idempotencyKey,
        operation: CREATE_RUN_OPERATION,
        responseStatus: 202,
        responseJson: {
          runId: response.runId,
          status: response.status,
          conversationId: response.conversationId,
          eventsUrl: response.eventsUrl,
          agentSessionId: response.agentSessionId,
        },
        resourceId: runId,
      });

      return {
        kind: /** @type {const} */ ('created'),
        response,
        orgId: scope.orgId,
        userId: scope.userId,
        runId,
        traceId: ctx.traceId,
      };
    });

    // MySQL commit completed before any queue / HTTP response path.
    if (committed.kind === 'replay_invalid') {
      // Corrupt stored idempotency data: do not invent fake run ids.
      throw new ValidationError(
        'Idempotency replay record is missing or invalid stored response',
        { reason: committed.reason },
      );
    }

    if (committed.kind === 'replay') {
      return this.#handleReplayRecovery(committed);
    }

    return this.#afterCreateEnqueue(committed);
  }

  /**
   * Fresh create: enqueue then ACCEPTED→QUEUED projection.
   * @param {{
   *   response: CreateRunResponse,
   *   orgId: string,
   *   userId: string,
   *   runId: string,
   *   traceId: string,
   * }} committed
   */
  async #afterCreateEnqueue(committed) {
    /** @type {CreateRunResponse} */
    const response = { ...committed.response, queueWarning: null };

    try {
      await this.runQueue.enqueue({
        runId: committed.runId,
        orgId: committed.orgId,
        traceId: committed.traceId,
      });
    } catch {
      response.queueWarning = QUEUE_WARNING.ENQUEUE_FAILED;
      return response;
    }

    const proj = await this.#transitionAcceptedToQueued({
      runId: committed.runId,
      orgId: committed.orgId,
      userId: committed.userId,
      traceId: committed.traceId,
    });
    if (!proj.ok) {
      // Enqueue succeeded; MySQL projection failed — still ACCEPTED HTTP path.
      response.queueWarning = QUEUE_WARNING.STATUS_PROJECTION_FAILED;
    }
    return response;
  }

  /**
   * Idempotent replay: re-enqueue for recoverable statuses; never create a second Run.
   * @param {{
   *   response: CreateRunResponse,
   *   orgId: string,
   *   userId: string,
   *   runId: string,
   * }} committed
   */
  async #handleReplayRecovery(committed) {
    /** @type {CreateRunResponse} */
    const response = {
      ...committed.response,
      replayed: true,
      queueWarning: null,
    };

    const scope = { orgId: committed.orgId, userId: committed.userId };
    let run;
    try {
      run = await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        return repos.runs.getById(committed.runId, scope);
      });
    } catch {
      response.queueWarning = QUEUE_WARNING.REPLAY_RUN_MISSING;
      return response;
    }

    if (!run) {
      response.queueWarning = QUEUE_WARNING.REPLAY_RUN_MISSING;
      return response;
    }

    // Terminal: do not enqueue.
    if (isTerminalRunStatus(run.status)) {
      return response;
    }

    // Only re-enqueue statuses where a missing job is safe to recover.
    if (!REPLAY_ENQUEUE_STATUSES.has(run.status)) {
      return response;
    }

    const traceId = typeof run.traceId === 'string' ? run.traceId : null;
    if (!traceId || !/^[0-9a-f]{32}$/.test(traceId) || traceId === '0'.repeat(32)) {
      response.queueWarning = QUEUE_WARNING.REPLAY_INVALID_STORED;
      return response;
    }

    try {
      await this.runQueue.enqueue({
        runId: committed.runId,
        orgId: committed.orgId,
        traceId,
      });
    } catch {
      response.queueWarning = QUEUE_WARNING.ENQUEUE_FAILED;
      return response;
    }

    // Project ACCEPTED→QUEUED when still needed; worker race is ok.
    if (run.status === RUN_STATUS.ACCEPTED) {
      const proj = await this.#transitionAcceptedToQueued({
        runId: committed.runId,
        orgId: committed.orgId,
        userId: committed.userId,
        traceId,
      });
      if (!proj.ok) {
        response.queueWarning = QUEUE_WARNING.STATUS_PROJECTION_FAILED;
      }
    }

    // RETRYING is recovered by RecoveryService (RETRYING→QUEUED); create replay
    // only re-enqueues the deterministic job if already QUEUED-shaped work.
    return response;
  }

  /**
   * Second transaction: ACCEPTED → QUEUED via sole RunStateMachine + CAS.
   * Worker racing this transition is handled idempotently.
   *
   * @param {{
   *   runId: string,
   *   orgId: string,
   *   userId: string,
   *   traceId: string,
   * }} args
   * @returns {Promise<{ ok: boolean, alreadyAdvanced?: boolean }>}
   */
  async #transitionAcceptedToQueued(args) {
    const scope = { orgId: args.orgId, userId: args.userId };
    try {
      return await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        const run = await repos.runs.getById(args.runId, scope, {
          forUpdate: true,
        });
        if (!run) {
          return { ok: false };
        }

        if (run.status !== RUN_STATUS.ACCEPTED) {
          return { ok: true, alreadyAdvanced: true };
        }

        this.stateMachine.assertTransition(
          RUN_STATUS.ACCEPTED,
          RUN_STATUS.QUEUED,
        );

        try {
          await repos.runs.updateStatusIf(args.runId, scope, {
            expectedStatus: RUN_STATUS.ACCEPTED,
            status: RUN_STATUS.QUEUED,
          });
        } catch (err) {
          if (err instanceof ConflictError) {
            return { ok: true, alreadyAdvanced: true };
          }
          throw err;
        }

        const eventId = assertUlid(this.generateId(), 'eventId');
        const outboxId = assertUlid(this.generateId(), 'outboxId');
        const queuedEvent = await repos.runEvents.append({
          eventId,
          runId: args.runId,
          orgId: scope.orgId,
          userId: scope.userId,
          eventType: 'run.queued',
          eventVersion: 1,
          payloadJson: {
            status: RUN_STATUS.QUEUED,
            from: RUN_STATUS.ACCEPTED,
          },
          traceId: args.traceId,
        });

        await repos.outbox.insert({
          outboxId,
          aggregateType: AGGREGATE_TYPE_RUN,
          aggregateId: args.runId,
          eventType: 'run.queued',
          payloadJson: {
            eventId: queuedEvent.eventId,
            runId: args.runId,
            sequence: queuedEvent.sequenceNo,
            type: 'run.queued',
            status: RUN_STATUS.QUEUED,
            orgId: scope.orgId,
            userId: scope.userId,
          },
        });

        return { ok: true };
      });
    } catch {
      // Projection failure after enqueue is recoverable; surface via queueWarning.
      return { ok: false };
    }
  }
}
