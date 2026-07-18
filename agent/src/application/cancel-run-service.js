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
 *    event + Outbox. Otherwise intent alone. Never invent edges.
 * 5. COMMIT, then set Redis CancelSignal (non-terminal only).
 *
 * Redis failure must not erase MySQL intent; response indicates signal pending.
 * Never mark CANCELLED in the API response — worker completes terminalization.
 */

import { ConflictError } from '../infrastructure/mysql/errors.js';
import { AGGREGATE_TYPE_RUN } from '../infrastructure/outbox/outbox-status.js';
import { RUN_STATUS, runStateMachine } from '../domain/run/index.js';
import { assertUlid, isLegacyOrUuidIdentity } from '../domain/shared/ulid.js';
import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';
import {
  OwnerScopedNotFoundError,
  ValidationError,
} from './errors.js';

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

      if (
        this.stateMachine.canTransition(withIntent.status, RUN_STATUS.CANCELLING)
      ) {
        this.stateMachine.assertTransition(
          withIntent.status,
          RUN_STATUS.CANCELLING,
        );
        try {
          const updated = await repos.runs.updateStatusIf(runId, scope, {
            expectedStatus: withIntent.status,
            status: RUN_STATUS.CANCELLING,
            statusReason: withIntent.cancelReason,
          });
          status = updated.status;
          transitionedToCancelling = true;

          const eventId = assertUlid(this.generateId(), 'eventId');
          const outboxId = assertUlid(this.generateId(), 'outboxId');
          const evt = await repos.runEvents.append({
            eventId,
            runId,
            orgId: scope.orgId,
            userId: scope.userId,
            eventType: 'run.status.changed',
            eventVersion: 1,
            payloadJson: {
              from: withIntent.status,
              to: RUN_STATUS.CANCELLING,
              status: RUN_STATUS.CANCELLING,
              cancelRequested: true,
            },
            traceId: withIntent.traceId,
          });
          await repos.outbox.insert({
            outboxId,
            aggregateType: AGGREGATE_TYPE_RUN,
            aggregateId: runId,
            eventType: 'run.status.changed',
            payloadJson: {
              eventId: evt.eventId,
              runId,
              sequence: evt.sequenceNo,
              type: 'run.status.changed',
              status: RUN_STATUS.CANCELLING,
              orgId: scope.orgId,
              userId: scope.userId,
            },
          });
        } catch (err) {
          if (!(err instanceof ConflictError)) throw err;
          const reloaded = await repos.runs.requireById(runId, scope);
          status = reloaded.status;
          transitionedToCancelling = status === RUN_STATUS.CANCELLING;
        }
      }

      return {
        runId,
        status,
        cancelRequested: true,
        cancelRequestedAt: withIntent.cancelRequestedAt,
        transitionedToCancelling,
        terminal: false,
        skipSignal: false,
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
