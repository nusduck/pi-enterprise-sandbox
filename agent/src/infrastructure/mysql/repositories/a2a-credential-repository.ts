/**
 * A2A API credential repository (plan §20.7).
 *
 * Secrets are never stored — only SHA-256 hex hashes. Lookup is by public key_id;
 * verification is constant-time in the application layer.
 */

import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import {
  toMysqlDateTime,
  parseJsonColumn,
  formatDateTime,
} from '../row-mappers.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { assertUlid } from '../../../domain/shared/ulid.js';
import {
  normalizeScopes,
  DEFAULT_A2A_SCOPES,
} from '../../../domain/a2a/scopes.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export const A2A_CREDENTIAL_STATUS = Object.freeze({
  ACTIVE: 'active',
  ROTATED: 'rotated',
  REVOKED: 'revoked',
});

export const KEY_ID_LEN = 16;
export const SECRET_BYTES = 32;
export const TOKEN_PREFIX = 'a2a';

export function mapA2aCredential(row: Record<string, unknown>) {
  return {
    credentialId: String(row.credential_id),
    orgId: String(row.org_id),
    agentId: String(row.agent_id),
    serviceUserId: String(row.service_user_id),
    clientId: String(row.client_id),
    keyId: String(row.key_id),
    secretHash: String(row.secret_hash),
    scopes: normalizeScopesArray(row.scopes_json),
    status: String(row.status),
    expiresAt: formatDateTime(row.expires_at),
    rotatedFromId:
      row.rotated_from_id == null ? null : String(row.rotated_from_id),
    lastUsedAt: formatDateTime(row.last_used_at),
    createdAt: formatDateTime(row.created_at),
    updatedAt: formatDateTime(row.updated_at),
  };
}

/**
 * @param raw
 * @returns {string[]}
 */
function normalizeScopesArray(raw: unknown) {
  const parsed = typeof raw === 'string' ? parseJsonColumn(raw) : raw;
  if (Array.isArray(parsed)) return normalizeScopes(parsed);
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.scopes)) {
    return normalizeScopes(parsed.scopes);
  }
  return [...DEFAULT_A2A_SCOPES];
}

/**
 * Hash a full bearer token (or secret material) to SHA-256 hex.
 * @param token
 * @returns {string}
 */
export function hashA2aToken(token: string) {
  if (typeof token !== 'string' || !token) {
    throw new Error('token is required for hashing');
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time compare of two hex digests (same length required).
 * @param a
 * @param b
 * @returns {boolean}
 */
export function constantTimeEqualHex(a: string, b: string) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Mint a public key id (hex).
 * @param [bytes]
 * @returns {string}
 */
export function mintKeyId(bytes: number = KEY_ID_LEN / 2) {
  return randomBytes(bytes).toString('hex');
}

/**
 * Mint a high-entropy secret (hex).
 * @param [bytes]
 * @returns {string}
 */
export function mintSecret(bytes: number = SECRET_BYTES) {
  return randomBytes(bytes).toString('hex');
}

/**
 * Wire format: a2a_<keyId>_<secret>
 * @param keyId
 * @param secret
 * @returns {string}
 */
export function formatBearerToken(keyId: string, secret: string) {
  return `${TOKEN_PREFIX}_${keyId}_${secret}`;
}

/**
 * Parse bearer token into keyId + raw token for hash verification.
 * @param token
 * @returns {{ keyId: string, token: string } | null}
 */
export function parseBearerToken(token: string) {
  if (typeof token !== 'string' || !token.trim()) return null;
  const raw = token.trim();
  // Accept "Bearer …" already stripped by caller; still strip if present.
  const value = raw.replace(/^Bearer\s+/i, '').trim();
  const m = value.match(/^a2a_([0-9a-f]{16})_([0-9a-f]{64})$/i);
  if (!m) return null;
  return { keyId: m[1].toLowerCase(), token: value };
}

/**
 * Verify plaintext token against stored hash (constant-time).
 * @param token
 * @param secretHash
 * @returns {boolean}
 */
export function verifyTokenHash(token: string, secretHash: string) {
  const computed = hashA2aToken(token);
  return constantTimeEqualHex(computed, String(secretHash).toLowerCase());
}

export class A2aCredentialRepository {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  db: Loose;
  now: Loose;

  constructor(db: import('knex').Knex | import('knex').Knex.Transaction, opts: { now?: () => Date } = {}) {
    if (!db) throw new Error('A2aCredentialRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  async getById(credentialId: string) {
    const id = assertUlid(credentialId, 'credentialId');
    const row = await this.db('a2a_api_credentials')
      .where({ credential_id: id })
      .first();
    return row ? mapA2aCredential(row) : null;
  }

  /**
   * Lookup by public key_id (not owner-scoped — secret still required).
   * @param keyId
   */
  async getByKeyId(keyId: string) {
    if (typeof keyId !== 'string' || !/^[0-9a-f]{16}$/i.test(keyId.trim())) {
      return null;
    }
    const row = await this.db('a2a_api_credentials')
      .where({ key_id: keyId.trim().toLowerCase() })
      .first();
    return row ? mapA2aCredential(row) : null;
  }

  /**
   * Admin-only caller contract: organization scope is mandatory.
   *
   * @param orgId
   * @param [opts]
   */
  async listByOrg(orgId: string, opts: { agentId?: string | null, limit?: number } = {}) {
    const oid = assertUlid(orgId, 'orgId');
    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
    let query = this.db('a2a_api_credentials')
      .where({ org_id: oid })
      .orderBy('created_at', 'desc');
    if (opts.agentId) {
      query = query.andWhere({
        agent_id: assertUlid(opts.agentId, 'agentId'),
      });
    }
    const rows = await query.limit(limit);
    return rows.map(mapA2aCredential);
  }

  /**
   * @param {{
   *   credentialId: string,
   *   orgId: string,
   *   agentId: string,
   *   serviceUserId: string,
   *   clientId: string,
   *   keyId: string,
   *   secretHash: string,
   *   scopes?: string[],
   *   status?: string,
   *   expiresAt?: Date | string | null,
   *   rotatedFromId?: string | null,
   * }} input
   */
  async insert(input: { credentialId: string, orgId: string, agentId: string, serviceUserId: string, clientId: string, keyId: string, secretHash: string, scopes?: string[], status?: string, expiresAt?: Date | string | null, rotatedFromId?: string | null, }) {
    const credentialId = assertUlid(input.credentialId, 'credentialId');
    const orgId = assertUlid(input.orgId, 'orgId');
    const agentId = assertUlid(input.agentId, 'agentId');
    const serviceUserId = assertUlid(input.serviceUserId, 'serviceUserId');
    if (typeof input.clientId !== 'string' || !input.clientId.trim()) {
      throw new Error('clientId is required');
    }
    if (typeof input.keyId !== 'string' || !/^[0-9a-f]{16}$/i.test(input.keyId)) {
      throw new Error('keyId must be 16 hex chars');
    }
    if (
      typeof input.secretHash !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(input.secretHash)
    ) {
      throw new Error('secretHash must be 64 hex chars (sha256)');
    }
    const scopes = normalizeScopes(input.scopes ?? DEFAULT_A2A_SCOPES);
    const status = input.status || A2A_CREDENTIAL_STATUS.ACTIVE;
    const now = toMysqlDateTime(this.now());
    const expiresAt =
      input.expiresAt == null ? null : toMysqlDateTime(input.expiresAt);
    const rotatedFromId =
      input.rotatedFromId != null
        ? assertUlid(input.rotatedFromId, 'rotatedFromId')
        : null;

    try {
      await this.db('a2a_api_credentials').insert({
        credential_id: credentialId,
        org_id: orgId,
        agent_id: agentId,
        service_user_id: serviceUserId,
        client_id: input.clientId.trim(),
        key_id: input.keyId.toLowerCase(),
        secret_hash: input.secretHash.toLowerCase(),
        scopes_json: JSON.stringify(scopes),
        status,
        expires_at: expiresAt,
        rotated_from_id: rotatedFromId,
        last_used_at: null,
        created_at: now,
        updated_at: now,
      });
    } catch (err) {
      const code = (err as { code?: string, errno?: number })?.code;
      const errno = (err as { errno?: number })?.errno;
      if (code === 'ER_DUP_ENTRY' || errno === 1062) {
        throw new ConflictError('A2A credential key_id already exists');
      }
      throw err;
    }

    return this.getById(credentialId);
  }

  /**
   * Mark credential status (rotation / revoke). CAS on expected status.
   *
   * @param credentialId
   * @param nextStatus
   * @param [opts]
   */
  async updateStatus(credentialId: string, nextStatus: string, opts: { expectedStatus?: string | string[] } = {}) {
    const id = assertUlid(credentialId, 'credentialId');
    const now = toMysqlDateTime(this.now());
    let q = this.db('a2a_api_credentials')
      .where({ credential_id: id })
      .update({ status: nextStatus, updated_at: now });
    if (opts.expectedStatus != null) {
      const expected = Array.isArray(opts.expectedStatus)
        ? opts.expectedStatus
        : [opts.expectedStatus];
      q = q.whereIn('status', expected);
    }
    const n = await q;
    if (!n) {
      throw new NotFoundError('A2A credential not found or status conflict', {
        resource: 'a2a_api_credentials',
        id,
      });
    }
    return this.getById(id);
  }

  async touchLastUsed(credentialId: string) {
    const id = assertUlid(credentialId, 'credentialId');
    const now = toMysqlDateTime(this.now());
    await this.db('a2a_api_credentials')
      .where({ credential_id: id })
      .update({ last_used_at: now, updated_at: now });
  }
}
