import { assertUlid } from '../../domain/shared/ulid.js';
import { ValidationError } from '../errors.js';

export const A2A_IDENTITY_PROVIDER = 'a2a';

/**
 * @param value
 * @returns {string}
 */
export function normalizeA2aClientId(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('clientId is required');
  }
  const clientId = value.trim();
  if (clientId.length > 128) {
    throw new ValidationError('clientId exceeds max length 128');
  }
  return clientId;
}

/**
 * A2A client ids are only unique inside an Organization. Qualifying the raw
 * external user subject keeps the globally unique users.external_subject safe.
 *
 * @param orgId
 * @param clientId
 * @returns {string}
 */
export function formatA2aExternalUserId(orgId: string, clientId: string) {
  const owner = assertUlid(orgId, 'orgId');
  return `${owner}:${normalizeA2aClientId(clientId)}`;
}
