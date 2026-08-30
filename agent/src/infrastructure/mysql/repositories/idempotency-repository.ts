/**
 * IdempotencyRepository (plan §8.18).
 *
 * Scope: owner (org_id + user_id) + idempotency_key + operation.
 * Concurrent begin is safe via unique primary key: on ER_DUP_ENTRY reload and
 * compare request_hash (never return another tenant's row).
 *
 * Expired replacement is CAS-safe:
 *   UPDATE … WHERE expires_at <= now AND request_hash = observed
 *     AND created_at = observed
 * If CAS loses, reload and apply normal non-expired semantics (same hash →
 * in_progress/replay; different hash → ConflictError). Two concurrent different
 * hashes can never both return begun.
 *
 * complete() only writes when response_status IS NULL (and non-expired); an
 * already-completed row is returned unchanged (never overwritten).
 */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { toMysqlDateTime, parseJsonColumn, formatDateTime } from '../row-mappers.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { assertUlid } from '../../../domain/shared/ulid.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

/** plan §8.18 column bounds */
export const IDEMPOTENCY_KEY_MAX_LEN = 255;
export const IDEMPOTENCY_OPERATION_MAX_LEN = 128;
export const IDEMPOTENCY_REQUEST_HASH_LEN = 64;

export type IdempotencyRecord = {
  orgId: string;
  userId: string;
  idempotencyKey: string;
  operation: string;
  requestHash: string;
  responseStatus: number | null;
  responseJson: Record<string, unknown> | null;
  resourceId: string | null;
  expiresAt: string | null;
  createdAt: string | null;
};

/**
 * @param row
 * @returns {IdempotencyRecord}
 */
export function mapIdempotencyRecord(row: Record<string, unknown>) {
  return {
    orgId: String(row.org_id),
    userId: String(row.user_id),
    idempotencyKey: String(row.idempotency_key),
    operation: String(row.operation),
    requestHash: String(row.request_hash),
    responseStatus:
      row.response_status == null ? null : Number(row.response_status),
    responseJson:
      row.response_json == null ? null : parseJsonColumn(row.response_json),
    resourceId: row.resource_id == null ? null : String(row.resource_id),
    expiresAt: formatDateTime(row.expires_at),
    createdAt: formatDateTime(row.created_at),
  };
}

function requireBoundedString(value: string, field: string, maxLen: number) {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a non-empty string`);
  }
  const v = value.trim();
  if (!v) throw new Error(`${field} must be a non-empty string`);
  if (v.length > maxLen) {
    throw new Error(`${field} exceeds max length ${maxLen}`);
  }
  return v;
}

function requireRequestHash(hash: string) {
  const h = requireBoundedString(hash, 'requestHash', IDEMPOTENCY_REQUEST_HASH_LEN);
  if (h.length !== IDEMPOTENCY_REQUEST_HASH_LEN) {
    throw new Error(
      `requestHash must be exactly ${IDEMPOTENCY_REQUEST_HASH_LEN} characters`,
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(h)) {
    throw new Error('requestHash must be 64 hex characters');
  }
  return h.toLowerCase();
}

/**
 * @param err
 * @returns {boolean}
 */
function isDuplicateKeyError(err: unknown) {
  const code = (err as { code?: string, errno?: number })?.code;
  const errno = (err as { errno?: number })?.errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}

export class IdempotencyRepository {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  db: Loose;
  now: Loose;

  constructor(db: import('knex').Knex | import('knex').Knex.Transaction, opts: { now?: () => Date } = {}) {
    if (!db) throw new Error('IdempotencyRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  #validateKeyParts(key: { orgId: string, userId: string, idempotencyKey: string, operation: string }) {
    const scopeRaw = requireOwnerScope(key);
    const scope = {
      orgId: assertUlid(scopeRaw.orgId, 'orgId'),
      userId: assertUlid(scopeRaw.userId, 'userId'),
    };
    const idempotencyKey = requireBoundedString(
      key.idempotencyKey,
      'idempotencyKey',
      IDEMPOTENCY_KEY_MAX_LEN,
    );
    const operation = requireBoundedString(
      key.operation,
      'operation',
      IDEMPOTENCY_OPERATION_MAX_LEN,
    );
    return { scope, idempotencyKey, operation };
  }

  /**
   * Owner-scoped load. Never returns a row for another tenant.
   * @param key
   * @param [opts]
   * @returns {Promise<IdempotencyRecord | null>}
   */
  async get(key: { orgId: string, userId: string, idempotencyKey: string, operation: string }, opts: { forUpdate?: boolean } = {}) {
    const { scope, idempotencyKey, operation } = this.#validateKeyParts(key);
    let query = applyOwnerScope(this.db('idempotency_records'), scope)
      .where({
        idempotency_key: idempotencyKey,
        operation,
      });
    if (opts.forUpdate) query = query.forUpdate();
    const row = await query.first();
    return row ? mapIdempotencyRecord(row) : null;
  }

  isExpired(record: IdempotencyRecord, now: Date = this.now()) {
    if (!record.expiresAt) return true;
    return new Date(record.expiresAt).getTime() <= now.getTime();
  }

  isComplete(record: IdempotencyRecord) {
    return record.responseStatus != null;
  }

  /**
   * Non-expired observe path: hash compare → replay / in_progress / conflict.
   * @param existing
   * @param requestHash
   * @param id
   */
  #resolveNonExpired(existing: IdempotencyRecord, requestHash: string, id: { orgId: string, userId: string, idempotencyKey: string, operation: string }) {
    if (existing.requestHash !== requestHash) {
      throw new ConflictError(
        'Idempotency key reused with a different request hash',
        {
          resource: 'idempotency_records',
          id: `${id.orgId}/${id.idempotencyKey}/${id.operation}`,
        },
      );
    }
    if (this.isComplete(existing)) {
      return { outcome: ('replay' as const), record: existing };
    }
    return { outcome: ('in_progress' as const), record: existing };
  }

  /**
   * CAS-replace an expired row. Predicate includes expiry + observed hash +
   * observed created_at so concurrent different hashes cannot both win.
   *
   * @param existing
   * @param {{
   *   scope: { orgId: string, userId: string },
   *   idempotencyKey: string,
   *   operation: string,
   *   requestHash: string,
   *   expiresAt: string,
   *   createdAt: string,
   * }} ctx
   */
  async #tryReplaceExpired(existing: IdempotencyRecord, ctx: { scope: { orgId: string, userId: string }, idempotencyKey: string, operation: string, requestHash: string, expiresAt: string, createdAt: string, }) {
    const nowMysql = toMysqlDateTime(this.now());
    const observedHash = existing.requestHash;
    const observedCreatedAt = existing.createdAt
      ? toMysqlDateTime(existing.createdAt)
      : null;

    let q = applyOwnerScope(this.db('idempotency_records'), ctx.scope)
      .where({
        idempotency_key: ctx.idempotencyKey,
        operation: ctx.operation,
      })
      .andWhere('expires_at', '<=', nowMysql)
      .andWhere({ request_hash: observedHash });

    if (observedCreatedAt != null) {
      q = q.andWhere({ created_at: observedCreatedAt });
    }

    const n = await q.update({
      request_hash: ctx.requestHash,
      response_status: null,
      response_json: null,
      resource_id: null,
      expires_at: ctx.expiresAt,
      created_at: ctx.createdAt,
    });

    if (n) {
      const record = await this.get({
        orgId: ctx.scope.orgId,
        userId: ctx.scope.userId,
        idempotencyKey: ctx.idempotencyKey,
        operation: ctx.operation,
      });
      if (!record) {
        throw new Error('Idempotency replace succeeded but row not readable');
      }
      return { outcome: ('begun' as const), record };
    }

    // CAS lost — reload under owner scope; never assume we overwrote.
    const reloaded = await this.get(
      {
        orgId: ctx.scope.orgId,
        userId: ctx.scope.userId,
        idempotencyKey: ctx.idempotencyKey,
        operation: ctx.operation,
      },
      { forUpdate: true },
    );
    if (!reloaded) {
      throw new ConflictError('Idempotency key conflict without readable row', {
        resource: 'idempotency_records',
        id: `${ctx.scope.orgId}/${ctx.idempotencyKey}/${ctx.operation}`,
      });
    }

    if (this.isExpired(reloaded)) {
      // Still expired after losing CAS: another writer did not publish a live
      // row. Surface conflict so the caller retries rather than double-begun.
      throw new ConflictError(
        'Idempotency expired-record replace lost a concurrent race',
        {
          resource: 'idempotency_records',
          id: `${ctx.scope.orgId}/${ctx.idempotencyKey}/${ctx.operation}`,
        },
      );
    }

    return this.#resolveNonExpired(reloaded, ctx.requestHash, {
      orgId: ctx.scope.orgId,
      userId: ctx.scope.userId,
      idempotencyKey: ctx.idempotencyKey,
      operation: ctx.operation,
    });
  }

  /**
   * Begin (or observe) an idempotent operation.
   *
   * @param {{
   *   orgId: string,
   *   userId: string,
   *   idempotencyKey: string,
   *   operation: string,
   *   requestHash: string,
   *   expiresAt: Date | string,
   * }} input
   * @returns {Promise<{
   *   outcome: 'begun' | 'in_progress' | 'replay',
   *   record: IdempotencyRecord,
   * }>}
   */
  async begin(input: { orgId: string, userId: string, idempotencyKey: string, operation: string, requestHash: string, expiresAt: Date | string, }) {
    const { scope, idempotencyKey, operation } = this.#validateKeyParts(input);
    const requestHash = requireRequestHash(input.requestHash);
    if (input.expiresAt == null) {
      throw new Error('expiresAt is required');
    }
    const expiresAt = toMysqlDateTime(input.expiresAt);
    const createdAt = toMysqlDateTime(this.now());

    const insertRow = {
      org_id: scope.orgId,
      user_id: scope.userId,
      idempotency_key: idempotencyKey,
      operation,
      request_hash: requestHash,
      response_status: null,
      response_json: null,
      resource_id: null,
      expires_at: expiresAt,
      created_at: createdAt,
    };

    try {
      await this.db('idempotency_records').insert(insertRow);
      const record = await this.get({
        orgId: scope.orgId,
        userId: scope.userId,
        idempotencyKey,
        operation,
      });
      if (!record) {
        throw new Error('Idempotency insert succeeded but row not readable');
      }
      return { outcome: 'begun', record };
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }

    // Duplicate PK: reload under owner scope and compare / CAS-replace if expired.
    const existing = await this.get(
      {
        orgId: scope.orgId,
        userId: scope.userId,
        idempotencyKey,
        operation,
      },
      { forUpdate: true },
    );
    if (!existing) {
      throw new ConflictError('Idempotency key conflict without readable row', {
        resource: 'idempotency_records',
        id: `${scope.orgId}/${idempotencyKey}/${operation}`,
      });
    }

    if (this.isExpired(existing)) {
      return this.#tryReplaceExpired(existing, {
        scope,
        idempotencyKey,
        operation,
        requestHash,
        expiresAt,
        createdAt,
      });
    }

    return this.#resolveNonExpired(existing, requestHash, {
      orgId: scope.orgId,
      userId: scope.userId,
      idempotencyKey,
      operation,
    });
  }

  /**
   * Complete an in-progress idempotency record (owner-scoped).
   * Never overwrites an already-completed response.
   *
   * @param {{
   *   orgId: string,
   *   userId: string,
   *   idempotencyKey: string,
   *   operation: string,
   *   responseStatus: number,
   *   responseJson?: Record<string, unknown> | null,
   *   resourceId?: string | null,
   * }} input
   * @returns {Promise<IdempotencyRecord>}
   */
  async complete(input: { orgId: string, userId: string, idempotencyKey: string, operation: string, responseStatus: number, responseJson?: Record<string, unknown> | null, resourceId?: string | null, }) {
    const { scope, idempotencyKey, operation } = this.#validateKeyParts(input);
    if (
      typeof input.responseStatus !== 'number' ||
      !Number.isInteger(input.responseStatus) ||
      input.responseStatus < 100 ||
      input.responseStatus > 599
    ) {
      throw new Error('responseStatus must be an HTTP status integer 100–599');
    }
    if (input.resourceId != null) {
      assertUlid(input.resourceId, 'resourceId');
    }

    const nowMysql = toMysqlDateTime(this.now());
    const update = {
      response_status: input.responseStatus,
      response_json:
        input.responseJson == null
          ? null
          : JSON.stringify(input.responseJson),
      resource_id: input.resourceId ?? null,
    };

    // Only first writer wins: incomplete + not expired.
    const n = await applyOwnerScope(this.db('idempotency_records'), scope)
      .where({
        idempotency_key: idempotencyKey,
        operation,
      })
      .whereNull('response_status')
      .andWhere('expires_at', '>', nowMysql)
      .update(update);

    if (n) {
      const record = await this.get({
        orgId: scope.orgId,
        userId: scope.userId,
        idempotencyKey,
        operation,
      });
      if (!record) {
        throw new NotFoundError('Idempotency record not found after complete', {
          resource: 'idempotency_records',
          id: `${scope.orgId}/${idempotencyKey}/${operation}`,
        });
      }
      return record;
    }

    // No row updated: missing, already complete, or expired.
    const existing = await this.get({
      orgId: scope.orgId,
      userId: scope.userId,
      idempotencyKey,
      operation,
    });
    if (!existing) {
      throw new NotFoundError('Idempotency record not found', {
        resource: 'idempotency_records',
        id: `${scope.orgId}/${idempotencyKey}/${operation}`,
      });
    }
    if (this.isComplete(existing)) {
      // Idempotent: return stored response unchanged (never overwrite).
      return existing;
    }
    if (this.isExpired(existing)) {
      throw new ConflictError('Idempotency record expired before complete', {
        resource: 'idempotency_records',
        id: `${scope.orgId}/${idempotencyKey}/${operation}`,
      });
    }
    throw new ConflictError('Idempotency complete lost a concurrent race', {
      resource: 'idempotency_records',
      id: `${scope.orgId}/${idempotencyKey}/${operation}`,
    });
  }
}
