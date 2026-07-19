/**
 * Conversation repository — ownership-scoped (plan §8.6).
 * Messages are NOT stored here (see MessageRepository).
 */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { mapConversation, toMysqlDateTime } from '../row-mappers.js';
import { NotFoundError } from '../errors.js';

export class ConversationRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   */
  constructor(db) {
    if (!db) throw new Error('ConversationRepository requires a knex executor');
    this.db = db;
  }

  /**
   * @param {{
   *   conversationId: string,
   *   orgId: string,
   *   userId: string,
   *   agentId: string,
   *   title?: string | null,
   *   status: string,
   *   currentAgentSessionId?: string | null,
   *   createdAt?: Date | string,
   *   updatedAt?: Date | string,
   *   archivedAt?: Date | string | null,
   * }} input
   */
  async create(input) {
    const scope = requireOwnerScope(input);
    const now = toMysqlDateTime(input.createdAt || new Date());
    const updated = toMysqlDateTime(input.updatedAt || input.createdAt || new Date());
    await this.db('conversations').insert({
      conversation_id: input.conversationId,
      org_id: scope.orgId,
      user_id: scope.userId,
      agent_id: input.agentId,
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
   * @param {string} conversationId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  async getById(conversationId, scope, opts = {}) {
    const s = requireOwnerScope(scope);
    let q = applyOwnerScope(
      this.db('conversations').where({ conversation_id: conversationId }),
      s,
    );
    if (opts.forUpdate) q = q.forUpdate();
    const row = await q.first();
    return row ? mapConversation(row) : null;
  }

  /**
   * Lock conversation row for parent-graph provisioning (FOR UPDATE).
   * @param {string} conversationId
   * @param {{ orgId: string, userId: string }} scope
   */
  async lockById(conversationId, scope) {
    return this.getById(conversationId, scope, { forUpdate: true });
  }

  /**
   * @param {string} conversationId
   * @param {{ orgId: string, userId: string }} scope
   */
  async requireById(conversationId, scope) {
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
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ limit?: number, includeArchived?: boolean }} [opts]
   */
  async listForOwner(scope, opts = {}) {
    const s = requireOwnerScope(scope);
    const limit = opts.limit ?? 50;
    let query = applyOwnerScope(this.db('conversations'), s);
    if (opts.includeArchived !== true) query = query.whereNull('archived_at');
    const rows = await query.orderBy('updated_at', 'desc').limit(limit);
    return rows.map(mapConversation);
  }

  /**
   * @param {string} conversationId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ title?: string | null, status?: string, currentAgentSessionId?: string | null, archivedAt?: Date | string | null }} patch
   */
  async updateMeta(conversationId, scope, patch) {
    const s = requireOwnerScope(scope);
    /** @type {Record<string, unknown>} */
    const update = { updated_at: toMysqlDateTime(new Date()) };
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
      this.db('conversations').where({ conversation_id: conversationId }),
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
   * @param {string} conversationId
   * @param {{ orgId: string, userId: string }} scope
   * @param {Date | string} archivedAt
   */
  async archive(conversationId, scope, archivedAt = new Date()) {
    return this.updateMeta(conversationId, scope, {
      status: 'archived',
      archivedAt,
    });
  }
}
