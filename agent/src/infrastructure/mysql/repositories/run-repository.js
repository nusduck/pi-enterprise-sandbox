/**
 * Run repository (plan §8.10) — ownership-scoped.
 * next_event_sequence is owned by RunEventRepository allocation.
 *
 * PR-04 T1 additions for Run services:
 * - list non-terminal / recoverable runs (worker recovery)
 * - conditional status update accepting expected current status(es)
 * - plan ULID + Run status + trace_id validation on writes/filters
 *
 * No internal transition table — callers use domain RunStateMachine to decide
 * the next status; this repository only persists under owner + CAS guards.
 */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { mapRun, toMysqlDateTime, formatDateTime } from '../row-mappers.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { assertUlid } from '../../../domain/shared/ulid.js';
import {
  isRunStatus,
  NON_TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
} from '../../../domain/run/run-status.js';
import { InvalidRunStatusError } from '../../../domain/run/errors.js';
import { normalizeW3cTracestate } from '../../sandbox/trace-context.js';

/** Default / max page size for list helpers. */
export const RUN_LIST_DEFAULT_LIMIT = 50;
export const RUN_LIST_MAX_LIMIT = 200;

/** Bound for cancel_reason (migration 20260718000004). */
export const CANCEL_REASON_MAX_LEN = 255;

/** plan §8.10 runs.trace_id is CHAR(32). */
export const TRACE_ID_PATTERN = /^[0-9a-fA-F]{32}$/;

/** W3C forbids the all-zero trace-id. */
export const TRACE_ID_ALL_ZERO = '0'.repeat(32);

/**
 * @param {unknown} limit
 * @param {number} [fallback]
 * @returns {number}
 */
export function resolveRunListLimit(limit, fallback = RUN_LIST_DEFAULT_LIMIT) {
  if (limit == null) return fallback;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `limit must be an integer between 1 and ${RUN_LIST_MAX_LIMIT}`,
    );
  }
  if (n > RUN_LIST_MAX_LIMIT) {
    throw new Error(
      `limit must be an integer between 1 and ${RUN_LIST_MAX_LIMIT}`,
    );
  }
  return n;
}

/**
 * @param {unknown} status
 * @param {string} [field]
 * @returns {string}
 */
export function assertRunStatus(status, field = 'status') {
  if (!isRunStatus(status)) {
    throw new InvalidRunStatusError(
      status,
      `Invalid ${field}: expected plan §10 Run status`,
    );
  }
  return /** @type {string} */ (status);
}

/**
 * W3C trace-id: 32 hex, not all-zero; returns lowercase canonical form.
 * @param {unknown} traceId
 * @returns {string}
 */
export function assertTraceId(traceId) {
  if (typeof traceId !== 'string' || !TRACE_ID_PATTERN.test(traceId)) {
    throw new Error('traceId must be 32 hex characters (CHAR(32))');
  }
  const normalized = traceId.toLowerCase();
  if (normalized === TRACE_ID_ALL_ZERO) {
    throw new Error('traceId must not be the all-zero W3C invalid id');
  }
  return normalized;
}

/** @param {unknown} traceState @returns {string | null} */
export function assertTraceState(traceState) {
  try {
    return normalizeW3cTracestate(traceState);
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'traceState is invalid',
    );
  }
}

/**
 * Normalize expected status(es) for conditional update.
 * @param {string | string[]} expected
 * @returns {string[]}
 */
export function normalizeExpectedStatuses(expected) {
  const list = Array.isArray(expected) ? expected : [expected];
  const out = [];
  for (const s of list) {
    if (typeof s !== 'string' || !s.trim()) {
      throw new Error('expectedStatus(es) must be non-empty strings');
    }
    out.push(assertRunStatus(s.trim(), 'expectedStatus'));
  }
  if (!out.length) {
    throw new Error('expectedStatus(es) must be non-empty strings');
  }
  return out;
}

/**
 * @param {{ orgId: string, userId: string }} scope
 */
function requireOwnerUlids(scope) {
  const s = requireOwnerScope(scope);
  return {
    orgId: assertUlid(s.orgId, 'orgId'),
    userId: assertUlid(s.userId, 'userId'),
  };
}

/**
 * Extend core mapRun with PR-04 T2 cancel intent columns (additive).
 * @param {Record<string, unknown>} row
 */
export function mapRunRow(row) {
  const base = mapRun(row);
  return {
    ...base,
    cancelRequestedAt: formatDateTime(row.cancel_requested_at),
    cancelReason:
      row.cancel_reason == null ? null : String(row.cancel_reason),
    cancelRequestedBy:
      row.cancel_requested_by == null
        ? null
        : String(row.cancel_requested_by),
  };
}

/**
 * Sanitize cancel reason: strip controls, bound length, never store secrets patterns.
 * @param {unknown} reason
 * @returns {string | null}
 */
export function sanitizeCancelReason(reason) {
  if (reason == null) return null;
  if (typeof reason !== 'string') {
    throw new Error('cancel reason must be a string when provided');
  }
  // Strip C0 controls and DEL; collapse whitespace.
  let s = reason.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // Drop obvious bearer / token material rather than storing it.
  if (/bearer\s+[a-z0-9._\-]+/i.test(s) || /authorization\s*:/i.test(s)) {
    s = '[redacted]';
  }
  if (s.length > CANCEL_REASON_MAX_LEN) {
    s = s.slice(0, CANCEL_REASON_MAX_LEN);
  }
  return s;
}

export class RunRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   * @param {{ now?: () => Date }} [opts]
   */
  constructor(db, opts = {}) {
    if (!db) throw new Error('RunRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * @param {{
   *   runId: string,
   *   orgId: string,
   *   userId: string,
   *   conversationId: string,
   *   agentSessionId: string,
   *   agentVersionId: string,
   *   triggeringMessageId: string,
   *   source: string,
   *   status: string,
   *   statusReason?: string | null,
   *   queueName: string,
   *   attempt?: number,
   *   traceId: string,
   *   nextEventSequence?: number,
   *   startedAt?: Date | string | null,
   *   completedAt?: Date | string | null,
   *   createdAt?: Date | string,
   *   updatedAt?: Date | string,
   * }} input
   */
  async create(input) {
    const scope = requireOwnerUlids(input);
    const runId = assertUlid(input.runId, 'runId');
    const conversationId = assertUlid(input.conversationId, 'conversationId');
    const agentSessionId = assertUlid(input.agentSessionId, 'agentSessionId');
    const agentVersionId = assertUlid(input.agentVersionId, 'agentVersionId');
    const triggeringMessageId = assertUlid(
      input.triggeringMessageId,
      'triggeringMessageId',
    );
    const status = assertRunStatus(input.status);
    const traceId = assertTraceId(input.traceId);
    const traceState = assertTraceState(input.traceState);

    const now = toMysqlDateTime(input.createdAt || this.now());
    await this.db('runs').insert({
      run_id: runId,
      org_id: scope.orgId,
      user_id: scope.userId,
      conversation_id: conversationId,
      agent_session_id: agentSessionId,
      agent_version_id: agentVersionId,
      triggering_message_id: triggeringMessageId,
      source: input.source,
      status,
      status_reason: input.statusReason ?? null,
      queue_name: input.queueName,
      attempt: input.attempt ?? 0,
      trace_id: traceId,
      trace_state: traceState,
      next_event_sequence: input.nextEventSequence ?? 0,
      started_at: input.startedAt ? toMysqlDateTime(input.startedAt) : null,
      completed_at: input.completedAt ? toMysqlDateTime(input.completedAt) : null,
      cancel_requested_at: null,
      cancel_reason: null,
      cancel_requested_by: null,
      created_at: now,
      updated_at: toMysqlDateTime(input.updatedAt || input.createdAt || this.now()),
    });
    return this.getById(runId, scope);
  }

  /**
   * @param {string} runId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  async getById(runId, scope, opts = {}) {
    const s = requireOwnerUlids(scope);
    const id = assertUlid(runId, 'runId');
    let q = applyOwnerScope(this.db('runs').where({ run_id: id }), s);
    if (opts.forUpdate) q = q.forUpdate();
    const row = await q.first();
    return row ? mapRunRow(row) : null;
  }

  /**
   * @param {string} runId
   * @param {{ orgId: string, userId: string }} scope
   */
  async requireById(runId, scope) {
    const row = await this.getById(runId, scope);
    if (!row) {
      throw new NotFoundError('Run not found', {
        resource: 'runs',
        id: runId,
      });
    }
    return row;
  }

  /**
   * Worker load: org-scoped only (job carries orgId, not userId).
   * Never crosses org boundaries. After load, callers build full owner scope
   * from the returned run.userId.
   *
   * @param {string} runId
   * @param {string} orgId
   * @param {{ forUpdate?: boolean }} [opts]
   */
  async getByIdForOrg(runId, orgId, opts = {}) {
    const id = assertUlid(runId, 'runId');
    const oid = assertUlid(orgId, 'orgId');
    let q = this.db('runs').where({ run_id: id, org_id: oid });
    if (opts.forUpdate) q = q.forUpdate();
    const row = await q.first();
    return row ? mapRunRow(row) : null;
  }

  /**
   * @param {string} runId
   * @param {string} orgId
   * @param {{ forUpdate?: boolean }} [opts]
   */
  async requireByIdForOrg(runId, orgId, opts = {}) {
    const row = await this.getByIdForOrg(runId, orgId, opts);
    if (!row) {
      throw new NotFoundError('Run not found', {
        resource: 'runs',
        id: runId,
      });
    }
    return row;
  }

  /**
   * System-worker scan of non-terminal runs (PR-04 T3 recovery).
   *
   * Explicitly NOT an owner API — no userId filter. Use only from trusted
   * recovery/requeue workers. Bounded by limit + optional afterRunId cursor
   * (run_id ascending). Optional orgId narrows a single tenant for safety.
   *
   * Returns full rows so callers can build ref-only jobs { runId, orgId, traceId }.
   *
   * @param {{
   *   statuses?: string[],
   *   limit?: number,
   *   afterRunId?: string | null,
   *   orgId?: string | null,
   * }} [opts]
   */
  async listNonTerminalForSystemWorker(opts = {}) {
    const limit = resolveRunListLimit(opts.limit, RUN_LIST_DEFAULT_LIMIT);
    const statuses =
      opts.statuses && opts.statuses.length
        ? opts.statuses.map((st) => assertRunStatus(st, 'statuses'))
        : [...NON_TERMINAL_RUN_STATUSES];

    let q = this.db('runs')
      .whereIn('status', statuses)
      .orderBy('run_id', 'asc')
      .limit(limit);

    if (opts.afterRunId) {
      q = q.andWhere('run_id', '>', assertUlid(opts.afterRunId, 'afterRunId'));
    }
    if (opts.orgId) {
      q = q.andWhere({ org_id: assertUlid(opts.orgId, 'orgId') });
    }

    const rows = await q;
    return rows.map(mapRunRow);
  }

  /**
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ conversationId?: string, status?: string, limit?: number }} [opts]
   */
  async list(scope, opts = {}) {
    const s = requireOwnerUlids(scope);
    const limit = resolveRunListLimit(opts.limit, RUN_LIST_DEFAULT_LIMIT);
    let q = applyOwnerScope(this.db('runs'), s).orderBy('created_at', 'desc');
    if (opts.conversationId) {
      q = q.andWhere({
        conversation_id: assertUlid(opts.conversationId, 'conversationId'),
      });
    }
    if (opts.status) q = q.andWhere({ status: assertRunStatus(opts.status) });
    q = q.limit(limit);
    const rows = await q;
    return rows.map(mapRunRow);
  }

  /** Owner-scoped lookup used by the durable Trace query endpoint. */
  async listByTraceId(traceId, scope, opts = {}) {
    const s = requireOwnerUlids(scope);
    const trace = assertTraceId(traceId);
    const limit = resolveRunListLimit(opts.limit, RUN_LIST_DEFAULT_LIMIT);
    const rows = await applyOwnerScope(
      this.db('runs').where({ trace_id: trace }),
      s,
    )
      .orderBy('created_at', 'asc')
      .limit(limit);
    return rows.map(mapRunRow);
  }

  /**
   * List non-terminal runs for an owner (worker recovery / health).
   * Status filter uses plan §10 non-terminal set — not an internal transition table.
   *
   * @param {{ orgId: string, userId: string }} scope
   * @param {{
   *   conversationId?: string,
   *   agentSessionId?: string,
   *   limit?: number,
   *   statuses?: string[],
   * }} [opts]
   */
  async listNonTerminal(scope, opts = {}) {
    const s = requireOwnerUlids(scope);
    const limit = resolveRunListLimit(opts.limit, RUN_LIST_DEFAULT_LIMIT);
    const statuses =
      opts.statuses && opts.statuses.length
        ? opts.statuses.map((st) => assertRunStatus(st, 'statuses'))
        : [...NON_TERMINAL_RUN_STATUSES];

    let q = applyOwnerScope(this.db('runs'), s)
      .whereIn('status', statuses)
      .orderBy('created_at', 'asc');
    if (opts.conversationId) {
      q = q.andWhere({
        conversation_id: assertUlid(opts.conversationId, 'conversationId'),
      });
    }
    if (opts.agentSessionId) {
      q = q.andWhere({
        agent_session_id: assertUlid(opts.agentSessionId, 'agentSessionId'),
      });
    }
    q = q.limit(limit);
    const rows = await q;
    return rows.map(mapRunRow);
  }

  /**
   * Recoverable = non-terminal (alias for workers scanning incomplete work).
   * Explicitly excludes plan §10 terminal set.
   *
   * @param {{ orgId: string, userId: string }} scope
   * @param {{
   *   conversationId?: string,
   *   agentSessionId?: string,
   *   limit?: number,
   * }} [opts]
   */
  async listRecoverable(scope, opts = {}) {
    return this.listNonTerminal(scope, {
      ...opts,
      statuses: [...NON_TERMINAL_RUN_STATUSES],
    });
  }

  /**
   * Unconditional status patch (preserved API). Prefer
   * {@link updateStatusIf} for RunStateMachine-controlled transitions.
   *
   * @param {string} runId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{
   *   status?: string,
   *   statusReason?: string | null,
   *   attempt?: number,
   *   startedAt?: Date | string | null,
   *   completedAt?: Date | string | null,
   * }} patch
   */
  async updateStatus(runId, scope, patch) {
    const s = requireOwnerUlids(scope);
    const id = assertUlid(runId, 'runId');
    /** @type {Record<string, unknown>} */
    const update = { updated_at: toMysqlDateTime(this.now()) };
    if (patch.status !== undefined) update.status = assertRunStatus(patch.status);
    if (patch.statusReason !== undefined) update.status_reason = patch.statusReason;
    if (patch.attempt !== undefined) update.attempt = patch.attempt;
    if (patch.startedAt !== undefined) {
      update.started_at = patch.startedAt ? toMysqlDateTime(patch.startedAt) : null;
    }
    if (patch.completedAt !== undefined) {
      update.completed_at = patch.completedAt
        ? toMysqlDateTime(patch.completedAt)
        : null;
    }
    const n = await applyOwnerScope(
      this.db('runs').where({ run_id: id }),
      s,
    ).update(update);
    if (!n) {
      throw new NotFoundError('Run not found', {
        resource: 'runs',
        id: runId,
      });
    }
    return this.requireById(id, s);
  }

  /**
   * Conditional status update: only succeeds when current status is in
   * `expectedStatus` / `expectedStatuses`. Suitable for
   * RunStateMachine-controlled transitions (compare-and-set).
   *
   * Does not embed a transition table — caller supplies the expected source
   * statuses and the already-validated target status.
   *
   * @param {string} runId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{
   *   expectedStatus?: string,
   *   expectedStatuses?: string[],
   *   status: string,
   *   statusReason?: string | null,
   *   attempt?: number,
   *   startedAt?: Date | string | null,
   *   completedAt?: Date | string | null,
   * }} patch
   */
  async updateStatusIf(runId, scope, patch) {
    const s = requireOwnerUlids(scope);
    const id = assertUlid(runId, 'runId');
    if (typeof patch.status !== 'string' || !patch.status.trim()) {
      throw new Error('updateStatusIf requires a non-empty target status');
    }
    const target = assertRunStatus(patch.status);
    const expected = normalizeExpectedStatuses(
      patch.expectedStatuses ?? patch.expectedStatus ?? [],
    );

    /** @type {Record<string, unknown>} */
    const update = {
      status: target,
      updated_at: toMysqlDateTime(this.now()),
    };
    if (patch.statusReason !== undefined) {
      update.status_reason = patch.statusReason;
    }
    if (patch.attempt !== undefined) update.attempt = patch.attempt;
    if (patch.startedAt !== undefined) {
      update.started_at = patch.startedAt ? toMysqlDateTime(patch.startedAt) : null;
    }
    if (patch.completedAt !== undefined) {
      update.completed_at = patch.completedAt
        ? toMysqlDateTime(patch.completedAt)
        : null;
    }

    const n = await applyOwnerScope(
      this.db('runs').where({ run_id: id }).whereIn('status', expected),
      s,
    ).update(update);

    if (n) {
      return this.requireById(id, s);
    }

    const current = await this.getById(id, s);
    if (!current) {
      throw new NotFoundError('Run not found', {
        resource: 'runs',
        id: runId,
      });
    }
    throw new ConflictError(
      `Run status conflict: expected one of [${expected.join(', ')}], was ${current.status}`,
      { resource: 'runs', id: runId },
    );
  }

  /**
   * Persist durable cancel intent (first-writer wins). Does not change status.
   * Status transitions to CANCELLING remain the sole RunStateMachine's job.
   *
   * @param {string} runId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{
   *   reason?: string | null,
   *   requestedBy: string,
   *   requestedAt?: Date | string,
   * }} intent
   */
  async setCancelIntent(runId, scope, intent) {
    const s = requireOwnerUlids(scope);
    const id = assertUlid(runId, 'runId');
    const requestedBy = assertUlid(intent.requestedBy, 'requestedBy');
    const reason = sanitizeCancelReason(intent.reason);
    const at = toMysqlDateTime(intent.requestedAt || this.now());

    // First-writer wins: only fill null cancel_requested_at.
    const n = await applyOwnerScope(
      this.db('runs').where({ run_id: id }).whereNull('cancel_requested_at'),
      s,
    ).update({
      cancel_requested_at: at,
      cancel_reason: reason,
      cancel_requested_by: requestedBy,
      updated_at: toMysqlDateTime(this.now()),
    });

    if (n) {
      return this.requireById(id, s);
    }

    const current = await this.getById(id, s);
    if (!current) {
      throw new NotFoundError('Run not found', {
        resource: 'runs',
        id: runId,
      });
    }
    // Already had intent — idempotent return of current row.
    return current;
  }
}

/** Re-export terminal set for callers that only depend on the repository module. */
export { TERMINAL_RUN_STATUSES, NON_TERMINAL_RUN_STATUSES };
