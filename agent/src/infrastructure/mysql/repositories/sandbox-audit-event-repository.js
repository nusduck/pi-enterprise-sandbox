/**
 * SandboxAuditEventRepository — durable policy/tool audit trail
 * mapped to sandbox_audit_events (plan schema).
 *
 * Owner-scoped (org_id + user_id). Used for policy decisions and tool
 * governance audits. Not domain_outbox.
 */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { mapSandboxAuditEvent, toMysqlDateTime } from '../row-mappers.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { assertUlid } from '../../../domain/shared/ulid.js';
import { redactPayload } from '../../pi/platform-event-projector.js';

const EVENT_TYPE_MAX = 128;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const TRACE_ID_RE = /^[0-9a-f]{32}$/i;

/**
 * @param {unknown} payload
 */
function boundPayload(payload) {
  if (payload == null) return null;
  const redacted = redactPayload(payload);
  const raw = JSON.stringify(redacted ?? null);
  if (Buffer.byteLength(raw, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `audit payload_json exceeds max ${MAX_PAYLOAD_BYTES} bytes after redaction`,
    );
  }
  return raw;
}

/**
 * @param {string} eventType
 */
function assertEventType(eventType) {
  if (typeof eventType !== 'string' || !eventType.trim()) {
    throw new Error('eventType is required');
  }
  const v = eventType.trim();
  if (v.length > EVENT_TYPE_MAX) {
    throw new Error(`eventType exceeds max length ${EVENT_TYPE_MAX}`);
  }
  return v;
}

export class SandboxAuditEventRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   * @param {{ now?: () => Date }} [opts]
   */
  constructor(db, opts = {}) {
    if (!db) {
      throw new Error('SandboxAuditEventRepository requires a knex executor');
    }
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Append one owner-scoped audit event.
   *
   * @param {{
   *   auditId: string,
   *   orgId: string,
   *   userId: string,
   *   eventType: string,
   *   sandboxSessionId?: string | null,
   *   executionId?: string | null,
   *   processId?: string | null,
   *   traceId?: string | null,
   *   payloadJson?: unknown,
   * }} input
   */
  async append(input) {
    const scope = requireOwnerScope(input);
    const auditId = assertUlid(input.auditId, 'auditId');
    const eventType = assertEventType(input.eventType);
    let traceId = null;
    if (input.traceId != null && String(input.traceId).trim()) {
      const t = String(input.traceId).trim().toLowerCase();
      if (!TRACE_ID_RE.test(t) || /^0+$/.test(t)) {
        throw new Error('traceId must be 32 hex chars (non-zero) when set');
      }
      traceId = t;
    }
    const sandboxSessionId =
      input.sandboxSessionId != null && String(input.sandboxSessionId).trim()
        ? assertUlid(input.sandboxSessionId, 'sandboxSessionId')
        : null;
    const executionId =
      input.executionId != null && String(input.executionId).trim()
        ? assertUlid(input.executionId, 'executionId')
        : null;
    const processId =
      input.processId != null && String(input.processId).trim()
        ? assertUlid(input.processId, 'processId')
        : null;

    const now = this.now();
    try {
      await this.db('sandbox_audit_events').insert({
        audit_id: auditId,
        org_id: scope.orgId,
        user_id: scope.userId,
        event_type: eventType,
        sandbox_session_id: sandboxSessionId,
        execution_id: executionId,
        process_id: processId,
        trace_id: traceId,
        payload_json: boundPayload(input.payloadJson),
        created_at: toMysqlDateTime(now),
      });
    } catch (err) {
      const code = /** @type {{ code?: string }} */ (err)?.code;
      if (code === 'ER_DUP_ENTRY') {
        throw new ConflictError('audit event id conflict', {
          resource: 'sandbox_audit_events',
          id: auditId,
        });
      }
      throw err;
    }

    const row = await applyOwnerScope(
      this.db('sandbox_audit_events').where({ audit_id: auditId }),
      scope,
    ).first();
    if (!row) {
      throw new NotFoundError('Audit event missing after insert', {
        resource: 'sandbox_audit_events',
        id: auditId,
      });
    }
    return mapSandboxAuditEvent(row);
  }

  /**
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ eventType?: string, limit?: number, afterCreatedAt?: string }} [opts]
   */
  async listByOwner(scope, opts = {}) {
    const s = requireOwnerScope(scope);
    let q = applyOwnerScope(this.db('sandbox_audit_events'), s).orderBy(
      'created_at',
      'asc',
    );
    if (opts.eventType) {
      q = q.andWhere({ event_type: assertEventType(opts.eventType) });
    }
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
    q = q.limit(limit);
    const rows = await q;
    return (rows || []).map(mapSandboxAuditEvent);
  }
}
