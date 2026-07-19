/**
 * Durable steer admission for an active Run.
 *
 * The HTTP process and Worker are separate processes, so this service never
 * reaches for an in-memory Pi session. It appends the instruction Message,
 * run.steer.requested event, Outbox row, and idempotency response in one MySQL
 * transaction. PiRunExecutor consumes the durable request while prompt() runs.
 */

import { RUN_STATUS } from '../domain/run/index.js';
import { assertUlid, isLegacyOrUuidIdentity } from '../domain/shared/ulid.js';
import { ConflictError } from '../infrastructure/mysql/errors.js';
import { AGGREGATE_TYPE_RUN } from '../infrastructure/outbox/outbox-status.js';
import { hashCanonical } from './canonical-json.js';
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  OwnerScopedNotFoundError,
  ValidationError,
} from './errors.js';
import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';

export const STEER_RUN_OPERATION = 'steer_run';
export const STEER_REQUESTED_EVENT = 'run.steer.requested';
export const STEER_DELIVERED_EVENT = 'run.steer.delivered';
export const DEFAULT_STEER_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_STEER_TEXT_CHARS = 64 * 1024;

function requireRunId(value) {
  if (typeof value !== 'string' || !value.trim() || isLegacyOrUuidIdentity(value)) {
    throw new OwnerScopedNotFoundError('Run not found', {
      resource: 'runs',
      id: String(value ?? ''),
    });
  }
  try {
    return assertUlid(value.trim(), 'runId');
  } catch {
    throw new OwnerScopedNotFoundError('Run not found', {
      resource: 'runs',
      id: String(value),
    });
  }
}

function requireText(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('text is required');
  }
  const text = value.trim();
  if (text.length > MAX_STEER_TEXT_CHARS) {
    throw new ValidationError(
      `text exceeds max length ${MAX_STEER_TEXT_CHARS}`,
    );
  }
  return text;
}

export class SteerRunService {
  /**
   * @param {{
   *   transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> },
   *   createRepositories: (db: any) => any,
   *   generateId: () => string,
   *   now?: () => Date,
   *   defaultProvider?: string,
   *   idempotencyTtlMs?: number,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.transactionManager?.run) {
      throw new Error('SteerRunService requires transactionManager.run');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('SteerRunService requires createRepositories');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('SteerRunService requires generateId');
    }
    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.generateId = deps.generateId;
    this.now = deps.now ?? (() => new Date());
    this.defaultProvider = deps.defaultProvider;
    this.idempotencyTtlMs =
      deps.idempotencyTtlMs ?? DEFAULT_STEER_IDEMPOTENCY_TTL_MS;
  }

  /**
   * @param {{
   *   runId: string,
   *   text: string,
   *   auth: { provider?: string, externalOrgId: string, externalUserId: string },
   *   traceId: string,
   *   traceState?: string | null,
   *   idempotencyKey: string,
   *   conversationId?: string | null,
   *   spanId?: string | null,
   * }} input
   */
  async execute(input) {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('SteerRun input is required');
    }
    const runId = requireRunId(input.runId);
    const text = requireText(input.text);
    if (!input.auth) {
      throw new ValidationError('auth (trusted external subjects) is required');
    }
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) {
      throw new ValidationError('idempotencyKey is required');
    }
    const idempotencyKey = input.idempotencyKey.trim();
    const traceId = String(input.traceId || '').trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === '0'.repeat(32)) {
      throw new ValidationError('traceId must be a non-zero W3C trace id');
    }
    const requestedConversationId = input.conversationId
      ? assertUlid(input.conversationId, 'conversationId')
      : null;
    const requestHash = hashCanonical({ runId, text, requestedConversationId });

    return this.tx.run(async (trx) => {
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
      } catch (error) {
        if (error instanceof OwnerScopedNotFoundError) {
          throw new OwnerScopedNotFoundError('Run not found', {
            resource: 'runs',
            id: runId,
          });
        }
        throw error;
      }
      const scope = { orgId: owner.orgId, userId: owner.userId };
      const run = await repos.runs.getById(runId, scope, { forUpdate: true });
      if (!run) {
        throw new OwnerScopedNotFoundError('Run not found', {
          resource: 'runs',
          id: runId,
        });
      }
      if (
        requestedConversationId &&
        requestedConversationId !== run.conversationId
      ) {
        throw new OwnerScopedNotFoundError('Run not found', {
          resource: 'runs',
          id: runId,
        });
      }
      if (run.status !== RUN_STATUS.RUNNING) {
        throw new ConflictError('Run is not accepting steer instructions', {
          resource: 'runs',
          id: runId,
        });
      }

      let begun;
      try {
        begun = await repos.idempotency.begin({
          orgId: scope.orgId,
          userId: scope.userId,
          idempotencyKey,
          operation: STEER_RUN_OPERATION,
          requestHash,
          expiresAt: new Date(this.now().getTime() + this.idempotencyTtlMs),
        });
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new IdempotencyConflictError(error.message, {
            idempotencyKey,
          });
        }
        throw error;
      }

      if (begun.outcome === 'in_progress') {
        throw new IdempotencyInProgressError(undefined, { idempotencyKey });
      }
      if (begun.outcome === 'replay') {
        const stored = begun.record.responseJson;
        if (!stored || typeof stored !== 'object') {
          throw new ValidationError('Stored steer idempotency response is invalid');
        }
        return { ...stored, replayed: true };
      }

      const messageId = assertUlid(this.generateId(), 'messageId');
      const steerId = assertUlid(this.generateId(), 'steerId');
      const outboxId = assertUlid(this.generateId(), 'outboxId');

      await repos.messages.append({
        messageId,
        conversationId: run.conversationId,
        orgId: scope.orgId,
        userId: scope.userId,
        agentSessionId: run.agentSessionId,
        runId,
        role: 'user',
        messageType: 'steer_instruction',
        contentJson: { text },
      });

      const event = await repos.runEvents.append({
        eventId: steerId,
        runId,
        orgId: scope.orgId,
        userId: scope.userId,
        eventType: STEER_REQUESTED_EVENT,
        eventVersion: 1,
        payloadJson: {
          steerId,
          messageId,
          conversationId: run.conversationId,
          agentSessionId: run.agentSessionId,
        },
        traceId,
        spanId: input.spanId ?? null,
      });

      await repos.outbox.insert({
        outboxId,
        aggregateType: AGGREGATE_TYPE_RUN,
        aggregateId: runId,
        eventType: STEER_REQUESTED_EVENT,
        payloadJson: {
          eventId: event.eventId,
          eventVersion: 1,
          sequence: event.sequenceNo,
          type: STEER_REQUESTED_EVENT,
          runId,
          orgId: scope.orgId,
          userId: scope.userId,
          conversationId: run.conversationId,
          data: { steerId, messageId },
        },
      });

      const response = {
        runId,
        steerId,
        messageId,
        sequence: event.sequenceNo,
        status: 'ACCEPTED',
      };
      await repos.idempotency.complete({
        orgId: scope.orgId,
        userId: scope.userId,
        idempotencyKey,
        operation: STEER_RUN_OPERATION,
        responseStatus: 202,
        responseJson: response,
        resourceId: steerId,
      });
      return response;
    });
  }
}
