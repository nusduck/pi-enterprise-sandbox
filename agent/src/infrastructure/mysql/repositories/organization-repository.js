/**
 * Organization + membership repository (plan §8.1–8.3).
 *
 * PR-04 T1: external user subject helpers. Users map via users.external_subject
 * with an explicit provider prefix (`provider:subject`) — not a separate table.
 */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { mapOrganization, mapUser, toMysqlDateTime } from '../row-mappers.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { assertUlid } from '../../../domain/shared/ulid.js';

/** Bound for provider segment in `provider:subject` encoding. */
export const USER_EXTERNAL_PROVIDER_MAX_LEN = 64;
/** Bound for full users.external_subject column (schema VARCHAR(255)). */
export const USER_EXTERNAL_SUBJECT_MAX_LEN = 255;

/**
 * Encode external user identity as `provider:subject` for users.external_subject.
 * @param {string} provider
 * @param {string} externalSubject
 * @returns {string}
 */
export function formatUserExternalSubject(provider, externalSubject) {
  if (typeof provider !== 'string' || !provider.trim()) {
    throw new Error('provider must be a non-empty string');
  }
  if (typeof externalSubject !== 'string' || !externalSubject.trim()) {
    throw new Error('externalSubject must be a non-empty string');
  }
  const p = provider.trim();
  const s = externalSubject.trim();
  if (p.length > USER_EXTERNAL_PROVIDER_MAX_LEN) {
    throw new Error(
      `provider exceeds max length ${USER_EXTERNAL_PROVIDER_MAX_LEN}`,
    );
  }
  if (p.includes(':')) {
    throw new Error('provider must not contain ":"');
  }
  const encoded = `${p}:${s}`;
  if (encoded.length > USER_EXTERNAL_SUBJECT_MAX_LEN) {
    throw new Error(
      `encoded external subject exceeds max length ${USER_EXTERNAL_SUBJECT_MAX_LEN}`,
    );
  }
  return encoded;
}

/**
 * @param {string} encoded
 * @returns {{ provider: string, externalSubject: string } | null}
 */
export function parseUserExternalSubject(encoded) {
  if (typeof encoded !== 'string' || !encoded.includes(':')) return null;
  const idx = encoded.indexOf(':');
  const provider = encoded.slice(0, idx);
  const externalSubject = encoded.slice(idx + 1);
  if (!provider || !externalSubject) return null;
  return { provider, externalSubject };
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

export class OrganizationRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   * @param {{ now?: () => Date }} [opts]
   */
  constructor(db, opts = {}) {
    if (!db) throw new Error('OrganizationRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * @param {{
   *   orgId: string,
   *   name: string,
   *   status: string,
   *   createdAt?: Date | string,
   *   updatedAt?: Date | string,
   * }} input
   */
  async createOrganization(input) {
    const orgId = assertUlid(input.orgId, 'orgId');
    const now = toMysqlDateTime(input.createdAt || this.now());
    const updated = toMysqlDateTime(
      input.updatedAt || input.createdAt || this.now(),
    );
    await this.db('organizations').insert({
      org_id: orgId,
      name: input.name,
      status: input.status,
      created_at: now,
      updated_at: updated,
    });
    return this.getOrganization(orgId);
  }

  /**
   * @param {string} orgId
   */
  async getOrganization(orgId) {
    const id = assertUlid(orgId, 'orgId');
    const row = await this.db('organizations').where({ org_id: id }).first();
    return row ? mapOrganization(row) : null;
  }

  /**
   * @param {{
   *   userId: string,
   *   externalSubject: string,
   *   displayName?: string | null,
   *   email?: string | null,
   *   status: string,
   *   createdAt?: Date | string,
   *   updatedAt?: Date | string,
   * }} input
   */
  async createUser(input) {
    const userId = assertUlid(input.userId, 'userId');
    if (typeof input.externalSubject !== 'string' || !input.externalSubject.trim()) {
      throw new Error('externalSubject must be a non-empty string');
    }
    const externalSubject = input.externalSubject.trim();
    if (externalSubject.length > USER_EXTERNAL_SUBJECT_MAX_LEN) {
      throw new Error(
        `externalSubject exceeds max length ${USER_EXTERNAL_SUBJECT_MAX_LEN}`,
      );
    }
    const now = toMysqlDateTime(input.createdAt || this.now());
    const updated = toMysqlDateTime(
      input.updatedAt || input.createdAt || this.now(),
    );
    await this.db('users').insert({
      user_id: userId,
      external_subject: externalSubject,
      display_name: input.displayName ?? null,
      email: input.email ?? null,
      status: input.status,
      created_at: now,
      updated_at: updated,
    });
    const row = await this.db('users').where({ user_id: userId }).first();
    return mapUser(row);
  }

  /**
   * @param {string} userId
   */
  async getUser(userId) {
    const id = assertUlid(userId, 'userId');
    const row = await this.db('users').where({ user_id: id }).first();
    return row ? mapUser(row) : null;
  }

  /**
   * Lookup user by full external_subject value (may include provider prefix).
   * @param {string} externalSubject
   */
  async getUserByExternalSubject(externalSubject) {
    if (typeof externalSubject !== 'string' || !externalSubject.trim()) {
      throw new Error('externalSubject must be a non-empty string');
    }
    const subject = externalSubject.trim();
    if (subject.length > USER_EXTERNAL_SUBJECT_MAX_LEN) {
      throw new Error(
        `externalSubject exceeds max length ${USER_EXTERNAL_SUBJECT_MAX_LEN}`,
      );
    }
    const row = await this.db('users')
      .where({ external_subject: subject })
      .first();
    return row ? mapUser(row) : null;
  }

  /**
   * Lookup user by provider + raw external subject (encodes prefix).
   * @param {string} provider
   * @param {string} externalSubject
   */
  async getUserByProviderSubject(provider, externalSubject) {
    const encoded = formatUserExternalSubject(provider, externalSubject);
    return this.getUserByExternalSubject(encoded);
  }

  /**
   * Concurrency-safe create: on unique external_subject race, reload and return
   * existing if same user_id; ConflictError if subject maps to another user.
   *
   * @param {{
   *   userId: string,
   *   externalSubject: string,
   *   displayName?: string | null,
   *   email?: string | null,
   *   status: string,
   *   createdAt?: Date | string,
   *   updatedAt?: Date | string,
   * }} input
   */
  async createUserIfAbsent(input) {
    // Validate ULID early so race path and insert share the same contract.
    assertUlid(input.userId, 'userId');
    const existing = await this.getUserByExternalSubject(input.externalSubject);
    if (existing) {
      if (existing.userId !== input.userId) {
        throw new ConflictError(
          'external_subject already mapped to a different user',
          {
            resource: 'users',
            id: input.externalSubject,
          },
        );
      }
      return existing;
    }
    try {
      return await this.createUser(input);
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const raced = await this.getUserByExternalSubject(input.externalSubject);
      if (!raced) {
        throw new ConflictError('User create race without readable row', {
          resource: 'users',
          id: input.externalSubject,
        });
      }
      if (raced.userId !== input.userId) {
        throw new ConflictError(
          'external_subject already mapped to a different user',
          {
            resource: 'users',
            id: input.externalSubject,
          },
        );
      }
      return raced;
    }
  }

  /**
   * @param {{
   *   orgId: string,
   *   userId: string,
   *   role: string,
   *   status: string,
   *   createdAt?: Date | string,
   * }} input
   */
  async addMembership(input) {
    const orgId = assertUlid(input.orgId, 'orgId');
    const userId = assertUlid(input.userId, 'userId');
    await this.db('organization_memberships').insert({
      org_id: orgId,
      user_id: userId,
      role: input.role,
      status: input.status,
      created_at: toMysqlDateTime(input.createdAt || this.now()),
    });
  }

  /**
   * Concurrency-safe membership insert (unique PK org_id+user_id).
   * @param {{
   *   orgId: string,
   *   userId: string,
   *   role: string,
   *   status: string,
   *   createdAt?: Date | string,
   * }} input
   */
  async addMembershipIfAbsent(input) {
    assertUlid(input.orgId, 'orgId');
    assertUlid(input.userId, 'userId');
    const existing = await this.getMembership(input);
    if (existing) return existing;
    try {
      await this.addMembership(input);
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
    const row = await this.getMembership(input);
    if (!row) {
      throw new ConflictError('Membership create race without readable row', {
        resource: 'organization_memberships',
        id: `${input.orgId}/${input.userId}`,
      });
    }
    return row;
  }

  /**
   * Membership lookup always scoped to org + user (ownership).
   * @param {{ orgId: string, userId: string }} scope
   */
  async getMembership(scope) {
    const s = requireOwnerScope(scope);
    const owner = {
      orgId: assertUlid(s.orgId, 'orgId'),
      userId: assertUlid(s.userId, 'userId'),
    };
    const row = await applyOwnerScope(
      this.db('organization_memberships'),
      owner,
    ).first();
    if (!row) return null;
    return {
      orgId: String(row.org_id),
      userId: String(row.user_id),
      role: String(row.role),
      status: String(row.status),
      createdAt: row.created_at,
    };
  }

  /**
   * @param {{ orgId: string, userId: string }} scope
   */
  async requireMembership(scope) {
    const m = await this.getMembership(scope);
    if (!m || m.status !== 'active') {
      throw new NotFoundError('Membership not found', {
        resource: 'organization_memberships',
        id: `${scope.orgId}/${scope.userId}`,
      });
    }
    return m;
  }
}
