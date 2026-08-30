/**
 * A2A Task repository — protocol task ↔ internal Run mapping (plan §20.4).
 *
 * Ownership is (org_id, client_id). Never returns foreign-client tasks.
 * Status is NOT stored here; callers always project from Run.
 */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { toMysqlDateTime, formatDateTime } from '../row-mappers.js';
import { ConflictError } from '../errors.js';
import { assertUlid } from '../../../domain/shared/ulid.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

/** Opaque A2A context_id max length (VARCHAR(255)). */
export const A2A_CONTEXT_ID_MAX_LEN = 255;

/**
 * @param value
 * @returns {string | null}
 */
export function normalizeOpaqueContextId(value: unknown) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (s.length > A2A_CONTEXT_ID_MAX_LEN) {
    throw new Error(
      `contextId exceeds max length ${A2A_CONTEXT_ID_MAX_LEN}`,
    );
  }
  return s;
}

export function mapA2aTask(row: Record<string, unknown>) {
  return {
    a2aTaskId: String(row.a2a_task_id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    clientId: String(row.client_id),
    agentId: String(row.agent_id),
    credentialId: String(row.credential_id),
    runId: String(row.run_id),
    conversationId: String(row.conversation_id),
    contextId: row.context_id == null ? null : String(row.context_id),
    traceId: String(row.trace_id),
    createdAt: formatDateTime(row.created_at),
    updatedAt: formatDateTime(row.updated_at),
  };
}

/**
 * Client-scoped owner for A2A (stricter than org+user alone).
 */
export type A2aClientScope = {
  orgId: string;
  clientId: string;
};

/**
 * @param scope
 * @returns {A2aClientScope}
 */
export function requireA2aClientScope(scope: Partial<A2aClientScope> | null | undefined) {
  const orgId = scope?.orgId != null ? String(scope.orgId).trim() : '';
  const clientId = scope?.clientId != null ? String(scope.clientId).trim() : '';
  if (!orgId || !clientId) {
    throw new Error('A2A client scope requires orgId and clientId');
  }
  return { orgId, clientId };
}

export function applyA2aClientScope(query: import('knex').Knex.QueryBuilder, scope: A2aClientScope) {
  const s = requireA2aClientScope(scope);
  return query.where('org_id', s.orgId).andWhere('client_id', s.clientId);
}

export class A2aTaskRepository {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  db: Loose;
  now: Loose;

  constructor(db: import('knex').Knex | import('knex').Knex.Transaction, opts: { now?: () => Date } = {}) {
    if (!db) throw new Error('A2aTaskRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Insert mapping row. Fail-closed on duplicate run_id.
   *
   * @param {{
   *   a2aTaskId: string,
   *   orgId: string,
   *   userId: string,
   *   clientId: string,
   *   agentId: string,
   *   credentialId: string,
   *   runId: string,
   *   conversationId: string,
   *   contextId?: string | null,
   *   traceId: string,
   * }} input
   */
  async insert(input: { a2aTaskId: string, orgId: string, userId: string, clientId: string, agentId: string, credentialId: string, runId: string, conversationId: string, contextId?: string | null, traceId: string, }) {
    const a2aTaskId = assertUlid(input.a2aTaskId, 'a2aTaskId');
    const orgId = assertUlid(input.orgId, 'orgId');
    const userId = assertUlid(input.userId, 'userId');
    const agentId = assertUlid(input.agentId, 'agentId');
    const credentialId = assertUlid(input.credentialId, 'credentialId');
    const runId = assertUlid(input.runId, 'runId');
    const conversationId = assertUlid(input.conversationId, 'conversationId');
    if (typeof input.clientId !== 'string' || !input.clientId.trim()) {
      throw new Error('clientId is required');
    }
    if (
      typeof input.traceId !== 'string' ||
      !/^[0-9a-f]{32}$/i.test(input.traceId)
    ) {
      throw new Error('traceId must be 32 hex chars');
    }
    // Opaque A2A context id (any non-empty string ≤ 255). Not an internal ULID.
    const contextId = normalizeOpaqueContextId(input.contextId);
    const now = toMysqlDateTime(this.now());

    try {
      await this.db('a2a_tasks').insert({
        a2a_task_id: a2aTaskId,
        org_id: orgId,
        user_id: userId,
        client_id: input.clientId.trim(),
        agent_id: agentId,
        credential_id: credentialId,
        run_id: runId,
        conversation_id: conversationId,
        context_id: contextId,
        trace_id: input.traceId.toLowerCase(),
        created_at: now,
        updated_at: now,
      });
    } catch (err) {
      const code = (err as { code?: string, errno?: number })?.code;
      const errno = (err as { errno?: number })?.errno;
      if (code === 'ER_DUP_ENTRY' || errno === 1062) {
        throw new ConflictError('A2A task mapping already exists for run');
      }
      throw err;
    }

    return this.getById(a2aTaskId, {
      orgId,
      clientId: input.clientId.trim(),
    });
  }

  /**
   * Owner+client scoped get — foreign client → null (not found).
   *
   * @param a2aTaskId
   * @param scope
   */
  async getById(a2aTaskId: string, scope: A2aClientScope) {
    const id = assertUlid(a2aTaskId, 'a2aTaskId');
    const s = requireA2aClientScope(scope);
    const row = await applyA2aClientScope(
      this.db('a2a_tasks').where({ a2a_task_id: id }),
      s,
    ).first();
    return row ? mapA2aTask(row) : null;
  }

  async getByRunId(runId: string, scope: A2aClientScope) {
    const id = assertUlid(runId, 'runId');
    const s = requireA2aClientScope(scope);
    const row = await applyA2aClientScope(
      this.db('a2a_tasks').where({ run_id: id }),
      s,
    ).first();
    return row ? mapA2aTask(row) : null;
  }

  /**
   * List tasks for one client only (never org-wide enumeration).
   *
   * @param scope
   * @param {{
   *   agentId?: string,
   *   contextId?: string | null,
   *   limit?: number,
   *   afterCreatedAt?: string,
   * }} [opts]
   */
  async listForClient(scope: A2aClientScope, opts: { agentId?: string, contextId?: string | null, limit?: number, afterCreatedAt?: string, } = {}) {
    const s = requireA2aClientScope(scope);
    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
    let q = applyA2aClientScope(this.db('a2a_tasks'), s).orderBy(
      'created_at',
      'desc',
    );
    if (opts.agentId) {
      q = q.andWhere('agent_id', assertUlid(opts.agentId, 'agentId'));
    }
    const contextId = normalizeOpaqueContextId(opts.contextId);
    if (contextId) {
      q = q.andWhere('context_id', contextId);
    }
    const rows = await q.limit(limit);
    return rows.map(mapA2aTask);
  }

  /**
   * Organization-wide enumeration is reserved for the internal admin API.
   *
   * @param orgId
   * @param [opts]
   */
  async listForOrgAdmin(orgId: string, opts: { agentId?: string | null, limit?: number } = {}) {
    const oid = assertUlid(orgId, 'orgId');
    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
    let query = this.db('a2a_tasks')
      .where({ org_id: oid })
      .orderBy('created_at', 'desc');
    if (opts.agentId) {
      query = query.andWhere({
        agent_id: assertUlid(opts.agentId, 'agentId'),
      });
    }
    const rows = await query.limit(limit);
    return rows.map(mapA2aTask);
  }

  /**
   * Unscoped by id — only for internal join after client scope already verified.
   * Prefer getById with client scope.
   *
   * @param a2aTaskId
   * @param ownerScope
   */
  async getByIdUnderOwner(a2aTaskId: string, ownerScope: { orgId: string, userId: string }) {
    const id = assertUlid(a2aTaskId, 'a2aTaskId');
    const scope = requireOwnerScope(ownerScope);
    const row = await applyOwnerScope(
      this.db('a2a_tasks').where({ a2a_task_id: id }),
      scope,
    ).first();
    return row ? mapA2aTask(row) : null;
  }
}
