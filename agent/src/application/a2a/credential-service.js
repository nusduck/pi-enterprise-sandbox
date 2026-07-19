/**
 * A2A API credential lifecycle (plan §20.7) — PR-12 severe follow-up.
 *
 * - Issue: mint key_id + secret; store only hash; expiresAt must be valid future when set
 * - Authenticate: dummy timingSafe path when key missing; invalid expiry fail-closed
 * - Rotate: single transaction CAS old status + insert new; race → one winner
 * - Never returns plaintext secret after issue
 */

import {
  A2A_CREDENTIAL_STATUS,
  formatBearerToken,
  hashA2aToken,
  mapA2aCredential,
  mintKeyId,
  mintSecret,
  parseBearerToken,
  verifyTokenHash,
  constantTimeEqualHex,
} from '../../infrastructure/mysql/repositories/a2a-credential-repository.js';
import {
  DEFAULT_A2A_SCOPES,
  normalizeScopes,
  hasScope,
} from '../../domain/a2a/scopes.js';
import { assertUlid } from '../../domain/shared/ulid.js';
import { formatUserExternalSubject } from '../../infrastructure/mysql/repositories/organization-repository.js';
import { OwnerScopedNotFoundError, ValidationError } from '../errors.js';
import {
  A2A_IDENTITY_PROVIDER,
  formatA2aExternalUserId,
  normalizeA2aClientId,
} from './identity.js';

/** Dummy hash for constant-time path when credential missing. */
const DUMMY_SECRET_HASH =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export class A2aAuthError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'A2aAuthError';
    this.code = opts.code ?? 'A2A_AUTH_FAILED';
  }
}

/**
 * Normalize expiresAt: null allowed (no expiry); otherwise must parse to future ms.
 * @param {unknown} value
 * @param {() => Date} now
 * @returns {Date | null}
 */
export function normalizeFutureExpiresAt(value, now = () => new Date()) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError('expiresAt must be a valid date');
  }
  if (d.getTime() <= now().getTime()) {
    throw new ValidationError('expiresAt must be in the future');
  }
  return d;
}

/**
 * Stored expiry fail-closed: missing/invalid/expired all reject when field present
 * or when parse fails. Null/empty means no expiry.
 * @param {string | null | undefined} expiresAt
 * @param {() => Date} now
 * @returns {'ok' | 'expired' | 'invalid'}
 */
export function evaluateStoredExpiry(expiresAt, now = () => new Date()) {
  if (expiresAt == null || expiresAt === '') return 'ok';
  const exp = Date.parse(String(expiresAt));
  if (!Number.isFinite(exp)) return 'invalid';
  if (exp <= now().getTime()) return 'expired';
  return 'ok';
}

export class A2aCredentialService {
  /**
   * @param {{
   *   createRepositories: (db?: any) => any,
   *   transactionManager?: { run: (fn: (trx: any) => Promise<any>) => Promise<any> } | null,
   *   db?: any,
   *   generateId: () => string,
   *   now?: () => Date,
   *   allowNonTransactionalRotate?: boolean,
   * }} deps
   */
  constructor(deps) {
    if (typeof deps?.createRepositories !== 'function') {
      throw new Error('A2aCredentialService requires createRepositories');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('A2aCredentialService requires generateId');
    }
    this.createRepositories = deps.createRepositories;
    this.tx = deps.transactionManager ?? null;
    this.db = deps.db ?? null;
    this.generateId = deps.generateId;
    this.now = deps.now ?? (() => new Date());
    this.allowNonTransactionalRotate = deps.allowNonTransactionalRotate === true;
  }

  /**
   * @param {{
   *   orgId: string,
   *   agentId: string,
   *   serviceUserId?: string,
   *   clientId: string,
   *   scopes?: string[],
   *   expiresAt?: Date | string | null,
   *   rotatedFromId?: string | null,
   * }} input
   */
  async issue(input) {
    const orgId = assertUlid(input.orgId, 'orgId');
    const agentId = assertUlid(input.agentId, 'agentId');
    const explicitServiceUserId = input.serviceUserId == null
      ? null
      : assertUlid(input.serviceUserId, 'serviceUserId');
    const clientId = normalizeA2aClientId(input.clientId);
    const scopes = normalizeScopes(input.scopes ?? DEFAULT_A2A_SCOPES);
    const expiresAt = normalizeFutureExpiresAt(input.expiresAt, this.now);
    const keyId = mintKeyId();
    const secret = mintSecret();
    const token = formatBearerToken(keyId, secret);
    const secretHash = hashA2aToken(token);
    const credentialId = this.generateId();

    const write = async (db) => {
      const repos = this.createRepositories(db);
      const serviceUserId = explicitServiceUserId ??
        await this.#resolveServiceUser(repos, { orgId, clientId });
      return repos.a2aCredentials.insert({
        credentialId,
        orgId,
        agentId,
        serviceUserId,
        clientId,
        keyId,
        secretHash,
        scopes,
        status: A2A_CREDENTIAL_STATUS.ACTIVE,
        expiresAt,
        rotatedFromId: input.rotatedFromId ?? null,
      });
    };

    if (!explicitServiceUserId && !this.tx?.run) {
      throw new ValidationError(
        'Automatic A2A service user provisioning requires a transaction manager',
      );
    }
    const record = this.tx?.run
      ? await this.tx.run(write)
      : await write(this.db);

    return {
      credential: publicCredentialView(record),
      token,
      bearerToken: token,
    };
  }

  /**
   * Resolve the stable service user for one Organization + A2A client. This is
   * called inside the same transaction that inserts the credential so a
   * credential can never commit without its user and membership.
   *
   * @param {object} repos
   * @param {{ orgId: string, clientId: string }} input
   * @returns {Promise<string>}
   */
  async #resolveServiceUser(repos, input) {
    const organizations = repos?.organizations;
    if (
      !organizations?.getUserByExternalSubject ||
      !organizations?.createUserIfAbsent ||
      !organizations?.addMembershipIfAbsent
    ) {
      throw new Error(
        'Automatic A2A service user provisioning requires organization repositories',
      );
    }

    const externalUserId = formatA2aExternalUserId(
      input.orgId,
      input.clientId,
    );
    const externalSubject = formatUserExternalSubject(
      A2A_IDENTITY_PROVIDER,
      externalUserId,
    );
    let user = await organizations.getUserByExternalSubject(externalSubject);
    if (!user) {
      user = await organizations.createUserIfAbsent({
        userId: this.generateId(),
        externalSubject,
        displayName: `${A2A_IDENTITY_PROVIDER}:${input.clientId}`,
        status: 'active',
      });
    }
    if (user.status && user.status !== 'active') {
      throw new ValidationError('A2A service user is not active');
    }

    const serviceUserId = assertUlid(user.userId, 'serviceUserId');
    const membership = await organizations.addMembershipIfAbsent({
      orgId: input.orgId,
      userId: serviceUserId,
      role: 'member',
      status: 'active',
    });
    if (membership?.status && membership.status !== 'active') {
      throw new ValidationError('A2A service user membership is not active');
    }
    return serviceUserId;
  }

  /**
   * @param {string | null | undefined} authorizationHeader
   * @param {{ agentId?: string | null, requiredScope?: string | null }} [opts]
   */
  async authenticate(authorizationHeader, opts = {}) {
    const raw =
      typeof authorizationHeader === 'string' ? authorizationHeader.trim() : '';
    if (!raw) {
      // Still exercise dummy compare for timing shape.
      verifyTokenHash(
        formatBearerToken('0'.repeat(16), '0'.repeat(64)),
        DUMMY_SECRET_HASH,
      );
      throw new A2aAuthError('Missing or invalid API credential', {
        code: 'A2A_AUTH_REQUIRED',
      });
    }
    const tokenValue = raw.replace(/^Bearer\s+/i, '').trim();
    const parsed = parseBearerToken(tokenValue);
    if (!parsed) {
      verifyTokenHash(
        formatBearerToken('0'.repeat(16), '0'.repeat(64)),
        DUMMY_SECRET_HASH,
      );
      throw new A2aAuthError('Missing or invalid API credential', {
        code: 'A2A_AUTH_INVALID',
      });
    }

    const repos = this.createRepositories(this.db);
    const cred = await repos.a2aCredentials.getByKeyId(parsed.keyId);

    // Always constant-time hash path (missing key → dummy hash).
    const hashTarget = cred?.secretHash || DUMMY_SECRET_HASH;
    const hashOk = verifyTokenHash(parsed.token, hashTarget);
    // Extra equalize when missing: compare dummy to dummy path length
    if (!cred) {
      constantTimeEqualHex(DUMMY_SECRET_HASH, DUMMY_SECRET_HASH);
    }

    if (!cred || !hashOk || cred.status !== A2A_CREDENTIAL_STATUS.ACTIVE) {
      throw new A2aAuthError('Missing or invalid API credential', {
        code: 'A2A_AUTH_INVALID',
      });
    }

    const expState = evaluateStoredExpiry(cred.expiresAt, this.now);
    if (expState === 'invalid') {
      throw new A2aAuthError('API credential expiry is invalid', {
        code: 'A2A_AUTH_EXPIRY_INVALID',
      });
    }
    if (expState === 'expired') {
      throw new A2aAuthError('API credential expired', {
        code: 'A2A_AUTH_EXPIRED',
      });
    }

    if (opts.agentId) {
      const agentId = assertUlid(opts.agentId, 'agentId');
      if (cred.agentId !== agentId) {
        throw new A2aAuthError('Missing or invalid API credential', {
          code: 'A2A_AUTH_AGENT_MISMATCH',
        });
      }
    }

    if (opts.requiredScope && !hasScope(cred.scopes, opts.requiredScope)) {
      throw new A2aAuthError('Insufficient credential scope', {
        code: 'A2A_AUTH_SCOPE',
      });
    }

    try {
      await repos.a2aCredentials.touchLastUsed(cred.credentialId);
    } catch {
      /* non-fatal */
    }

    return {
      credentialId: cred.credentialId,
      orgId: cred.orgId,
      agentId: cred.agentId,
      serviceUserId: cred.serviceUserId,
      clientId: cred.clientId,
      scopes: cred.scopes,
      callerType: /** @type {const} */ ('a2a'),
      callerId: cred.clientId,
    };
  }

  /**
   * Rotate in ONE transaction: CAS old → rotated, insert new active.
   * Concurrent rotate: only one CAS wins; loser gets ValidationError/NotFound.
   *
   * @param {{
   *   credentialId: string,
   *   orgId: string,
   *   scopes?: string[],
   *   expiresAt?: Date | string | null,
   * }} input
   */
  async rotate(input) {
    const credentialId = assertUlid(input.credentialId, 'credentialId');
    const orgId = assertUlid(input.orgId, 'orgId');
    // Validate caller-supplied expiresAt before any state change.
    const expiresAt =
      input.expiresAt !== undefined
        ? normalizeFutureExpiresAt(input.expiresAt, this.now)
        : undefined;

    /**
     * Resolve next expiry fail-closed **before** CAS/ROTATED.
     * Never mint a non-expiring credential from an expired/invalid source when
     * expiresAt is omitted (or explicitly cleared).
     *
     * @param {{ expiresAt?: string | null }} existing
     * @returns {Date | null}
     */
    const resolveNextExpiresAt = (existing) => {
      const sourceState = existing.expiresAt
        ? evaluateStoredExpiry(existing.expiresAt, this.now)
        : 'ok';

      if (expiresAt !== undefined) {
        // Explicit null would clear expiry — forbidden when source is bad.
        if (
          expiresAt === null &&
          (sourceState === 'expired' || sourceState === 'invalid')
        ) {
          throw new ValidationError(
            'Cannot rotate expired or invalid credential into a non-expiring credential; provide a future expiresAt',
          );
        }
        return expiresAt;
      }

      // Omitted: carry forward only a still-valid future expiry (or null if none).
      if (sourceState === 'expired' || sourceState === 'invalid') {
        throw new ValidationError(
          'Cannot rotate credential with expired or invalid expiresAt; provide a future expiresAt',
        );
      }
      if (existing.expiresAt) {
        return new Date(existing.expiresAt);
      }
      return null;
    };

    const run = async (db) => {
      const repos = this.createRepositories(db);
      const existing = await repos.a2aCredentials.getById(credentialId);
      if (!existing || existing.orgId !== orgId) {
        throw new OwnerScopedNotFoundError('Credential not found', {
          resource: 'a2a_api_credentials',
          id: credentialId,
        });
      }
      if (existing.status !== A2A_CREDENTIAL_STATUS.ACTIVE) {
        throw new ValidationError('Only active credentials can be rotated');
      }

      // Validate expiry before any status write (fail-closed; no ROTATED on reject).
      const exp = resolveNextExpiresAt(existing);

      // CAS: only active → rotated (same transaction as insert below).
      await repos.a2aCredentials.updateStatus(
        credentialId,
        A2A_CREDENTIAL_STATUS.ROTATED,
        { expectedStatus: A2A_CREDENTIAL_STATUS.ACTIVE },
      );

      const keyId = mintKeyId();
      const secret = mintSecret();
      const token = formatBearerToken(keyId, secret);
      const secretHash = hashA2aToken(token);
      const newId = this.generateId();
      const scopes = normalizeScopes(input.scopes ?? existing.scopes);

      const record = await repos.a2aCredentials.insert({
        credentialId: newId,
        orgId: existing.orgId,
        agentId: existing.agentId,
        serviceUserId: existing.serviceUserId,
        clientId: existing.clientId,
        keyId,
        secretHash,
        scopes,
        status: A2A_CREDENTIAL_STATUS.ACTIVE,
        expiresAt: exp,
        rotatedFromId: existing.credentialId,
      });

      return {
        credential: publicCredentialView(record),
        token,
        bearerToken: token,
      };
    };

    if (!this.tx?.run) {
      // Production/non-test: never sequential CAS+insert without a transaction
      // (partial failure could leave ROTATED without replacement).
      if (this.allowNonTransactionalRotate !== true) {
        throw new ValidationError(
          'Credential rotation requires a transaction manager',
        );
      }
      return run(this.db);
    }
    return this.tx.run(run);
  }

  /**
   * @param {{ credentialId: string, orgId: string }} input
   */
  async revoke(input) {
    const credentialId = assertUlid(input.credentialId, 'credentialId');
    const orgId = assertUlid(input.orgId, 'orgId');
    const repos = this.createRepositories(this.db);
    const existing = await repos.a2aCredentials.getById(credentialId);
    if (!existing || existing.orgId !== orgId) {
      throw new OwnerScopedNotFoundError('Credential not found', {
        resource: 'a2a_api_credentials',
        id: credentialId,
      });
    }
    if (existing.status === A2A_CREDENTIAL_STATUS.REVOKED) {
      return publicCredentialView(existing);
    }
    const updated = await repos.a2aCredentials.updateStatus(
      credentialId,
      A2A_CREDENTIAL_STATUS.REVOKED,
    );
    return publicCredentialView(updated);
  }
}

/**
 * @param {object | null} cred
 */
export function publicCredentialView(cred) {
  if (!cred) return null;
  return {
    credentialId: cred.credentialId,
    orgId: cred.orgId,
    agentId: cred.agentId,
    serviceUserId: cred.serviceUserId,
    clientId: cred.clientId,
    keyId: cred.keyId,
    scopes: cred.scopes,
    status: cred.status,
    expiresAt: cred.expiresAt,
    rotatedFromId: cred.rotatedFromId ?? null,
    lastUsedAt: cred.lastUsedAt ?? null,
    createdAt: cred.createdAt,
    updatedAt: cred.updatedAt,
  };
}

export { mapA2aCredential, parseBearerToken, verifyTokenHash, hashA2aToken };
