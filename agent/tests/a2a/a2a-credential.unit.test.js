/**
 * PR-12: API credential hash storage, constant-time verify, rotation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashA2aToken,
  constantTimeEqualHex,
  formatBearerToken,
  parseBearerToken,
  verifyTokenHash,
  mintKeyId,
  mintSecret,
  A2A_CREDENTIAL_STATUS,
} from '../../src/infrastructure/mysql/repositories/a2a-credential-repository.js';
import {
  A2aCredentialService,
  A2aAuthError,
  publicCredentialView,
} from '../../src/application/a2a/credential-service.js';
import { ValidationError } from '../../src/application/errors.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN4A';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CRED = '01K0G2PAV8FPMVC9QHJG7JPN5C';

describe('token crypto helpers', () => {
  it('formats and parses bearer tokens', () => {
    const keyId = mintKeyId();
    const secret = mintSecret();
    const token = formatBearerToken(keyId, secret);
    const parsed = parseBearerToken(`Bearer ${token}`);
    assert.ok(parsed);
    assert.equal(parsed.keyId, keyId);
    assert.equal(parsed.token, token);
  });

  it('rejects malformed tokens', () => {
    assert.equal(parseBearerToken('not-a-token'), null);
    assert.equal(parseBearerToken('a2a_short_x'), null);
  });

  it('hash is deterministic; verify is constant-time equal', () => {
    const token = formatBearerToken(mintKeyId(), mintSecret());
    const h1 = hashA2aToken(token);
    const h2 = hashA2aToken(token);
    assert.equal(h1, h2);
    assert.equal(h1.length, 64);
    assert.equal(verifyTokenHash(token, h1), true);
    assert.equal(verifyTokenHash(token + 'x', h1), false);
    assert.equal(constantTimeEqualHex(h1, h2), true);
    assert.equal(constantTimeEqualHex(h1, '0'.repeat(64)), false);
  });

  it('publicCredentialView never exposes secretHash', () => {
    const view = publicCredentialView({
      credentialId: CRED,
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'client-a',
      keyId: 'a'.repeat(16),
      secretHash: 'b'.repeat(64),
      scopes: ['agent.read'],
      status: 'active',
      expiresAt: null,
      rotatedFromId: null,
      lastUsedAt: null,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    });
    assert.equal(view.secretHash, undefined);
    assert.equal(view.keyId, 'a'.repeat(16));
  });
});

describe('A2aCredentialService issue / authenticate / rotate', () => {
  function makeStore() {
    /** @type {Map<string, object>} */
    const byId = new Map();
    /** @type {Map<string, object>} */
    const byKey = new Map();
    return {
      byId,
      byKey,
      createRepositories() {
        return {
          a2aCredentials: {
            async insert(input) {
              const row = {
                credentialId: input.credentialId,
                orgId: input.orgId,
                agentId: input.agentId,
                serviceUserId: input.serviceUserId,
                clientId: input.clientId,
                keyId: input.keyId,
                secretHash: input.secretHash,
                scopes: input.scopes,
                status: input.status,
                expiresAt: input.expiresAt
                  ? new Date(input.expiresAt).toISOString()
                  : null,
                rotatedFromId: input.rotatedFromId ?? null,
                lastUsedAt: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              };
              byId.set(row.credentialId, row);
              byKey.set(row.keyId, row);
              return row;
            },
            async getById(id) {
              return byId.get(id) || null;
            },
            async getByKeyId(keyId) {
              return byKey.get(keyId.toLowerCase()) || null;
            },
            async updateStatus(id, status) {
              const row = byId.get(id);
              if (!row) throw new Error('missing');
              row.status = status;
              row.updatedAt = new Date().toISOString();
              return row;
            },
            async touchLastUsed(id) {
              const row = byId.get(id);
              if (row) row.lastUsedAt = new Date().toISOString();
            },
          },
        };
      },
    };
  }

  it('issues token once; stores only hash; authenticates with constant-time verify', async () => {
    const store = makeStore();
    let n = 0;
    const svc = new A2aCredentialService({
      createRepositories: store.createRepositories,
      generateId: () => CRED,
      now: () => new Date('2026-07-18T00:00:00.000Z'),
      allowNonTransactionalRotate: true,
    });
    const issued = await svc.issue({
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'client-a',
    });
    assert.ok(issued.token.startsWith('a2a_'));
    const stored = store.byId.get(CRED);
    assert.ok(stored);
    assert.equal(stored.secretHash, hashA2aToken(issued.token));
    assert.notEqual(stored.secretHash, issued.token);

    const principal = await svc.authenticate(`Bearer ${issued.token}`, {
      agentId: AGENT,
      requiredScope: 'agent.invoke',
    });
    assert.equal(principal.clientId, 'client-a');
    assert.equal(principal.orgId, ORG);
    assert.equal(principal.callerType, 'a2a');

    await assert.rejects(
      () => svc.authenticate('Bearer a2a_ffffffffffffffff_' + '0'.repeat(64)),
      (e) => e instanceof A2aAuthError,
    );
  });

  it('rotation invalidates old token and issues a new one', async () => {
    const store = makeStore();
    let seq = 0;
    const ids = [CRED, '01K0G2PAV8FPMVC9QHJG7JPN5D'];
    const svc = new A2aCredentialService({
      createRepositories: store.createRepositories,
      generateId: () => ids[seq++] || `01K0G2PAV8FPMVC9QHJG7JPN5${seq}`,
      now: () => new Date('2026-07-18T00:00:00.000Z'),
      allowNonTransactionalRotate: true,
    });
    const first = await svc.issue({
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'client-a',
    });
    const rotated = await svc.rotate({
      credentialId: CRED,
      orgId: ORG,
    });
    assert.notEqual(rotated.token, first.token);
    assert.equal(store.byId.get(CRED).status, A2A_CREDENTIAL_STATUS.ROTATED);

    await assert.rejects(
      () => svc.authenticate(`Bearer ${first.token}`, { agentId: AGENT }),
      (e) => e instanceof A2aAuthError,
    );
    const principal = await svc.authenticate(`Bearer ${rotated.token}`, {
      agentId: AGENT,
    });
    assert.equal(principal.clientId, 'client-a');
  });

  it('rotate without transaction manager fails closed (non-test)', async () => {
    const store = makeStore();
    const svc = new A2aCredentialService({
      createRepositories: store.createRepositories,
      generateId: () => CRED,
      // no transactionManager, no allowNonTransactionalRotate
    });
    await svc.issue({
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'client-a',
    });
    await assert.rejects(
      () => svc.rotate({ credentialId: CRED, orgId: ORG }),
      (e) => e instanceof ValidationError && /transaction/i.test(e.message),
    );
    assert.equal(store.byId.get(CRED).status, A2A_CREDENTIAL_STATUS.ACTIVE);
  });

  it('agent binding mismatch fails closed without leaking', async () => {
    const store = makeStore();
    const svc = new A2aCredentialService({
      createRepositories: store.createRepositories,
      generateId: () => CRED,
    });
    const issued = await svc.issue({
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'client-a',
    });
    await assert.rejects(
      () =>
        svc.authenticate(`Bearer ${issued.token}`, {
          agentId: '01K0G2PAV8FPMVC9QHJG7JPN4B',
        }),
      (e) => e instanceof A2aAuthError && e.code === 'A2A_AUTH_AGENT_MISMATCH',
    );
  });
});
