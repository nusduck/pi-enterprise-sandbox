/**
 * AUTH_ENABLED / protected path helpers.
 * Run: node --test api-server/tests/auth-config.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAuthEnabled,
  isPublicApiPath,
  isProtectedApiPath,
} from '../config.js';
import { authFromRequest } from '../services/sandbox-client.js';

describe('resolveAuthEnabled', () => {
  it('defaults to false', () => {
    assert.equal(resolveAuthEnabled({}), false);
  });

  it('reads AUTH_ENABLED over SANDBOX_AUTH_ENABLED', () => {
    assert.equal(resolveAuthEnabled({ AUTH_ENABLED: 'true' }), true);
    assert.equal(resolveAuthEnabled({ AUTH_ENABLED: 'false', SANDBOX_AUTH_ENABLED: 'true' }), false);
    assert.equal(resolveAuthEnabled({ SANDBOX_AUTH_ENABLED: 'true' }), true);
  });
});

describe('isProtectedApiPath', () => {
  it('protects conversations/chat/files; leaves status and auth public', () => {
    assert.equal(isPublicApiPath('/api/status'), true);
    assert.equal(isPublicApiPath('/api/auth/login'), true);
    assert.equal(isProtectedApiPath('/api/status'), false);
    assert.equal(isProtectedApiPath('/api/auth/login'), false);
    assert.equal(isProtectedApiPath('/api/conversations'), true);
    assert.equal(isProtectedApiPath('/api/chat'), true);
    assert.equal(isProtectedApiPath('/api/files/upload'), true);
  });
});

describe('authFromRequest', () => {
  it('forwards Bearer and strips acting headers from browser', () => {
    const req = {
      headers: {
        authorization: 'Bearer user-jwt-token',
        'x-acting-user-id': 'evil',
        'x-acting-organization-id': 'evil-org',
      },
    };
    const auth = authFromRequest(req);
    assert.equal(auth.authorization, 'Bearer user-jwt-token');
    assert.equal(auth.actingUserId, undefined);
    assert.equal(auth.actingOrganizationId, undefined);
  });

  it('returns empty for missing auth', () => {
    assert.deepEqual(authFromRequest({ headers: {} }), {});
    assert.deepEqual(authFromRequest(null), {});
  });
});
