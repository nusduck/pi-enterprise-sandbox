/**
 * BFF-side Sandbox routing.
 *
 * The Sandbox is sharded, so session-scoped calls have to reach the replica
 * that holds the workspace. The BFF has no database of its own — deliberately —
 * so it asks the Agent, then dials the owner directly rather than proxying
 * streams through it.
 *
 * The behaviour that matters most is the fallback: routing is best-effort, and
 * a wrong guess is refused by the Sandbox with 409 rather than answered
 * incorrectly. So failing to resolve must never fail the request here.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import {
  _clearPlacementCache,
  invalidateSandboxPlacement,
  resolveSandboxBaseUrl,
} from '../src/services/sandbox-placement.js';

const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN54';
const AUTH = {
  organizationId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN51',
};
const OWNER = 'http://sandbox-2.sandbox-headless.pi.svc.cluster.local:8081';

function stubFetch(handler) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('sandbox placement resolution', () => {
  beforeEach(() => _clearPlacementCache());

  it('routes to the replica the Agent names', async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ nodeId: 'sandbox-2', baseUrl: OWNER }),
    );

    const base = await resolveSandboxBaseUrl(SESSION, AUTH, { fetchImpl });

    assert.equal(base, OWNER);
    assert.match(calls[0].url, /\/internal\/sandbox-placement\?/);
    assert.match(calls[0].url, new RegExp(SESSION));
    // Looked up under owner scope, so one tenant cannot learn another's shard.
    assert.equal(calls[0].init.headers['X-Acting-User-Id'], AUTH.userId);
    assert.equal(
      calls[0].init.headers['X-Acting-Organization-Id'],
      AUTH.organizationId,
    );
  });

  it('caches so every file request does not re-ask', async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ nodeId: 'sandbox-2', baseUrl: OWNER }),
    );

    await resolveSandboxBaseUrl(SESSION, AUTH, { fetchImpl });
    await resolveSandboxBaseUrl(SESSION, AUTH, { fetchImpl });
    await resolveSandboxBaseUrl(SESSION, AUTH, { fetchImpl });

    // Placement is immutable for a session's lifetime.
    assert.equal(calls.length, 1);
  });

  it('expires the cache so a re-placed session is not pinned', async () => {
    let now = 1_000;
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ nodeId: 'sandbox-2', baseUrl: OWNER }),
    );

    await resolveSandboxBaseUrl(SESSION, AUTH, {
      fetchImpl,
      ttlMs: 100,
      now: () => now,
    });
    now += 101;
    await resolveSandboxBaseUrl(SESSION, AUTH, {
      fetchImpl,
      ttlMs: 100,
      now: () => now,
    });

    assert.equal(calls.length, 2);
  });

  it('never serves one tenant the answer cached for another', async () => {
    const { fetchImpl, calls } = stubFetch((url) =>
      jsonResponse({
        nodeId: 'sandbox-2',
        baseUrl: url.includes(AUTH.userId) ? OWNER : 'http://other:8081',
      }),
    );

    await resolveSandboxBaseUrl(SESSION, AUTH, { fetchImpl });
    const otherTenant = {
      organizationId: '01K0G2PAV8FPMVC9QHJG7JPN60',
      userId: '01K0G2PAV8FPMVC9QHJG7JPN61',
    };
    await resolveSandboxBaseUrl(SESSION, otherTenant, { fetchImpl });

    assert.equal(calls.length, 2, 'the cache key must include the actor');
  });

  it('falls back to the service address for an unplaced session', async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({ nodeId: null, baseUrl: null }),
    );

    // Unplaced is normal before ensure has run, and ensure is the one call any
    // replica may answer.
    const base = await resolveSandboxBaseUrl(SESSION, AUTH, { fetchImpl });
    assert.equal(base, config.SANDBOX_BASE_URL);
  });

  it('falls back when the Agent cannot answer', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ error: 'x' }, 503));
    assert.equal(
      await resolveSandboxBaseUrl(SESSION, AUTH, { fetchImpl }),
      config.SANDBOX_BASE_URL,
    );
  });

  it('falls back when the lookup throws', async () => {
    const fetchImpl = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    // Routing is best-effort: a wrong guess is refused by the Sandbox with a
    // 409, never answered incorrectly, so failing open is safe here.
    assert.equal(
      await resolveSandboxBaseUrl(SESSION, AUTH, { fetchImpl }),
      config.SANDBOX_BASE_URL,
    );
  });

  it('does not look up without an actor', async () => {
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({}));

    const base = await resolveSandboxBaseUrl(SESSION, null, { fetchImpl });

    assert.equal(base, config.SANDBOX_BASE_URL);
    assert.equal(calls.length, 0, 'placement is owner-scoped; no actor, no query');
  });

  it('does not cache a failure', async () => {
    let fail = true;
    const { fetchImpl, calls } = stubFetch(() =>
      fail
        ? jsonResponse({ error: 'x' }, 503)
        : jsonResponse({ nodeId: 'sandbox-2', baseUrl: OWNER }),
    );

    assert.equal(
      await resolveSandboxBaseUrl(SESSION, AUTH, { fetchImpl }),
      config.SANDBOX_BASE_URL,
    );
    fail = false;
    assert.equal(await resolveSandboxBaseUrl(SESSION, AUTH, { fetchImpl }), OWNER);
    assert.equal(calls.length, 2);
  });

  it('can be invalidated after a placement mismatch', async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      jsonResponse({ nodeId: 'sandbox-2', baseUrl: OWNER }),
    );
    await resolveSandboxBaseUrl(SESSION, AUTH, { fetchImpl });

    invalidateSandboxPlacement(SESSION, AUTH);
    await resolveSandboxBaseUrl(SESSION, AUTH, { fetchImpl });

    assert.equal(calls.length, 2);
  });
});
