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

export const A2A_CREDENTIAL_STATUS = Object.freeze({
  ACTIVE: 'active',
  ROTATED: 'rotated',
  REVOKED: 'revoked',
});

export const KEY_ID_LEN = 16;
export const SECRET_BYTES = 32;
export const TOKEN_PREFIX = 'a2a';

/**
 * @param {Record<string, unknown>} row
 */
export function mapA2aCredential(row) {
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
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeScopesArray(raw) {
  const parsed = typeof raw === 'string' ? parseJsonColumn(raw) : raw;
  if (Array.isArray(parsed)) return normalizeScopes(parsed);
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.scopes)) {
    return normalizeScopes(parsed.scopes);
  }
  return [...DEFAULT_A2A_SCOPES];
}

/**
 * Hash a full bearer token (or secret material) to SHA-256 hex.
 * @param {string} token
 * @returns {string}
 */
export function hashA2aToken(token) {
  if (typeof token !== 'string' || !token) {
    throw new Error('token is required for hashing');
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time compare of two hex digests (same length required).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function constantTimeEqualHex(a, b) {
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
 * @param {number} [bytes]
 * @returns {string}
 */
export function mintKeyId(bytes = KEY_ID_LEN / 2) {
  return randomBytes(bytes).toString('hex');
}

/**
 * Mint a high-entropy secret (hex).
 * @param {number} [bytes]
 * @returns {string}
 */
export function mintSecret(bytes = SECRET_BYTES) {
  return randomBytes(bytes).toString('hex');
}

/**
 * Wire format: a2a_<keyId>_<secret>
 * @param {string} keyId
 * @param {string} secret
 * @returns {string}
 */
export function formatBearerToken(keyId, secret) {
  return `${TOKEN_PREFIX}_${keyId}_${secret}`;
}

/**
 * Parse bearer token into keyId + raw token for hash verification.
 * @param {string} token
 * @returns {{ keyId: string, token: string } | null}
 */
export function parseBearerToken(token) {
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
 * @param {string} token
 * @param {string} secretHash
 * @returns {boolean}
 */
export function verifyTokenHash(token, secretHash) {
  const computed = hashA2aToken(token);
  return constantTimeEqualHex(computed, String(secretHash).toLowerCase());
}

export class A2aCredentialRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   * @param {{ now?: () => Date }} [opts]
   */
  constructor(db, opts = {}) {
    if (!db) throw new Error('A2aCredentialRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * @param {string} credentialId
   */
  async getById(credentialId) {
    const id = assertUlid(credentialId, 'credentialId');
    const row = await this.db('a2a_api_credentials')
      .where({ credential_id: id })
      .first();
    return row ? mapA2aCredential(row) : null;
  }

  /**
   * Lookup by public key_id (not owner-scoped — secret still required).
   * @param {string} keyId
   */
  async getByKeyId(keyId) {
    if (typeof keyId !== 'string' || !/^[0-9a-f]{16}$/i.test(keyId.trim())) {
      return null;
    }
    const row = await this.db('a2a_api_credentials')
      .where({ key_id: keyId.trim().toLowerCase() })
      .first();
    return row ? mapA2aCredential(row) : null;
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
  async insert(input) {
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
      const code = /** @type {{ code?: string, errno?: number }} */ (err)?.code;
      const errno = /** @type {{ errno?: number }} */ (err)?.errno;
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
   * @param {string} credentialId
   * @param {string} nextStatus
   * @param {{ expectedStatus?: string | string[] }} [opts]
   */
  async updateStatus(credentialId, nextStatus, opts = {}) {
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

  /**
   * @param {string} credentialId
   */
  async touchLastUsed(credentialId) {
    const id = assertUlid(credentialId, 'credentialId');
    const now = toMysqlDateTime(this.now());
    await this.db('a2a_api_credentials')
      .where({ credential_id: id })
      .update({ last_used_at: now, updated_at: now });
  }
}
