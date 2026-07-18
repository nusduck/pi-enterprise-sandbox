/**
 * External identity mapping (PR-04 T1 compatibility).
 *
 * Existing BFF/Sandbox UUID/string identities must not be stored in CHAR(26)
 * domain columns. Additive mapping tables resolve external subjects → ULIDs:
 *
 * - organization_external_refs(provider, external_subject) → org_id
 * - conversation_external_refs(org_id, user_id, provider, external_subject) → conversation_id
 *
 * User mapping uses users.external_subject with an explicit provider prefix
 * (see OrganizationRepository.getUserByExternalSubject / formatUserExternalSubject).
 */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { toMysqlDateTime, formatDateTime } from '../row-mappers.js';
import { ConflictError } from '../errors.js';
import { assertUlid } from '../../../domain/shared/ulid.js';

export const EXTERNAL_PROVIDER_MAX_LEN = 64;
export const EXTERNAL_SUBJECT_MAX_LEN = 255;

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
 * @param {string} value
 * @param {string} field
 * @param {number} maxLen
 */
function requireBoundedString(value, field, maxLen) {
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

/**
 * @param {Record<string, unknown>} row
 */
export function mapOrganizationExternalRef(row) {
  return {
    provider: String(row.provider),
    externalSubject: String(row.external_subject),
    orgId: String(row.org_id),
    createdAt: formatDateTime(row.created_at),
  };
}

/**
 * @param {Record<string, unknown>} row
 */
export function mapConversationExternalRef(row) {
  return {
    orgId: String(row.org_id),
    userId: String(row.user_id),
    provider: String(row.provider),
    externalSubject: String(row.external_subject),
    conversationId: String(row.conversation_id),
    createdAt: formatDateTime(row.created_at),
  };
}

export class ExternalReferenceRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   * @param {{ now?: () => Date }} [opts]
   */
  constructor(db, opts = {}) {
    if (!db) {
      throw new Error('ExternalReferenceRepository requires a knex executor');
    }
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * @param {string} provider
   * @param {string} externalSubject
   */
  async getOrganizationRef(provider, externalSubject) {
    const p = requireBoundedString(provider, 'provider', EXTERNAL_PROVIDER_MAX_LEN);
    const s = requireBoundedString(
      externalSubject,
      'externalSubject',
      EXTERNAL_SUBJECT_MAX_LEN,
    );
    const row = await this.db('organization_external_refs')
      .where({ provider: p, external_subject: s })
      .first();
    return row ? mapOrganizationExternalRef(row) : null;
  }

  /**
   * Create org external mapping. On unique race, reload and return existing
   * if org_id matches; conflict if mapped to a different org.
   *
   * @param {{
   *   provider: string,
   *   externalSubject: string,
   *   orgId: string,
   *   createdAt?: Date | string,
   * }} input
   */
  async createOrganizationRef(input) {
    const provider = requireBoundedString(
      input.provider,
      'provider',
      EXTERNAL_PROVIDER_MAX_LEN,
    );
    const externalSubject = requireBoundedString(
      input.externalSubject,
      'externalSubject',
      EXTERNAL_SUBJECT_MAX_LEN,
    );
    const orgId = assertUlid(input.orgId, 'orgId');
    const createdAt = toMysqlDateTime(input.createdAt || this.now());

    try {
      await this.db('organization_external_refs').insert({
        provider,
        external_subject: externalSubject,
        org_id: orgId,
        created_at: createdAt,
      });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const existing = await this.getOrganizationRef(provider, externalSubject);
      if (!existing) {
        throw new ConflictError('Organization external ref conflict', {
          resource: 'organization_external_refs',
          id: `${provider}/${externalSubject}`,
        });
      }
      if (existing.orgId !== orgId) {
        throw new ConflictError(
          'Organization external subject already mapped to a different org',
          {
            resource: 'organization_external_refs',
            id: `${provider}/${externalSubject}`,
          },
        );
      }
      return existing;
    }

    const row = await this.getOrganizationRef(provider, externalSubject);
    if (!row) {
      throw new Error('Organization external ref insert not readable');
    }
    return row;
  }

  /**
   * Get-or-create org mapping (concurrency-safe).
   * @param {{
   *   provider: string,
   *   externalSubject: string,
   *   orgId: string,
   *   createdAt?: Date | string,
   * }} input
   */
  async getOrCreateOrganizationRef(input) {
    assertUlid(input.orgId, 'orgId');
    const existing = await this.getOrganizationRef(
      input.provider,
      input.externalSubject,
    );
    if (existing) {
      if (existing.orgId !== input.orgId) {
        throw new ConflictError(
          'Organization external subject already mapped to a different org',
          {
            resource: 'organization_external_refs',
            id: `${input.provider}/${input.externalSubject}`,
          },
        );
      }
      return existing;
    }
    return this.createOrganizationRef(input);
  }

  /**
   * Owner-scoped conversation external ref lookup.
   * @param {{
   *   orgId: string,
   *   userId: string,
   *   provider: string,
   *   externalSubject: string,
   * }} input
   */
  async getConversationRef(input) {
    const scopeRaw = requireOwnerScope(input);
    const scope = {
      orgId: assertUlid(scopeRaw.orgId, 'orgId'),
      userId: assertUlid(scopeRaw.userId, 'userId'),
    };
    const provider = requireBoundedString(
      input.provider,
      'provider',
      EXTERNAL_PROVIDER_MAX_LEN,
    );
    const externalSubject = requireBoundedString(
      input.externalSubject,
      'externalSubject',
      EXTERNAL_SUBJECT_MAX_LEN,
    );
    const row = await applyOwnerScope(
      this.db('conversation_external_refs'),
      scope,
    )
      .where({
        provider,
        external_subject: externalSubject,
      })
      .first();
    return row ? mapConversationExternalRef(row) : null;
  }

  /**
   * Create conversation external mapping under owner scope.
   * Duplicate race: reload; conflict if conversation_id differs.
   *
   * @param {{
   *   orgId: string,
   *   userId: string,
   *   provider: string,
   *   externalSubject: string,
   *   conversationId: string,
   *   createdAt?: Date | string,
   * }} input
   */
  async createConversationRef(input) {
    const scopeRaw = requireOwnerScope(input);
    const scope = {
      orgId: assertUlid(scopeRaw.orgId, 'orgId'),
      userId: assertUlid(scopeRaw.userId, 'userId'),
    };
    const provider = requireBoundedString(
      input.provider,
      'provider',
      EXTERNAL_PROVIDER_MAX_LEN,
    );
    const externalSubject = requireBoundedString(
      input.externalSubject,
      'externalSubject',
      EXTERNAL_SUBJECT_MAX_LEN,
    );
    const conversationId = assertUlid(input.conversationId, 'conversationId');
    const createdAt = toMysqlDateTime(input.createdAt || this.now());

    try {
      await this.db('conversation_external_refs').insert({
        org_id: scope.orgId,
        user_id: scope.userId,
        provider,
        external_subject: externalSubject,
        conversation_id: conversationId,
        created_at: createdAt,
      });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      const existing = await this.getConversationRef({
        orgId: scope.orgId,
        userId: scope.userId,
        provider,
        externalSubject,
      });
      if (!existing) {
        throw new ConflictError('Conversation external ref conflict', {
          resource: 'conversation_external_refs',
          id: `${scope.orgId}/${provider}/${externalSubject}`,
        });
      }
      if (existing.conversationId !== conversationId) {
        throw new ConflictError(
          'Conversation external subject already mapped to a different conversation',
          {
            resource: 'conversation_external_refs',
            id: `${scope.orgId}/${provider}/${externalSubject}`,
          },
        );
      }
      return existing;
    }

    const row = await this.getConversationRef({
      orgId: scope.orgId,
      userId: scope.userId,
      provider,
      externalSubject,
    });
    if (!row) {
      throw new Error('Conversation external ref insert not readable');
    }
    return row;
  }

  /**
   * @param {{
   *   orgId: string,
   *   userId: string,
   *   provider: string,
   *   externalSubject: string,
   *   conversationId: string,
   *   createdAt?: Date | string,
   * }} input
   */
  async getOrCreateConversationRef(input) {
    assertUlid(input.conversationId, 'conversationId');
    const existing = await this.getConversationRef(input);
    if (existing) {
      if (existing.conversationId !== input.conversationId) {
        throw new ConflictError(
          'Conversation external subject already mapped to a different conversation',
          {
            resource: 'conversation_external_refs',
            id: `${input.orgId}/${input.provider}/${input.externalSubject}`,
          },
        );
      }
      return existing;
    }
    return this.createConversationRef(input);
  }
}
