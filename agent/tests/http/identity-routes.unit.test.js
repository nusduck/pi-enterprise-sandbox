/**
 * `GET /internal/identity/owner`：只解析已存在的映射，未映射 → 404，缺身份头 → 400。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handleIdentityRoute } from '../../src/presentation/http/identity-routes.js';
import { OwnerIdentityService } from '../../src/application/owner-identity-service.js';
import { OwnerScopedNotFoundError } from '../../src/application/errors.js';

function call(path, { method = 'GET', headers = { 'x-acting-user-id': 'u1', 'x-acting-organization-id': 'o1' }, service } = {}) {
  const res = { status: 0, body: null, writeHead(s) { this.status = s; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
  return handleIdentityRoute({ req: { method, headers }, res, path, ownerIdentityService: service }).then((handled) => ({ handled, res }));
}

describe('owner identity route', () => {
  const service = {
    async resolve(auth) {
      if (auth.externalUserId === 'unknown') throw new OwnerScopedNotFoundError('User mapping not found', { resource: 'users', id: 'x' });
      return { org_id: '01M29ZHZV8VF2G344QZFM9MKDN', user_id: '01M2T4AHKZFTPB5WYQD4M7YHDY' };
    },
  };

  it('returns the caller’s formal ids', async () => {
    const { handled, res } = await call('/internal/identity/owner', { service });
    assert.equal(handled, true);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { org_id: '01M29ZHZV8VF2G344QZFM9MKDN', user_id: '01M2T4AHKZFTPB5WYQD4M7YHDY' });
  });

  it('answers unmapped identities with 404 and missing headers with 400', async () => {
    const unknown = await call('/internal/identity/owner', { service, headers: { 'x-acting-user-id': 'unknown', 'x-acting-organization-id': 'o1' } });
    assert.equal(unknown.res.status, 404);
    assert.equal((await call('/internal/identity/owner', { service, headers: {} })).res.status, 400);
    assert.equal((await call('/internal/identity/owner', { service, method: 'POST' })).res.status, 405);
    assert.equal((await call('/internal/other', { service })).handled, false);
  });

  it('requires its dependencies', () => {
    assert.throws(() => new OwnerIdentityService({}), /requires db/);
  });
});
