/**
 * Append-only Message repository (plan §8.7).
 *
 * Public API intentionally has no update/replace/delete-content methods.
 * Sequence allocation uses a conversation-scoped counter via FOR UPDATE on the
 * conversation row + unique (conversation_id, sequence_no) — not SELECT MAX+1
 * without locking (and not the forbidden unguarded MAX+1 pattern of §8.11).
 */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { mapMessage, toMysqlDateTime } from '../row-mappers.js';
import { ConflictError, NotFoundError } from '../errors.js';

export class MessageRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   */
  constructor(db) {
    if (!db) throw new Error('MessageRepository requires a knex executor');
    this.db = db;
  }

  /**
   * Append a single message. Ownership is enforced via conversations.org_id/user_id.
   *
   * @param {{
   *   messageId: string,
   *   conversationId: string,
   *   orgId: string,
   *   userId: string,
   *   agentSessionId?: string | null,
   *   runId?: string | null,
   *   role: string,
   *   messageType: string,
   *   contentJson: Record<string, unknown>,
   *   sequenceNo?: number,
   *   piEntryId?: string | null,
   *   piEntryKind?: string | null,
   *   createdAt?: Date | string,
   * }} input
   */
  async append(input) {
    const scope = requireOwnerScope(input);
    const runInTxn = async (trx) => {
      const conv = await applyOwnerScope(
        trx('conversations').where({
          conversation_id: input.conversationId,
        }),
        scope,
      )
        .forUpdate()
        .first();
      if (!conv) {
        throw new NotFoundError('Conversation not found for message append', {
          resource: 'conversations',
          id: input.conversationId,
        });
      }

      let sequenceNo = input.sequenceNo;
      if (sequenceNo == null) {
        // Locked parent row: max under lock is safe; preferred vs unguarded MAX+1.
        const agg = await trx('messages')
          .where({ conversation_id: input.conversationId })
          .max('sequence_no as max_seq')
          .first();
        const maxSeq = agg?.max_seq == null ? 0 : Number(agg.max_seq);
        sequenceNo = maxSeq + 1;
      }

      try {
        await trx('messages').insert({
          message_id: input.messageId,
          conversation_id: input.conversationId,
          agent_session_id: input.agentSessionId ?? null,
          run_id: input.runId ?? null,
          role: input.role,
          message_type: input.messageType,
          content_json: JSON.stringify(input.contentJson ?? {}),
          sequence_no: sequenceNo,
          // Optional Pi journal markers (PR-05 slice B); null for ordinary messages.
          pi_entry_id:
            input.piEntryId == null || input.piEntryId === ''
              ? null
              : String(input.piEntryId),
          pi_entry_kind:
            input.piEntryKind == null || input.piEntryKind === ''
              ? null
              : String(input.piEntryKind),
          created_at: toMysqlDateTime(input.createdAt || new Date()),
        });
      } catch (err) {
        const code = /** @type {{ code?: string }} */ (err)?.code;
        if (code === 'ER_DUP_ENTRY') {
          throw new ConflictError('Message sequence or id conflict', {
            resource: 'messages',
            id: input.messageId,
          });
        }
        throw err;
      }

      await applyOwnerScope(
        trx('conversations').where({
          conversation_id: input.conversationId,
        }),
        scope,
      ).update({ updated_at: toMysqlDateTime(new Date()) });

      const row = await trx('messages')
        .where({ message_id: input.messageId })
        .first();
      return mapMessage(row);
    };

    // knex.Transaction sets isTransaction; avoid nested savepoints when already in a trx.
    if (this.db.isTransaction === true) {
      return runInTxn(this.db);
    }
    if (typeof this.db.transaction !== 'function') {
      throw new Error(
        'MessageRepository.append requires knex.transaction() or a transaction executor',
      );
    }
    return this.db.transaction(runInTxn);
  }

  /**
   * List messages for an owned conversation (append-only read).
   *
   * @param {string} conversationId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ afterSequence?: number, limit?: number }} [opts]
   */
  async listByConversation(conversationId, scope, opts = {}) {
    const s = requireOwnerScope(scope);
    const conv = await applyOwnerScope(
      this.db('conversations').where({ conversation_id: conversationId }),
      s,
    ).first();
    if (!conv) {
      throw new NotFoundError('Conversation not found', {
        resource: 'conversations',
        id: conversationId,
      });
    }

    const after = opts.afterSequence ?? 0;
    const limit = opts.limit ?? 200;
    const rows = await this.db('messages')
      .where({ conversation_id: conversationId })
      .andWhere('sequence_no', '>', after)
      .orderBy('sequence_no', 'asc')
      .limit(limit);
    return rows.map(mapMessage);
  }

  /**
   * @param {string} messageId
   * @param {{ orgId: string, userId: string }} scope
   */
  async getById(messageId, scope) {
    const s = requireOwnerScope(scope);
    const row = await this.db('messages as m')
      .join('conversations as c', 'c.conversation_id', 'm.conversation_id')
      .where('m.message_id', messageId)
      .andWhere('c.org_id', s.orgId)
      .andWhere('c.user_id', s.userId)
      .select('m.*')
      .first();
    return row ? mapMessage(row) : null;
  }
}

// Explicitly no updateMessages / replaceAll / updateContent exports.
Object.freeze(MessageRepository.prototype);
