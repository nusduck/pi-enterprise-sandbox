/**
 * ExternalIdentityResolver — map trusted BFF/Sandbox external subjects to
 * internal plan CHAR(26) ULIDs without placing external strings in domain ids.
 *
 * Mapping tables (PR-04 T1):
 * - organization_external_refs(provider, external_subject) → org_id
 * - users.external_subject with provider prefix → user_id
 * - conversation_external_refs(owner + provider + subject) → conversation_id
 *
 * Read-only: does not provision missing parents (see RunParentProvisioner).
 */

import {
  formatUserExternalSubject,
} from '../../infrastructure/mysql/repositories/organization-repository.js';
import { OwnerScopedNotFoundError, ValidationError } from '../errors.js';
import { assertUlid, isLegacyOrUuidIdentity, isUlid } from '../../domain/shared/ulid.js';

/** Default external identity provider for BFF compatibility. */
export const DEFAULT_EXTERNAL_PROVIDER = 'bff';

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function requireExternalSubject(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  const s = value.trim();
  if (s.length > 255) {
    throw new ValidationError(`${field} exceeds max length 255`);
  }
  return s;
}

/**
 * Reject accidental placement of external UUID/arun_ strings into ULID slots.
 * @param {unknown} value
 * @param {string} field
 */
export function assertNotExternalInUlidSlot(value, field) {
  if (isLegacyOrUuidIdentity(value)) {
    throw new ValidationError(
      `${field} must be an internal ULID; external UUID/arun_ identities belong in mapping tables`,
      { field, value: String(value) },
    );
  }
  if (typeof value === 'string' && value.length === 26 && !isUlid(value)) {
    // Non-Crockford 26-char string is still not a plan ULID.
    throw new ValidationError(
      `${field} must be a Crockford ULID (CHAR(26))`,
      { field },
    );
  }
}

export class ExternalIdentityResolver {
  /**
   * @param {{
   *   organizations: import('../../infrastructure/mysql/repositories/organization-repository.js').OrganizationRepository,
   *   externalRefs: import('../../infrastructure/mysql/repositories/external-reference-repository.js').ExternalReferenceRepository,
   * }} repos
   * @param {{ defaultProvider?: string }} [opts]
   */
  constructor(repos, opts = {}) {
    if (!repos?.organizations || !repos?.externalRefs) {
      throw new Error(
        'ExternalIdentityResolver requires organizations and externalRefs repositories',
      );
    }
    this.repos = repos;
    this.defaultProvider = opts.defaultProvider ?? DEFAULT_EXTERNAL_PROVIDER;
  }

  /**
   * @param {{
   *   provider?: string,
   *   externalOrgId: string,
   *   externalUserId: string,
   * }} auth
   * @returns {Promise<{ orgId: string, userId: string, provider: string, membership: object }>}
   */
  async resolveOwner(auth) {
    if (!auth || typeof auth !== 'object') {
      throw new ValidationError('auth context is required');
    }
    const provider = (auth.provider ?? this.defaultProvider).trim();
    if (!provider) throw new ValidationError('provider must be non-empty');

    const externalOrgId = requireExternalSubject(
      auth.externalOrgId,
      'externalOrgId',
    );
    const externalUserId = requireExternalSubject(
      auth.externalUserId,
      'externalUserId',
    );

    const orgRef = await this.repos.externalRefs.getOrganizationRef(
      provider,
      externalOrgId,
    );
    if (!orgRef) {
      throw new OwnerScopedNotFoundError('Organization mapping not found', {
        resource: 'organization_external_refs',
        id: `${provider}/${externalOrgId}`,
      });
    }
    assertNotExternalInUlidSlot(orgRef.orgId, 'orgId');
    const orgId = assertUlid(orgRef.orgId, 'orgId');

    const encodedUser = formatUserExternalSubject(provider, externalUserId);
    const user = await this.repos.organizations.getUserByExternalSubject(
      encodedUser,
    );
    if (!user) {
      throw new OwnerScopedNotFoundError('User mapping not found', {
        resource: 'users',
        id: encodedUser,
      });
    }
    assertNotExternalInUlidSlot(user.userId, 'userId');
    const userId = assertUlid(user.userId, 'userId');

    const membership = await this.repos.organizations.getMembership({
      orgId,
      userId,
    });
    if (!membership || membership.status !== 'active') {
      throw new OwnerScopedNotFoundError('Membership not found', {
        resource: 'organization_memberships',
        id: `${orgId}/${userId}`,
      });
    }

    return { orgId, userId, provider, membership };
  }

  /**
   * Owner-scoped conversation external subject → internal ULID.
   * @param {{
   *   orgId: string,
   *   userId: string,
   *   provider?: string,
   *   externalConversationId: string,
   * }} input
   */
  async resolveConversation(input) {
    const orgId = assertUlid(input.orgId, 'orgId');
    const userId = assertUlid(input.userId, 'userId');
    const provider = (input.provider ?? this.defaultProvider).trim();
    const externalConversationId = requireExternalSubject(
      input.externalConversationId,
      'externalConversationId',
    );

    const ref = await this.repos.externalRefs.getConversationRef({
      orgId,
      userId,
      provider,
      externalSubject: externalConversationId,
    });
    if (!ref) {
      throw new OwnerScopedNotFoundError('Conversation mapping not found', {
        resource: 'conversation_external_refs',
        id: `${orgId}/${provider}/${externalConversationId}`,
      });
    }
    assertNotExternalInUlidSlot(ref.conversationId, 'conversationId');
    return {
      conversationId: assertUlid(ref.conversationId, 'conversationId'),
      provider,
      externalConversationId,
    };
  }
}
