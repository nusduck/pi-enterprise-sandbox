/**
 * Conversation repository — ownership-scoped (plan §8.6).
 * Messages are NOT stored here (see MessageRepository).
 */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { mapConversation, toMysqlDateTime } from '../row-mappers.js';
import { NotFoundError } from '../errors.js';
import { assertUlid } from '../../../domain/shared/ulid.js';
import { escapeLikePattern, type KeysetPosition } from '../../../application/keyset-cursor.js';

export class ConversationRepository {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  db: import('knex').Knex | import('knex').Knex.Transaction;

  constructor(db: import('knex').Knex | import('knex').Knex.Transaction) {
    if (!db) throw new Error('ConversationRepository requires a knex executor');
    this.db = db;
  }

  /**
   * @param {{
   *   conversationId: string,
   *   orgId: string,
   *   userId: string,
   *   agentId: string,
   *   parentRunId?: string | null,
   *   title?: string | null,
   *   status: string,
   *   currentAgentSessionId?: string | null,
   *   createdAt?: Date | string,
   *   updatedAt?: Date | string,
   *   archivedAt?: Date | string | null,
   * }} input
   */
  async create(input: { conversationId: string, orgId: string, userId: string, agentId: string, parentRunId?: string | null, title?: string | null, status: string, currentAgentSessionId?: string | null, createdAt?: Date | string, updatedAt?: Date | string, archivedAt?: Date | string | null, }) {
    const scope = requireOwnerScope(input);
    const now = toMysqlDateTime(input.createdAt || new Date());
    const updated = toMysqlDateTime(input.updatedAt || input.createdAt || new Date());
    await this.db('tbl_agsvc_conversations').insert({
      conversation_id: input.conversationId,
      org_id: scope.orgId,
      user_id: scope.userId,
      agent_id: input.agentId,
      parent_run_id: input.parentRunId ?? null,
      title: input.title ?? null,
      status: input.status,
      current_agent_session_id: input.currentAgentSessionId ?? null,
      created_at: now,
      updated_at: updated,
      archived_at: input.archivedAt ? toMysqlDateTime(input.archivedAt) : null,
    });
    return this.getById(input.conversationId, scope);
  }

  /**
   * Read one conversation by id, sub-agent conversations included: the list
   * hides them, this does not.
   *
   * @param conversationId
   * @param scope
   * @param [opts]
   */
  async getById(conversationId: string, scope: { orgId: string, userId: string }, opts: { forUpdate?: boolean } = {}) {
    const s = requireOwnerScope(scope);
    let q = applyOwnerScope(
      this.db('tbl_agsvc_conversations').where({ conversation_id: conversationId }),
      s,
    );
    if (opts.forUpdate) q = q.forUpdate();
    const row = await q.first();
    return row ? mapConversation(row) : null;
  }

  /**
   * Lock conversation row for parent-graph provisioning (FOR UPDATE).
   * @param conversationId
   * @param scope
   */
  async lockById(conversationId: string, scope: { orgId: string, userId: string }) {
    return this.getById(conversationId, scope, { forUpdate: true });
  }

  async requireById(conversationId: string, scope: { orgId: string, userId: string }) {
    const row = await this.getById(conversationId, scope);
    if (!row) {
      throw new NotFoundError('Conversation not found', {
        resource: 'conversations',
        id: conversationId,
      });
    }
    return row;
  }

  /**
   * Owner-scoped page of conversations, newest activity first.
   *
   * 排序是 `updated_at desc, conversation_id desc`：只按时间排序时，同一毫秒更新
   * 的两行在 keyset 翻页里会重复或漏掉（design ui-polish §2.4）。`before` 只是
   * 位置——作用域在上面的 owner 过滤里，游标带不进别人的行。
   *
   * @param scope
   * @param [opts]
   */
  async listForOwner(scope: { orgId: string, userId: string }, opts: { limit?: number, includeArchived?: boolean, includeSubagent?: boolean, before?: KeysetPosition | null, titleQuery?: string | null } = {}) {
    const s = requireOwnerScope(scope);
    const limit = opts.limit ?? 50;
    let query = applyOwnerScope(this.db('tbl_agsvc_conversations'), s);
    if (opts.includeArchived !== true) query = query.whereNull('archived_at');
    // A sub-agent's conversation belongs to the Run that spawned it, not
    // beside it in the owner's list. It stays fully readable by id — hiding it
    // here is a listing decision, never an access one.
    if (opts.includeSubagent !== true) query = query.whereNull('parent_run_id');
    if (opts.titleQuery) {
      // 用户搜 `%` 时命中「全部」不是搜索，是 LIKE 没转义（同 admin-run-read-repository）。
      query = query.andWhere('title', 'like', `%${escapeLikePattern(opts.titleQuery)}%`);
    }
    if (opts.before) {
      const at = toMysqlDateTime(opts.before.sortValue);
      const id = assertUlid(opts.before.key, 'cursor.conversationId');
      query = query.andWhere((w: import('knex').Knex.QueryBuilder) => {
        w.where('updated_at', '<', at).orWhere((w2: import('knex').Knex.QueryBuilder) => {
          w2.where('updated_at', '=', at).andWhere('conversation_id', '<', id);
        });
      });
    }
    const rows = await query
      .orderBy('updated_at', 'desc')
      .orderBy('conversation_id', 'desc')
      .limit(limit);
    return rows.map(mapConversation);
  }

  async updateMeta(conversationId: string, scope: { orgId: string, userId: string }, patch: { title?: string | null, status?: string, currentAgentSessionId?: string | null, archivedAt?: Date | string | null }) {
    const s = requireOwnerScope(scope);
    const update: Record<string, unknown> = { updated_at: toMysqlDateTime(new Date()) };
    if (patch.title !== undefined) update.title = patch.title;
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.currentAgentSessionId !== undefined) {
      update.current_agent_session_id = patch.currentAgentSessionId;
    }
    if (patch.archivedAt !== undefined) {
      update.archived_at = patch.archivedAt
        ? toMysqlDateTime(patch.archivedAt)
        : null;
    }
    const n = await applyOwnerScope(
      this.db('tbl_agsvc_conversations').where({ conversation_id: conversationId }),
      s,
    ).update(update);
    if (!n) {
      throw new NotFoundError('Conversation not found', {
        resource: 'conversations',
        id: conversationId,
      });
    }
    return this.requireById(conversationId, s);
  }

  /**
   * Soft-delete while preserving referenced sessions/messages/runs.
   * @param conversationId
   * @param scope
   * @param archivedAt
   */
  async archive(conversationId: string, scope: { orgId: string, userId: string }, archivedAt: Date | string = new Date()) {
    return this.updateMeta(conversationId, scope, {
      status: 'archived',
      archivedAt,
    });
  }
}
