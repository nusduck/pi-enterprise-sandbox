/**
 * Pi Session Journal repository (PR-05 slice B).
 *
 * Long-term recovery source: full Pi JSONL header + SessionEntry payloads
 * stored as append-only rows in `messages` (plan §8.7 + §12.5).
 *
 * Snapshots are acceleration only. This repository never mutates
 * agent.state.messages and never stores auth/provider secrets outside actual
 * model message content that already existed in the Pi entry.
 *
 * - Owner-scoped via conversation.org_id / user_id
 * - Exact agent_session_id scope
 * - Append-only; duplicate pi_entry_id is idempotent when payload hash matches
 * - Pagination by sequence without a hard 200-row default truncation
 */

import { createHash } from 'node:crypto';
import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { mapMessage, toMysqlDateTime } from '../row-mappers.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { assertUlid } from '../../../domain/shared/ulid.js';
import { SessionJournalError } from '../../../domain/session/errors.js';
import {
  canonicalizeForJsonl,
  serializeJsonlLine,
  PI_JSONL_ENTRY_TYPE_SET,
  PI_SESSION_JSONL_VERSION,
} from '../../pi/pi-jsonl-codec.js';

/** Message role for journal channel rows. */
export const JOURNAL_MESSAGE_ROLE = 'system';

/** message_type values for journal rows. */
export const JOURNAL_MESSAGE_TYPE = Object.freeze({
  HEADER: 'pi_journal_header',
  ENTRY: 'pi_journal_entry',
});

/** Stable pi_entry_id for the session header row (header.id also stored in payload). */
export const JOURNAL_HEADER_ENTRY_ID = '__pi_session_header__';

/** pi_entry_kind for the session header. */
export const JOURNAL_HEADER_KIND = 'session';

/** Default page size for journal reads (not a hard truncation of full rebuild). */
export const JOURNAL_DEFAULT_PAGE_SIZE = 500;

/** Hard ceiling for a single page to protect memory. */
export const JOURNAL_MAX_PAGE_SIZE = 2000;

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
 * Deterministic SHA-256 of a JSON-compatible journal payload.
 * @param {unknown} payload
 * @returns {string}
 */
export function hashJournalPayload(payload) {
  const line = serializeJsonlLine(payload);
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isDuplicateKeyError(err) {
  const code = /** @type {{ code?: string, errno?: number }} */ (err)?.code;
  const errno = /** @type {{ errno?: number }} */ (err)?.errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}

/**
 * @param {unknown} entry
 * @returns {Record<string, unknown>}
 */
export function assertJournalEntryShape(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new SessionJournalError('journal entry must be an object', {
      code: 'JOURNAL_ENTRY_INVALID',
    });
  }
  const e = /** @type {Record<string, unknown>} */ (entry);
  if (typeof e.type !== 'string' || !e.type.trim()) {
    throw new SessionJournalError('journal entry.type is required', {
      code: 'JOURNAL_ENTRY_INVALID',
    });
  }
  if (e.type === 'session') {
    // Header shape reused as entry for storage — allow when kind is header.
  } else if (!PI_JSONL_ENTRY_TYPE_SET.has(e.type)) {
    throw new SessionJournalError(
      `unsupported journal entry type: ${String(e.type)}`,
      { code: 'JOURNAL_ENTRY_INVALID' },
    );
  }
  if (typeof e.id !== 'string' || !e.id.trim()) {
    throw new SessionJournalError('journal entry.id is required', {
      code: 'JOURNAL_ENTRY_INVALID',
      piEntryId: e.id == null ? null : String(e.id),
    });
  }
  if (typeof e.timestamp !== 'string' || !e.timestamp.trim()) {
    throw new SessionJournalError('journal entry.timestamp is required', {
      code: 'JOURNAL_ENTRY_INVALID',
      piEntryId: String(e.id),
    });
  }
  if (!Object.prototype.hasOwnProperty.call(e, 'parentId')) {
    throw new SessionJournalError(
      'journal entry.parentId is required (own property)',
      {
        code: 'JOURNAL_ENTRY_INVALID',
        piEntryId: String(e.id),
      },
    );
  }
  // Preserve full toolCall / toolResult / compaction / branch / custom — no stripping.
  return /** @type {Record<string, unknown>} */ (
    canonicalizeForJsonl(e)
  );
}

/**
 * @param {unknown} header
 * @returns {Record<string, unknown>}
 */
export function assertJournalHeaderShape(header) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new SessionJournalError('journal header must be an object', {
      code: 'JOURNAL_HEADER_INVALID',
    });
  }
  const h = /** @type {Record<string, unknown>} */ (header);
  if (h.type !== 'session') {
    throw new SessionJournalError('journal header.type must be "session"', {
      code: 'JOURNAL_HEADER_INVALID',
    });
  }
  if (Number(h.version) !== PI_SESSION_JSONL_VERSION) {
    throw new SessionJournalError(
      `journal header.version must be ${PI_SESSION_JSONL_VERSION}`,
      { code: 'JOURNAL_HEADER_INVALID' },
    );
  }
  if (typeof h.id !== 'string' || !h.id.trim()) {
    throw new SessionJournalError('journal header.id is required', {
      code: 'JOURNAL_HEADER_INVALID',
    });
  }
  if (typeof h.timestamp !== 'string' || !h.timestamp.trim()) {
    throw new SessionJournalError('journal header.timestamp is required', {
      code: 'JOURNAL_HEADER_INVALID',
    });
  }
  if (typeof h.cwd !== 'string') {
    throw new SessionJournalError('journal header.cwd must be a string', {
      code: 'JOURNAL_HEADER_INVALID',
    });
  }
  return /** @type {Record<string, unknown>} */ (canonicalizeForJsonl(h));
}

/**
 * Extract logical payload from a mapped journal message row.
 *
 * Never trusts content_json.payloadHash as authority: always recomputes from
 * the actual header/entry payload. If a stored payloadHash exists and differs,
 * fails closed with JOURNAL_HASH_MISMATCH.
 *
 * @param {ReturnType<typeof mapMessage>} msg
 * @returns {{ kind: 'header'|'entry', payload: object, payloadHash: string }}
 */
export function unwrapJournalContent(msg) {
  const c = msg.contentJson || {};
  if (msg.messageType === JOURNAL_MESSAGE_TYPE.HEADER || c.kind === 'pi_journal_header') {
    const header = c.header ?? c.payload;
    if (!header || typeof header !== 'object') {
      throw new SessionJournalError('journal header payload missing', {
        code: 'JOURNAL_ENTRY_INVALID',
        piEntryId: msg.piEntryId,
      });
    }
    const recomputed = hashJournalPayload(header);
    if (typeof c.payloadHash === 'string' && c.payloadHash.length > 0) {
      if (c.payloadHash.toLowerCase() !== recomputed.toLowerCase()) {
        throw new SessionJournalError(
          `stored journal payloadHash does not match recomputed header hash (pi_entry_id=${String(msg.piEntryId || '')}, stored=${c.payloadHash}, recomputed=${recomputed})`,
          {
            code: 'JOURNAL_HASH_MISMATCH',
            agentSessionId: msg.agentSessionId ?? undefined,
            piEntryId: msg.piEntryId,
          },
        );
      }
    }
    return {
      kind: 'header',
      payload: /** @type {object} */ (header),
      payloadHash: recomputed,
    };
  }
  const entry = c.entry ?? c.payload;
  if (!entry || typeof entry !== 'object') {
    throw new SessionJournalError('journal entry payload missing', {
      code: 'JOURNAL_ENTRY_INVALID',
      piEntryId: msg.piEntryId,
    });
  }
  const recomputed = hashJournalPayload(entry);
  if (typeof c.payloadHash === 'string' && c.payloadHash.length > 0) {
    if (c.payloadHash.toLowerCase() !== recomputed.toLowerCase()) {
      throw new SessionJournalError(
        `stored journal payloadHash does not match recomputed entry hash (pi_entry_id=${String(msg.piEntryId || '')}, stored=${c.payloadHash}, recomputed=${recomputed})`,
        {
          code: 'JOURNAL_HASH_MISMATCH',
          agentSessionId: msg.agentSessionId ?? undefined,
          piEntryId: msg.piEntryId,
        },
      );
    }
  }
  return {
    kind: 'entry',
    payload: /** @type {object} */ (entry),
    payloadHash: recomputed,
  };
}

export class PiSessionJournalRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   * @param {{ now?: () => Date, generateId?: () => string }} [opts]
   */
  constructor(db, opts = {}) {
    if (!db) {
      throw new Error('PiSessionJournalRepository requires a knex executor');
    }
    this.db = db;
    this.now = opts.now ?? (() => new Date());
    this.generateId = opts.generateId ?? null;
  }

  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  async #requireOwnedSession(db, agentSessionId, scope, opts = {}) {
    const s = requireOwnerUlids(scope);
    const id = assertUlid(agentSessionId, 'agentSessionId');
    let q = applyOwnerScope(
      db('agent_sessions').where({ agent_session_id: id }),
      s,
    );
    if (opts.forUpdate) q = q.forUpdate();
    const row = await q.first();
    if (!row) {
      throw new NotFoundError('Agent session not found', {
        resource: 'agent_sessions',
        id,
      });
    }
    return {
      agentSessionId: id,
      orgId: s.orgId,
      userId: s.userId,
      conversationId: String(row.conversation_id),
      status: String(row.status),
    };
  }

  /**
   * @param {import('knex').Knex.Transaction | import('knex').Knex} trx
   * @param {string} conversationId
   * @param {{ orgId: string, userId: string }} scope
   */
  async #allocateSequence(trx, conversationId, scope) {
    const conv = await applyOwnerScope(
      trx('conversations').where({ conversation_id: conversationId }),
      scope,
    )
      .forUpdate()
      .first();
    if (!conv) {
      throw new NotFoundError('Conversation not found for journal append', {
        resource: 'conversations',
        id: conversationId,
      });
    }
    const agg = await trx('messages')
      .where({ conversation_id: conversationId })
      .max('sequence_no as max_seq')
      .first();
    const maxSeq = agg?.max_seq == null ? 0 : Number(agg.max_seq);
    return maxSeq + 1;
  }

  /**
   * Append session header (idempotent by JOURNAL_HEADER_ENTRY_ID).
   *
   * @param {{
   *   messageId?: string,
   *   agentSessionId: string,
   *   orgId: string,
   *   userId: string,
   *   runId?: string | null,
   *   header: object,
   *   createdAt?: Date | string,
   * }} input
   */
  async appendHeader(input) {
    const header = assertJournalHeaderShape(input.header);
    return this.#appendJournalRow({
      ...input,
      piEntryId: JOURNAL_HEADER_ENTRY_ID,
      piEntryKind: JOURNAL_HEADER_KIND,
      messageType: JOURNAL_MESSAGE_TYPE.HEADER,
      contentJson: {
        kind: 'pi_journal_header',
        header,
        payloadHash: hashJournalPayload(header),
        // Never store secrets; header is only id/version/cwd/timestamp.
      },
    });
  }

  /**
   * Append one full SessionEntry (toolCall blocks, toolResult, compaction, etc.).
   *
   * @param {{
   *   messageId?: string,
   *   agentSessionId: string,
   *   orgId: string,
   *   userId: string,
   *   runId?: string | null,
   *   entry: object,
   *   createdAt?: Date | string,
   * }} input
   */
  async appendEntry(input) {
    const entry = assertJournalEntryShape(input.entry);
    const piEntryId = String(entry.id);
    const piEntryKind = String(entry.type);
    return this.#appendJournalRow({
      ...input,
      piEntryId,
      piEntryKind,
      messageType: JOURNAL_MESSAGE_TYPE.ENTRY,
      contentJson: {
        kind: 'pi_journal_entry',
        entry,
        payloadHash: hashJournalPayload(entry),
      },
    });
  }

  /**
   * Append missing entries from a full {header, entries} payload in order.
   * Header first (if not present), then each entry by id. Idempotent.
   *
   * @param {{
   *   agentSessionId: string,
   *   orgId: string,
   *   userId: string,
   *   runId?: string | null,
   *   header: object,
   *   entries: object[],
   *   generateId?: () => string,
   * }} input
   * @returns {Promise<{ appended: number, skipped: number, header: object|null, entries: object[] }>}
   */
  async appendMissingFromPayload(input) {
    const generateId = input.generateId ?? this.generateId;
    if (typeof generateId !== 'function') {
      throw new Error(
        'PiSessionJournalRepository.appendMissingFromPayload requires generateId',
      );
    }

    let appended = 0;
    let skipped = 0;

    const headerResult = await this.appendHeader({
      messageId: generateId(),
      agentSessionId: input.agentSessionId,
      orgId: input.orgId,
      userId: input.userId,
      runId: input.runId,
      header: input.header,
    });
    if (headerResult.idempotent) skipped += 1;
    else appended += 1;

    const entries = Array.isArray(input.entries) ? input.entries : [];
    for (const raw of entries) {
      const r = await this.appendEntry({
        messageId: generateId(),
        agentSessionId: input.agentSessionId,
        orgId: input.orgId,
        userId: input.userId,
        runId: input.runId,
        entry: raw,
      });
      if (r.idempotent) skipped += 1;
      else appended += 1;
    }

    return {
      appended,
      skipped,
      header: headerResult.row,
      entries: [],
    };
  }

  /**
   * @param {{
   *   messageId?: string,
   *   agentSessionId: string,
   *   orgId: string,
   *   userId: string,
   *   runId?: string | null,
   *   piEntryId: string,
   *   piEntryKind: string,
   *   messageType: string,
   *   contentJson: Record<string, unknown>,
   *   createdAt?: Date | string,
   * }} input
   */
  async #appendJournalRow(input) {
    const scope = requireOwnerUlids(input);
    const agentSessionId = assertUlid(input.agentSessionId, 'agentSessionId');
    const piEntryId = String(input.piEntryId || '').trim();
    if (!piEntryId) {
      throw new SessionJournalError('pi_entry_id is required for journal rows', {
        code: 'JOURNAL_ENTRY_INVALID',
        agentSessionId,
      });
    }
    const expectedHash = String(input.contentJson?.payloadHash || '');

    const run = async (trx) => {
      const session = await this.#requireOwnedSession(trx, agentSessionId, scope, {
        forUpdate: true,
      });

      // Idempotency: existing row with same (session, pi_entry_id)
      const existing = await trx('messages')
        .where({
          agent_session_id: agentSessionId,
          pi_entry_id: piEntryId,
        })
        .first();

      if (existing) {
        const mapped = mapMessage(existing);
        // unwrap always recomputes hash (fail closed on stored mismatch)
        const unwrapped = unwrapJournalContent(mapped);
        if (expectedHash && unwrapped.payloadHash !== expectedHash) {
          throw new SessionJournalError(
            `Journal entry id conflict: pi_entry_id=${piEntryId} exists with different payload hash`,
            {
              code: 'JOURNAL_HASH_CONFLICT',
              agentSessionId,
              piEntryId,
            },
          );
        }
        return { row: mapped, idempotent: true };
      }

      const messageId = input.messageId
        ? assertUlid(input.messageId, 'messageId')
        : (() => {
            throw new Error('messageId is required for journal append');
          })();

      const sequenceNo = await this.#allocateSequence(
        trx,
        session.conversationId,
        scope,
      );

      try {
        await trx('messages').insert({
          message_id: messageId,
          conversation_id: session.conversationId,
          agent_session_id: agentSessionId,
          run_id: input.runId ? assertUlid(input.runId, 'runId') : null,
          role: JOURNAL_MESSAGE_ROLE,
          message_type: input.messageType,
          content_json: JSON.stringify(input.contentJson ?? {}),
          sequence_no: sequenceNo,
          pi_entry_id: piEntryId,
          pi_entry_kind: String(input.piEntryKind),
          created_at: toMysqlDateTime(input.createdAt || this.now()),
        });
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          // Race: re-read and apply hash check
          const raced = await trx('messages')
            .where({
              agent_session_id: agentSessionId,
              pi_entry_id: piEntryId,
            })
            .first();
          if (raced) {
            const mapped = mapMessage(raced);
            // Race path: recompute hash, never trust stored payloadHash alone.
            const unwrapped = unwrapJournalContent(mapped);
            if (expectedHash && unwrapped.payloadHash !== expectedHash) {
              throw new SessionJournalError(
                `Journal entry id conflict: pi_entry_id=${piEntryId} exists with different payload hash`,
                {
                  code: 'JOURNAL_HASH_CONFLICT',
                  agentSessionId,
                  piEntryId,
                },
              );
            }
            return { row: mapped, idempotent: true };
          }
          throw new ConflictError('Message sequence or id conflict', {
            resource: 'messages',
            id: messageId,
          });
        }
        throw err;
      }

      await applyOwnerScope(
        trx('conversations').where({
          conversation_id: session.conversationId,
        }),
        scope,
      ).update({ updated_at: toMysqlDateTime(this.now()) });

      const row = await trx('messages').where({ message_id: messageId }).first();
      return { row: mapMessage(row), idempotent: false };
    };

    if (this.db.isTransaction === true) {
      return run(this.db);
    }
    if (typeof this.db.transaction !== 'function') {
      throw new Error(
        'PiSessionJournalRepository requires knex.transaction() or a transaction executor',
      );
    }
    return this.db.transaction(run);
  }

  /**
   * Page journal rows for a session in stable append order (sequence_no ASC).
   * Does not use the conversation list default of 200 as a hard cap for rebuild —
   * callers iterate with afterSequence until empty.
   *
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ afterSequence?: number, limit?: number }} [opts]
   */
  async listBySession(agentSessionId, scope, opts = {}) {
    const s = requireOwnerUlids(scope);
    const sid = assertUlid(agentSessionId, 'agentSessionId');
    await this.#requireOwnedSession(this.db, sid, s);

    const after = opts.afterSequence ?? 0;
    let limit = opts.limit ?? JOURNAL_DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('limit must be a positive integer');
    }
    if (limit > JOURNAL_MAX_PAGE_SIZE) limit = JOURNAL_MAX_PAGE_SIZE;

    // Only Pi journal channel rows — never UI assistant messages that share
    // pi_entry_id for idempotency (ui:assistant:…) or other non-journal markers.
    const rows = await this.db('messages')
      .where({ agent_session_id: sid })
      .whereIn('message_type', [
        JOURNAL_MESSAGE_TYPE.HEADER,
        JOURNAL_MESSAGE_TYPE.ENTRY,
      ])
      .whereNotNull('pi_entry_id')
      .andWhere('sequence_no', '>', after)
      .orderBy('sequence_no', 'asc')
      .limit(limit);

    return rows.map(mapMessage);
  }

  /**
   * Load all journal rows for a session (paginated internally — no 200 truncation).
   *
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ pageSize?: number }} [opts]
   */
  async listAllBySession(agentSessionId, scope, opts = {}) {
    const pageSize = Math.min(
      opts.pageSize ?? JOURNAL_DEFAULT_PAGE_SIZE,
      JOURNAL_MAX_PAGE_SIZE,
    );
    /** @type {ReturnType<typeof mapMessage>[]} */
    const all = [];
    let after = 0;
    for (;;) {
      const page = await this.listBySession(agentSessionId, scope, {
        afterSequence: after,
        limit: pageSize,
      });
      if (!page.length) break;
      all.push(...page);
      after = page[page.length - 1].sequenceNo;
      if (page.length < pageSize) break;
    }
    return all;
  }

  /**
   * Rebuild logical {header, entries} from journal append order.
   *
   * `digest` covers header + content entries only (excludes platform
   * `platform.session.manifest` custom rows) so a protected manifest can bind
   * that digest without self-including.
   * `fullDigest` includes every journal row (including manifests).
   *
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @returns {Promise<{ header: object | null, entries: object[], highWaterSequence: number, digest: string, fullDigest: string }>}
   */
  async loadPayload(agentSessionId, scope) {
    const rows = await this.listAllBySession(agentSessionId, scope);
    /** @type {object | null} */
    let header = null;
    /** @type {object[]} */
    const entries = [];
    let highWaterSequence = 0;
    const contentDigestParts = [];
    const fullDigestParts = [];

    for (const row of rows) {
      highWaterSequence = Math.max(highWaterSequence, row.sequenceNo);
      const unwrapped = unwrapJournalContent(row);
      const part = `${row.piEntryId}:${unwrapped.payloadHash}`;
      fullDigestParts.push(part);
      if (unwrapped.kind === 'header') {
        header = unwrapped.payload;
        contentDigestParts.push(part);
      } else {
        entries.push(unwrapped.payload);
        const isManifest =
          unwrapped.payload?.type === 'custom' &&
          unwrapped.payload?.customType === 'platform.session.manifest';
        if (!isManifest) {
          contentDigestParts.push(part);
        }
      }
    }

    const digest = createHash('sha256')
      .update(contentDigestParts.join('\n'), 'utf8')
      .digest('hex');
    const fullDigest = createHash('sha256')
      .update(fullDigestParts.join('\n'), 'utf8')
      .digest('hex');

    return { header, entries, highWaterSequence, digest, fullDigest };
  }

  /**
   * High-water sequence + digest without materializing full entry bodies twice.
   *
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   */
  async getDigest(agentSessionId, scope) {
    const loaded = await this.loadPayload(agentSessionId, scope);
    return {
      highWaterSequence: loaded.highWaterSequence,
      digest: loaded.digest,
      entryCount: loaded.entries.length,
      hasHeader: loaded.header != null,
    };
  }

  /**
   * @param {string} agentSessionId
   * @param {string} piEntryId
   * @param {{ orgId: string, userId: string }} scope
   */
  async getByEntryId(agentSessionId, piEntryId, scope) {
    const s = requireOwnerUlids(scope);
    const sid = assertUlid(agentSessionId, 'agentSessionId');
    await this.#requireOwnedSession(this.db, sid, s);
    const row = await this.db('messages')
      .where({
        agent_session_id: sid,
        pi_entry_id: String(piEntryId),
      })
      .first();
    return row ? mapMessage(row) : null;
  }
}
