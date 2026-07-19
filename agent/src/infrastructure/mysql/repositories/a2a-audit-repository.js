/**
 * A2A audit event repository (plan §20.8).
 *
 * Append-only. Correlates external task id, internal run id, client, and trace.
 * Payloads are redacted and size-bounded.
 */

import { toMysqlDateTime, parseJsonColumn, formatDateTime } from '../row-mappers.js';
import { assertUlid } from '../../../domain/shared/ulid.js';
import { redactPayload } from '../../pi/platform-event-projector.js';

const EVENT_TYPE_MAX = 128;
const METHOD_MAX = 128;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const TRACE_ID_RE = /^[0-9a-f]{32}$/i;

/**
 * @param {Record<string, unknown>} row
 */
export function mapA2aAuditEvent(row) {
  return {
    auditId: String(row.audit_id),
    orgId: String(row.org_id),
    clientId: String(row.client_id),
    credentialId:
      row.credential_id == null ? null : String(row.credential_id),
    agentId: row.agent_id == null ? null : String(row.agent_id),
    a2aTaskId: row.a2a_task_id == null ? null : String(row.a2a_task_id),
    runId: row.run_id == null ? null : String(row.run_id),
    traceId: row.trace_id == null ? null : String(row.trace_id),
    eventType: String(row.event_type),
    method: row.method == null ? null : String(row.method),
    payloadJson:
      row.payload_json == null ? null : parseJsonColumn(row.payload_json),
    createdAt: formatDateTime(row.created_at),
  };
}

/**
 * @param {unknown} payload
 * @returns {string | null}
 */
function boundPayload(payload) {
  if (payload == null) return null;
  const redacted = redactPayload(payload);
  const raw = JSON.stringify(redacted ?? null);
  if (Buffer.byteLength(raw, 'utf8') > MAX_PAYLOAD_BYTES) {
    return JSON.stringify({
      truncated: true,
      reason: 'payload_exceeds_max',
    });
  }
  return raw;
}

export class A2aAuditRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   * @param {{ now?: () => Date }} [opts]
   */
  constructor(db, opts = {}) {
    if (!db) throw new Error('A2aAuditRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * @param {{
   *   auditId: string,
   *   orgId: string,
   *   clientId: string,
   *   eventType: string,
   *   credentialId?: string | null,
   *   agentId?: string | null,
   *   a2aTaskId?: string | null,
   *   runId?: string | null,
   *   traceId?: string | null,
   *   method?: string | null,
   *   payloadJson?: unknown,
   * }} input
   */
  async append(input) {
    const auditId = assertUlid(input.auditId, 'auditId');
    const orgId = assertUlid(input.orgId, 'orgId');
    if (typeof input.clientId !== 'string' || !input.clientId.trim()) {
      throw new Error('clientId is required');
    }
    if (typeof input.eventType !== 'string' || !input.eventType.trim()) {
      throw new Error('eventType is required');
    }
    const eventType = input.eventType.trim().slice(0, EVENT_TYPE_MAX);
    let method = null;
    if (input.method != null && String(input.method).trim()) {
      method = String(input.method).trim().slice(0, METHOD_MAX);
    }
    let traceId = null;
    if (input.traceId != null && String(input.traceId).trim()) {
      const t = String(input.traceId).trim().toLowerCase();
      if (TRACE_ID_RE.test(t) && !/^0+$/.test(t)) {
        traceId = t;
      }
    }
    const optUlid = (v, field) =>
      v != null && String(v).trim() ? assertUlid(v, field) : null;

    await this.db('a2a_audit_events').insert({
      audit_id: auditId,
      org_id: orgId,
      client_id: input.clientId.trim(),
      credential_id: optUlid(input.credentialId, 'credentialId'),
      agent_id: optUlid(input.agentId, 'agentId'),
      a2a_task_id: optUlid(input.a2aTaskId, 'a2aTaskId'),
      run_id: optUlid(input.runId, 'runId'),
      trace_id: traceId,
      event_type: eventType,
      method,
      payload_json: boundPayload(input.payloadJson),
      created_at: toMysqlDateTime(this.now()),
    });

    return {
      auditId,
      orgId,
      clientId: input.clientId.trim(),
      eventType,
      method,
      traceId,
    };
  }

  /**
   * Organization-wide enumeration is reserved for the internal admin API.
   *
   * @param {string} orgId
   * @param {{ agentId?: string | null, limit?: number }} [opts]
   */
  async listForOrgAdmin(orgId, opts = {}) {
    const oid = assertUlid(orgId, 'orgId');
    const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
    let query = this.db('a2a_audit_events')
      .where({ org_id: oid })
      .orderBy('created_at', 'desc');
    if (opts.agentId) {
      query = query.andWhere({
        agent_id: assertUlid(opts.agentId, 'agentId'),
      });
    }
    const rows = await query.limit(limit);
    return rows.map(mapA2aAuditEvent);
  }
}
