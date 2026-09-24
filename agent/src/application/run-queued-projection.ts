/**
 * ACCEPTED → QUEUED projection, shared by every durable create path.
 *
 * The transition itself is one transaction: re-read the run FOR UPDATE, let
 * the domain RunStateMachine authorize ACCEPTED→QUEUED, CAS the status, then
 * append run.queued + its outbox row. A worker that already picked the job up
 * and advanced the run is not an error — it is the expected race, reported as
 * `alreadyAdvanced`.
 *
 * A failure here is recoverable and never rolls back the committed Run: the
 * caller surfaces it as a queue warning (the job is already enqueued, and
 * recovery reconciles the status).
 */

import { ConflictError } from '../infrastructure/mysql/errors.js';
import { AGGREGATE_TYPE_RUN } from '../infrastructure/outbox/outbox-status.js';
import { RUN_STATUS, runStateMachine } from '../domain/run/index.js';
import { assertUlid } from '../domain/shared/ulid.js';

/**
 * @param {{
 *   transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> },
 *   createRepositories: (db: any) => any,
 *   generateId: () => string,
 *   stateMachine?: import('../domain/run/run-state-machine.js').RunStateMachine,
 *   runId: string,
 *   orgId: string,
 *   userId: string,
 *   traceId: string,
 * }} args
 * @returns {Promise<{ ok: boolean, alreadyAdvanced?: boolean }>}
 */
export async function projectAcceptedToQueued(args: { transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> }, createRepositories: (db: any) => any, generateId: () => string, stateMachine?: import('../domain/run/run-state-machine.js').RunStateMachine, runId: string, orgId: string, userId: string, traceId: string, }) {
  const scope = { orgId: args.orgId, userId: args.userId };
  const stateMachine = args.stateMachine ?? runStateMachine;
  try {
    return await args.transactionManager.run(async (trx) => {
      const repos = args.createRepositories(trx);
      const run = await repos.runs.getById(args.runId, scope, {
        forUpdate: true,
      });
      if (!run) {
        return { ok: false };
      }

      if (run.status !== RUN_STATUS.ACCEPTED) {
        return { ok: true, alreadyAdvanced: true };
      }

      stateMachine.assertTransition(RUN_STATUS.ACCEPTED, RUN_STATUS.QUEUED);

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

      const eventId = assertUlid(args.generateId(), 'eventId');
      const outboxId = assertUlid(args.generateId(), 'outboxId');
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
