/**
 * Append-only RunEvent repository (plan §8.11).
 *
 * Sequence allocation (same transaction):
 *   UPDATE runs
 *   SET next_event_sequence = LAST_INSERT_ID(next_event_sequence + 1)
 *   WHERE run_id = ? AND org_id = ? AND user_id = ?;
 *   SELECT LAST_INSERT_ID();
 *   INSERT INTO run_events (... sequence_no ...);
 *
 * Forbidden: SELECT MAX(sequence_no) + 1 without the runs counter.
 */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { mapRunEvent, toMysqlDateTime } from '../row-mappers.js';
import {
  ConflictError,
  NotFoundError,
  SequenceAllocationError,
} from '../errors.js';

/**
 * Parse LAST_INSERT_ID() from mysql2/knex raw result shapes.
 * @param {unknown} rawResult
 * @returns {number}
 */
export function parseLastInsertId(rawResult) {
  // knex mysql2: [rows, fields] or rows depending on version
  const rows = Array.isArray(rawResult)
    ? Array.isArray(rawResult[0])
      ? rawResult[0]
      : rawResult
    : rawResult;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new SequenceAllocationError('LAST_INSERT_ID() returned no rows');
  }
  const row = rows[0];
  const value =
    row?.seq ??
    row?.['LAST_INSERT_ID()'] ??
    row?.last_insert_id ??
    (row && typeof row === 'object' ? Object.values(row)[0] : null);
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new SequenceAllocationError(
      `Invalid LAST_INSERT_ID sequence: ${String(value)}`,
    );
  }
  return n;
}

export class RunEventRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   */
  constructor(db) {
    if (!db) throw new Error('RunEventRepository requires a knex executor');
    this.db = db;
  }

  /**
   * Append one event using runs.next_event_sequence counter (no MAX+1).
   *
   * @param {{
   *   eventId: string,
   *   runId: string,
   *   orgId: string,
   *   userId: string,
   *   eventType: string,
   *   eventVersion?: number,
   *   payloadJson?: Record<string, unknown>,
   *   traceId: string,
   *   spanId?: string | null,
   *   createdAt?: Date | string,
   * }} input
   */
  async append(input) {
    const scope = requireOwnerScope(input);

    const work = async (trx) => {
      // Ownership + existence: lock the run row for concurrent appends.
      const run = await applyOwnerScope(
        trx('runs').where({ run_id: input.runId }),
        scope,
      )
        .forUpdate()
        .first();
      if (!run) {
        throw new NotFoundError('Run not found for event append', {
          resource: 'runs',
          id: input.runId,
        });
      }

      const updateResult = await trx.raw(
        'UPDATE runs SET next_event_sequence = LAST_INSERT_ID(next_event_sequence + 1), updated_at = ? WHERE run_id = ? AND org_id = ? AND user_id = ?',
        [
          toMysqlDateTime(new Date()),
          input.runId,
          scope.orgId,
          scope.userId,
        ],
      );

      // mysql2: ResultSetHeader in updateResult[0]
      const header = Array.isArray(updateResult) ? updateResult[0] : updateResult;
      const affected =
        header?.affectedRows ?? header?.affected_rows ?? header?.rowCount ?? 0;
      if (!affected) {
        throw new SequenceAllocationError(
          'Failed to allocate run event sequence (no rows updated)',
          { runId: input.runId },
        );
      }

      const idResult = await trx.raw('SELECT LAST_INSERT_ID() AS seq');
      const sequenceNo = parseLastInsertId(idResult);

      try {
        await trx('run_events').insert({
          event_id: input.eventId,
          run_id: input.runId,
          org_id: scope.orgId,
          sequence_no: sequenceNo,
          event_type: input.eventType,
          event_version: input.eventVersion ?? 1,
          payload_json: JSON.stringify(input.payloadJson ?? {}),
          trace_id: input.traceId,
          span_id: input.spanId ?? null,
          created_at: toMysqlDateTime(input.createdAt || new Date()),
        });
      } catch (err) {
        const code = /** @type {{ code?: string }} */ (err)?.code;
        if (code === 'ER_DUP_ENTRY') {
          throw new ConflictError('Run event id or sequence conflict', {
            resource: 'run_events',
            id: input.eventId,
          });
        }
        throw err;
      }

      const row = await trx('run_events').where({ event_id: input.eventId }).first();
      return mapRunEvent(row);
    };

    if (this.db.isTransaction === true) {
      return work(this.db);
    }
    if (typeof this.db.transaction !== 'function') {
      throw new Error(
        'RunEventRepository.append requires knex.transaction() or a transaction executor',
      );
    }
    return this.db.transaction(work);
  }

  /**
   * List events for an owned run.
   *
   * @param {string} runId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ afterSequence?: number, limit?: number }} [opts]
   */
  async listByRun(runId, scope, opts = {}) {
    const s = requireOwnerScope(scope);
    const run = await applyOwnerScope(
      this.db('runs').where({ run_id: runId }),
      s,
    ).first();
    if (!run) {
      throw new NotFoundError('Run not found', {
        resource: 'runs',
        id: runId,
      });
    }

    const after = opts.afterSequence ?? 0;
    const limit = opts.limit ?? 500;
    const rows = await this.db('run_events')
      .where({ run_id: runId, org_id: s.orgId })
      .andWhere('sequence_no', '>', after)
      .orderBy('sequence_no', 'asc')
      .limit(limit);
    return rows.map(mapRunEvent);
  }

  /**
   * @param {string} eventId
   * @param {{ orgId: string, userId: string }} scope
   */
  async getById(eventId, scope) {
    const s = requireOwnerScope(scope);
    const row = await this.db('run_events as e')
      .join('runs as r', 'r.run_id', 'e.run_id')
      .where('e.event_id', eventId)
      .andWhere('r.org_id', s.orgId)
      .andWhere('r.user_id', s.userId)
      .select('e.*')
      .first();
    return row ? mapRunEvent(row) : null;
  }
}

Object.freeze(RunEventRepository.prototype);
