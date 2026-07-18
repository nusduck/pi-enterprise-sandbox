import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;

process.env.AUTH_ENABLED = 'true';
process.env.SANDBOX_BASE_URL = 'http://sandbox.test';
process.env.AGENT_BASE_URL = 'http://agent.test';

const { authorizeRunRequest, resolveTrustedAuth } = await import(
  `../application/run-access-service.js?test=${Date.now()}`
);

function request(token = 'valid-user-token') {
  return { headers: { authorization: `Bearer ${token}` } };
}

describe('trusted Run request identity', () => {
  before(() => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === 'http://sandbox.test/auth/me') {
        return new Response(JSON.stringify({
          id: 'user_a',
          organization_id: 'org_a',
          role: 'user',
          username: 'alice',
        }), { status: 200 });
      }
      // PR-13 / PR-04: Run ownership is Agent MySQL owner scope (not Sandbox /agent-runs).
      if (url === 'http://agent.test/internal/agent-runs/run_a') {
        return new Response(JSON.stringify({
          run_id: 'run_a',
          conversation_id: 'conv_a',
          user_id: 'user_a',
          org_id: 'org_a',
          status: 'running',
        }), { status: 200 });
      }
      if (url === 'http://agent.test/internal/agent-runs/run_other') {
        // Agent maps foreign/unknown runs to 404 (no existence leak).
        return new Response(JSON.stringify({ error: 'Run not found' }), { status: 404 });
      }
      if (url === 'http://sandbox.test/conversations/conv_a') {
        return new Response(JSON.stringify({ id: 'conv_a' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('resolves actor only after sandbox token verification', async () => {
    const auth = await resolveTrustedAuth(request());
    assert.equal(auth.actingUserId, 'user_a');
    assert.equal(auth.actingOrganizationId, 'org_a');
    assert.equal(auth.actingRole, 'user');
  });

  it('allows an owned run and rejects a different owner without leaking it', async () => {
    const allowed = await authorizeRunRequest('run_a', request());
    assert.equal(allowed.run.run_id, 'run_a');
    await assert.rejects(
      authorizeRunRequest('run_other', request()),
      (error) => error?.status === 404 && /not found/i.test(String(error?.message || '')),
    );
  });
});
