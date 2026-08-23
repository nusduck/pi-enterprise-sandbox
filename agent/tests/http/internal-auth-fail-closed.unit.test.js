/**
 * /internal/* trusts the caller's X-Acting-* headers completely: whatever
 * subject they name is the tenant the request acts as. That is only safe
 * behind the internal token.
 *
 * Reproduction: with AGENT_INTERNAL_TOKEN unset, `enforceInternalAuth`
 * returned true for everyone, so an unauthenticated caller reaching this port
 * could list, read and act on any tenant's data by naming their subject. The
 * dev stack ships with an empty token, so the exposure was the default rather
 * than an accident.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';

const VICTIM = 'user-ext-victim';

function services() {
  return {
    createRunService: { execute: async () => ({}) },
    getRunService: { execute: async () => ({}) },
    cancelRunService: { execute: async () => ({}) },
    eventQueryService: { listEvents: async () => ({ events: [] }) },
    conversationService: {
      async list(auth) {
        return [{ id: 'conv-of', owner: auth.externalUserId }];
      },
    },
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

/** Impersonation attempt: no credential, just a named subject. */
async function impersonate(port, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/internal/conversations`, {
    headers: {
      'X-Acting-User-Id': VICTIM,
      'X-Acting-Organization-Id': 'org-ext-1',
      ...headers,
    },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

describe('internal plane authentication', () => {
  const servers = [];

  before(() => {});
  after(async () => {
    for (const server of servers) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  async function start(config) {
    const server = createAgentHttpServer({ ...services(), config });
    servers.push(server);
    return listen(server);
  }

  it('closes the plane when no token is configured', async () => {
    const port = await start({});
    const result = await impersonate(port);
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'INTERNAL_AUTH_NOT_CONFIGURED');
  });

  it('opens it only for an explicit development opt-in', async () => {
    const port = await start({ ALLOW_UNAUTHENTICATED_INTERNAL: true });
    const result = await impersonate(port);
    assert.equal(result.status, 200);
    assert.equal(result.body[0].owner, VICTIM);
  });

  it('requires the exact token once one is configured', async () => {
    const port = await start({ AGENT_INTERNAL_TOKEN: 'correct-horse-battery-staple' });

    assert.equal((await impersonate(port)).status, 401);
    assert.equal(
      (await impersonate(port, { 'X-Internal-Token': 'wrong' })).status,
      401,
    );
    // A prefix must not pass: comparison is length-checked before the
    // constant-time compare, which throws on unequal buffers.
    assert.equal(
      (await impersonate(port, { 'X-Internal-Token': 'correct-horse' })).status,
      401,
    );
    assert.equal(
      (
        await impersonate(port, {
          'X-Internal-Token': 'correct-horse-battery-staple',
        })
      ).status,
      200,
    );
  });

  it('an opt-in cannot be smuggled past production validation', async () => {
    const { validateProductionConfig } = await import('../../config.js');
    assert.throws(
      () =>
        validateProductionConfig({
          DEPLOYMENT_ENV: 'production',
          AGENT_INTERNAL_TOKEN: 'x'.repeat(40),
          SANDBOX_API_TOKEN: 'y'.repeat(40),
          AGENT_ALLOW_UNAUTHENTICATED_INTERNAL: 'true',
        }),
      /AGENT_ALLOW_UNAUTHENTICATED_INTERNAL/,
    );
  });
});
