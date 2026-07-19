/**
 * ApprovalRepository (plan §8.16 / PR-06 B2).
 *
 * Schema has no UNIQUE(tool_execution_id). Idempotent request under real MySQL:
 *   1) lock owned Run (org+user)
 *   2) lock owned tool_execution via owner-scoped join (serializes concurrent
 *      requestors for the same tool execution in a real transaction)
 *   3) select existing PENDING or terminal for that tool_execution_id
 *   4) insert only if none
 *
 * Fake knex does not model real row locks — offline tests must not claim true
 * concurrency; production relies on InnoDB FOR UPDATE serialization.
 *
 * One approval lifecycle per ToolExecution: return terminal existing without
 * creating another row.
 */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { mapApproval, toMysqlDateTime } from '../row-mappers.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { assertUlid } from '../../../domain/shared/ulid.js';
import {
  APPROVAL_STATUS,
  assertApprovalStatus,
  isTerminalApprovalStatus,
} from '../../../domain/tool/approval-status.js';
import { redactPayload } from '../../pi/platform-event-projector.js';
import { TOOL_EXECUTION_CHILD_SELECT } from './tool-execution-repository.js';

const MAX_REQUEST_JSON_BYTES = 64 * 1024;

/** Child-only select for owner-joined approvals (avoid Run column collisions). */
export const APPROVAL_CHILD_SELECT = Object.freeze(['a.*']);

export const APPROVAL_LIST_DEFAULT_LIMIT = 50;
export const APPROVAL_LIST_MAX_LIMIT = 200;

/**
 * @param {unknown} value
 */
function boundRequestJson(value) {
  const redacted = redactPayload(value ?? {});
  const raw = JSON.stringify(redacted ?? {});
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_JSON_BYTES) {
    throw new Error(
      `request_json exceeds max ${MAX_REQUEST_JSON_BYTES} bytes after redaction`,
    );
  }
  return raw;
}

export class ApprovalRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   * @param {{ now?: () => Date }} [opts]
   */
  constructor(db, opts = {}) {
    if (!db) throw new Error('ApprovalRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * @param {string} runId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  async requireOwnedRun(runId, scope, opts = {}) {
    const s = requireOwnerScope(scope);
    const id = assertUlid(runId, 'runId');
    let q = applyOwnerScope(this.db('runs').where({ run_id: id }), s);
    if (opts.forUpdate) q = q.forUpdate();
    const row = await q.first();
    if (!row) {
      throw new NotFoundError('Run not found for approval scope', {
        resource: 'runs',
        id,
      });
    }
    return row;
  }

  /**
   * Owner-scoped approvals join runs.
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  #ownedApprovalQuery(scope, opts = {}) {
    const s = requireOwnerScope(scope);
    let q = this.db('approvals as a')
      .join('runs as r', 'a.run_id', 'r.run_id')
      .select(...APPROVAL_CHILD_SELECT)
      .select('r.conversation_id')
      .where('r.org_id', s.orgId)
      .andWhere('r.user_id', s.userId)
      .andWhere('a.org_id', s.orgId);
    if (opts.forUpdate) q = q.forUpdate();
    return q;
  }

  /**
   * Owner-scoped tool_executions join runs (child columns only).
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  #ownedToolQuery(scope, opts = {}) {
    const s = requireOwnerScope(scope);
    let q = this.db('tool_executions as te')
      .join('runs as r', 'te.run_id', 'r.run_id')
      .select(...TOOL_EXECUTION_CHILD_SELECT)
      .where('r.org_id', s.orgId)
      .andWhere('r.user_id', s.userId);
    if (opts.forUpdate) q = q.forUpdate();
    return q;
  }

  /**
   * @param {string} approvalId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  async getById(approvalId, scope, opts = {}) {
    const s = requireOwnerScope(scope);
    const id = assertUlid(approvalId, 'approvalId');
    // Owner join first — foreign approval never selected alone.
    const row = await this.#ownedApprovalQuery(s, opts)
      .andWhere('a.approval_id', id)
      .first();
    if (!row) {
      throw new NotFoundError('Approval not found', {
        resource: 'approvals',
        id,
      });
    }
    return mapApproval(row);
  }

  /**
   * List approvals visible to an owner. The Run join is intentional: an
   * approval's org_id alone is not sufficient to prove user ownership.
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ status?: string, limit?: number }} [opts]
   */
  async listForOwner(scope, opts = {}) {
    const s = requireOwnerScope(scope);
    const rawLimit = opts.limit == null ? APPROVAL_LIST_DEFAULT_LIMIT : Number(opts.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > APPROVAL_LIST_MAX_LIMIT) {
      throw new Error(
        `limit must be an integer between 1 and ${APPROVAL_LIST_MAX_LIMIT}`,
      );
    }
    let query = this.#ownedApprovalQuery(s)
      .orderBy('a.created_at', 'desc')
      .limit(rawLimit);
    if (opts.status != null) {
      query = query.andWhere('a.status', assertApprovalStatus(String(opts.status).toUpperCase()));
    }
    const rows = await query;
    return (rows || []).map(mapApproval);
  }

  /**
   * List every approval for one owned Run in lifecycle order.
   * @param {string} runId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  async listByRunId(runId, scope, opts = {}) {
    const s = requireOwnerScope(scope);
    const id = assertUlid(runId, 'runId');
    await this.requireOwnedRun(id, s, { forUpdate: opts.forUpdate === true });
    const rows = await this.#ownedApprovalQuery(s, opts)
      .andWhere('a.run_id', id)
      .orderBy('a.created_at', 'asc');
    return (rows || []).map(mapApproval);
  }

  /**
   * @param {string} toolExecutionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  async listByToolExecutionId(toolExecutionId, scope, opts = {}) {
    const s = requireOwnerScope(scope);
    const teId = assertUlid(toolExecutionId, 'toolExecutionId');

    // Prove tool execution is owned before listing approvals.
    const te = await this.#ownedToolQuery(s, opts)
      .andWhere('te.tool_execution_id', teId)
      .first();
    if (!te) {
      throw new NotFoundError('Tool execution not found for approval', {
        resource: 'tool_executions',
        id: teId,
      });
    }

    const rows = await this.#ownedApprovalQuery(s)
      .andWhere('a.tool_execution_id', teId)
      .orderBy('a.created_at', 'asc');
    return (rows || []).map(mapApproval);
  }

  /**
   * Idempotent pending request for a tool execution.
   *
   * @param {{
   *   approvalId: string,
   *   orgId: string,
   *   userId: string,
   *   runId: string,
   *   toolExecutionId: string,
   *   requestedBy: string,
   *   requestJson: unknown,
   *   expiresAt?: Date | string | null,
   * }} input
   */
  async getOrCreatePending(input) {
    const scope = requireOwnerScope(input);
    const approvalId = assertUlid(input.approvalId, 'approvalId');
    const runId = assertUlid(input.runId, 'runId');
    const toolExecutionId = assertUlid(input.toolExecutionId, 'toolExecutionId');
    const requestedBy = assertUlid(input.requestedBy, 'requestedBy');
    const requestJson = boundRequestJson(input.requestJson);

    // 1) Lock owned run
    await this.requireOwnedRun(runId, scope, { forUpdate: true });

    // 2) Lock owned tool_execution (join) — real InnoDB serializes concurrent
    //    getOrCreatePending for the same tool execution on this lock.
    const te = await this.#ownedToolQuery(scope, { forUpdate: true })
      .andWhere('te.tool_execution_id', toolExecutionId)
      .andWhere('te.run_id', runId)
      .first();
    if (!te) {
      throw new NotFoundError('Tool execution not found for approval request', {
        resource: 'tool_executions',
        id: toolExecutionId,
      });
    }

    // 3) Existing approvals for this tool execution (owner-scoped)
    const existing = await this.#ownedApprovalQuery(scope)
      .andWhere('a.tool_execution_id', toolExecutionId)
      .orderBy('a.created_at', 'asc');

    const pending = (existing || []).find(
      (r) => String(r.status) === APPROVAL_STATUS.PENDING,
    );
    if (pending) {
      return { created: false, approval: mapApproval(pending) };
    }

    // One lifecycle: return terminal without creating another / without new event.
    const terminal = (existing || []).find((r) =>
      isTerminalApprovalStatus(String(r.status)),
    );
    if (terminal) {
      return { created: false, approval: mapApproval(terminal) };
    }

    const now = this.now();
    try {
      await this.db('approvals').insert({
        approval_id: approvalId,
        org_id: scope.orgId,
        run_id: runId,
        tool_execution_id: toolExecutionId,
        requested_by: requestedBy,
        decision_by: null,
        status: APPROVAL_STATUS.PENDING,
        request_json: requestJson,
        decision_reason: null,
        expires_at: input.expiresAt
          ? toMysqlDateTime(input.expiresAt)
          : null,
        created_at: toMysqlDateTime(now),
        decided_at: null,
      });
    } catch (err) {
      const code = /** @type {{ code?: string }} */ (err)?.code;
      if (code === 'ER_DUP_ENTRY') {
        const again = await this.getById(approvalId, scope).catch(() => null);
        if (again) return { created: false, approval: again };
      }
      throw err;
    }

    // Re-check under lock (schema gap: no UNIQUE on tool_execution_id).
    // Prefer oldest pending if multiple slipped through outside real locking.
    const after = await this.#ownedApprovalQuery(scope)
      .andWhere('a.tool_execution_id', toolExecutionId)
      .orderBy('a.created_at', 'asc');
    const pendings = (after || []).filter(
      (r) => String(r.status) === APPROVAL_STATUS.PENDING,
    );
    if (pendings.length >= 1) {
      const keep = pendings[0];
      return {
        created: String(keep.approval_id) === approvalId,
        approval: mapApproval(keep),
      };
    }

    const row = await this.getById(approvalId, scope);
    return { created: true, approval: row };
  }

  /**
   * CAS decision update (PR-09 surface).
   *
   * @param {{
   *   approvalId: string,
   *   orgId: string,
   *   userId: string,
   *   fromStatus?: string,
   *   toStatus: string,
   *   decisionBy: string,
   *   decisionReason?: string | null,
   * }} input
   */
  async decideIf(input) {
    const scope = requireOwnerScope(input);
    const id = assertUlid(input.approvalId, 'approvalId');
    const toStatus = assertApprovalStatus(input.toStatus);
    if (toStatus === APPROVAL_STATUS.PENDING) {
      throw new Error('decideIf cannot set PENDING');
    }
    const decisionBy = assertUlid(input.decisionBy, 'decisionBy');
    const fromStatus = assertApprovalStatus(
      input.fromStatus ?? APPROVAL_STATUS.PENDING,
    );

    // Owner-scoped lock first
    const current = await this.getById(id, scope, { forUpdate: true });
    if (current.status !== fromStatus) {
      if (current.status === toStatus && isTerminalApprovalStatus(toStatus)) {
        return { changed: false, approval: current };
      }
      throw new ConflictError(
        `approval CAS failed: have ${current.status}, expected ${fromStatus}`,
        { resource: 'approvals', id },
      );
    }

    const now = this.now();
    // CAS on PK after ownership verified
    const n = await this.db('approvals')
      .where({
        approval_id: id,
        org_id: scope.orgId,
        status: fromStatus,
      })
      .update({
        status: toStatus,
        decision_by: decisionBy,
        decision_reason: input.decisionReason ?? null,
        decided_at: toMysqlDateTime(now),
      });
    if (!n) {
      throw new ConflictError('approval decide CAS lost race', {
        resource: 'approvals',
        id,
      });
    }
    return { changed: true, approval: await this.getById(id, scope) };
  }
}
