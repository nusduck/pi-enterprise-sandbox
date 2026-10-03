/**
 * POST /api/auth/logout outcome classification (design §5.2 / §6).
 * Run: npx tsx --test tests/auth-revocation.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyLogoutResponse } from '../src/application/auth-revocation.js';

describe('classifyLogoutResponse', () => {
  it('maps a confirmed revocation to 200 confirmed', () => {
    assert.deepEqual(
      classifyLogoutResponse({ status: 200, body: { ok: true, revocation: 'confirmed' } }),
      { status: 200, body: { ok: true, revocation: 'confirmed' } },
    );
  });

  it('maps an idempotent not_required revocation to 200 not_required', () => {
    assert.deepEqual(
      classifyLogoutResponse({ status: 200, body: { ok: true, revocation: 'not_required' } }),
      { status: 200, body: { ok: true, revocation: 'not_required' } },
    );
  });

  it('maps an invalid/expired credential (coded 401) to not_required', () => {
    assert.deepEqual(
      classifyLogoutResponse({ status: 401, body: { error: 'invalid token', code: 'INVALID_TOKEN' } }),
      { status: 200, body: { ok: true, revocation: 'not_required' } },
    );
  });

  it('never treats an internal-token-gate 401 as a successful revocation', () => {
    // Wrong AGENT_INTERNAL_TOKEN: the Agent gate answers 401 without a code.
    assert.equal(
      classifyLogoutResponse({ status: 401, body: { error: 'Invalid or missing internal token' } })
        .body.code,
      'AUTH_REVOCATION_UNCONFIRMED',
    );
    assert.equal(
      classifyLogoutResponse({
        status: 401,
        body: { error: 'Internal plane authentication is not configured', code: 'INTERNAL_AUTH_NOT_CONFIGURED' },
      }).body.code,
      'AUTH_REVOCATION_UNCONFIRMED',
    );
    // Any other coded 401 is not a documented "nothing to revoke" class either.
    assert.equal(
      classifyLogoutResponse({ status: 401, body: { error: 'nope', code: 'SOMETHING_ELSE' } })
        .body.code,
      'AUTH_REVOCATION_UNCONFIRMED',
    );
  });

  it('maps a legacy pre-sid 409 to 503 unconfirmed (no compat branch)', () => {
    const decision = classifyLogoutResponse({
      status: 409,
      body: { error: 'Legacy session cannot be revoked', code: 'LEGACY_SESSION_NOT_REVOCABLE' },
    });
    assert.equal(decision.status, 503);
    assert.equal(decision.body.code, 'AUTH_REVOCATION_UNCONFIRMED');
    assert.notEqual(decision.body.ok, true);
  });

  it('does not turn an unrecognized upstream 200 into success', () => {
    const decision = classifyLogoutResponse({ status: 200, body: { ok: true } });
    assert.equal(decision.status, 503);
    assert.equal(decision.body.code, 'AUTH_REVOCATION_UNCONFIRMED');
  });

  it('does not treat upstream failures or missing endpoints as not_required', () => {
    for (const status of [500, 502, 503, 504, 404, 403, 400]) {
      const decision = classifyLogoutResponse({ status, body: { error: 'boom' } });
      assert.equal(decision.status, 503, `status ${status}`);
      assert.equal(decision.body.code, 'AUTH_REVOCATION_UNCONFIRMED');
    }
  });

  it('maps transport failure (no response) to 503 unconfirmed', () => {
    const decision = classifyLogoutResponse(null);
    assert.equal(decision.status, 503);
    assert.equal(decision.body.code, 'AUTH_REVOCATION_UNCONFIRMED');
  });

  it('never reports ok:true on the unconfirmed branches', () => {
    for (const upstream of [null, { status: 500 }, { status: 200, body: {} }]) {
      assert.notEqual(classifyLogoutResponse(upstream).body.ok, true);
    }
  });
});
