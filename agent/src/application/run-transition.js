/**
 * Shared durable Run transition helper (CAS + RunEvent + Outbox in one txn work fn).
 * Used by ExecuteRunService and recovery projection paths.
 */

import { AGGREGATE_TYPE_RUN } from '../infrastructure/outbox/outbox-status.js';
import { ConflictError } from '../infrastructure/mysql/errors.js';
import { assertUlid } from '../domain/shared/ulid.js';
import { sanitizeStatusReason } from './sanitize-status-reason.js';

/**
 * Apply a state-machine-validated transition inside an open transaction.
 *
 * @param {{
 *   repos: {
 *     runs: any,
 *     runEvents: any,
 *     outbox: any,
 *   },
 *   runId: string,
 *   scope: { orgId: string, userId: string },
 *   from: string,
 *   to: string,
 *   traceId: string,
 *   generateId: () => string,
 *   eventType?: string,
 *   statusReason?: string | null,
 *   attempt?: number,
 *   startedAt?: Date | string | null,
 *   completedAt?: Date | string | null,
 *   payloadExtra?: Record<string, unknown>,
 * }} args
 * @returns {Promise<{ ok: true, run: object, event: object } | { ok: false, reason: 'conflict'|'not_found', current?: object | null }>}
 */
export async function applyRunTransitionInTxn(args) {
  const {
    repos,
    runId,
    scope,
    from,
    to,
    traceId,
    generateId,
    eventType = 'run.status.changed',
    statusReason,
    attempt,
    startedAt,
    completedAt,
    payloadExtra = {},
  } = args;

  /** @type {Record<string, unknown>} */
  const patch = {
    expectedStatus: from,
    status: to,
  };
  if (statusReason !== undefined) {
    patch.statusReason = sanitizeStatusReason(statusReason);
  }
  if (attempt !== undefined) patch.attempt = attempt;
  if (startedAt !== undefined) patch.startedAt = startedAt;
  if (completedAt !== undefined) patch.completedAt = completedAt;

  let run;
  try {
    run = await repos.runs.updateStatusIf(runId, scope, patch);
  } catch (err) {
    if (err instanceof ConflictError) {
      const current = await repos.runs.getById(runId, scope);
      return { ok: false, reason: 'conflict', current };
    }
    throw err;
  }

  if (!run) {
    return { ok: false, reason: 'not_found', current: null };
  }

  const eventId = assertUlid(generateId(), 'eventId');
  const outboxId = assertUlid(generateId(), 'outboxId');
  const event = await repos.runEvents.append({
    eventId,
    runId,
    orgId: scope.orgId,
    userId: scope.userId,
    eventType,
    eventVersion: 1,
    payloadJson: {
      from,
      to,
      status: to,
      ...payloadExtra,
    },
    traceId,
  });

  await repos.outbox.insert({
    outboxId,
    aggregateType: AGGREGATE_TYPE_RUN,
    aggregateId: runId,
    eventType,
    payloadJson: {
      eventId: event.eventId,
      runId,
      sequence: event.sequenceNo,
      type: eventType,
      status: to,
      orgId: scope.orgId,
      userId: scope.userId,
    },
  });

  return { ok: true, run, event };
}
