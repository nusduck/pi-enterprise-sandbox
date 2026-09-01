import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';

describe('Skill enablement HTTP', () => {
  let server;
  let port;
  const calls = [];

  before(async () => {
    server = createAgentHttpServer({
      createRunService: { execute: async () => ({}) },
      getRunService: { execute: async () => ({}) },
      cancelRunService: { execute: async () => ({}) },
      eventQueryService: { listEvents: async () => ({ events: [] }) },
      mutateSkill: async (input) => {
        calls.push(input);
        return { name: input.name, enabled: input.action === 'enable' };
      },
      getExtensionDiagnostics: async () => ({
        status: 'ok',
        skills: [],
        skill_drafts: [{ name: 'draft-one', source: 'draft-skill-root', enabled: false }],
      }),
      config: { ALLOW_UNAUTHENTICATED_INTERNAL: true },
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const headers = {
    'X-Acting-User-Id': 'external-user',
    'X-Acting-Organization-Id': 'external-org',
  };

  it('awaits asynchronous owner-scoped diagnostics', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/internal/extensions/diagnostics`,
      { headers },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.skill_drafts[0].name, 'draft-one');
  });

  it('enables and disables a named draft under trusted acting identity', async () => {
    for (const action of ['enable', 'disable']) {
      const response = await fetch(
        `http://127.0.0.1:${port}/internal/skills/draft-one/${action}`,
        { method: 'POST', headers },
      );
      assert.equal(response.status, 200);
      assert.equal((await response.json()).enabled, action === 'enable');
    }
    assert.deepEqual(
      calls.map(({ action, name, auth }) => [action, name, auth.externalUserId]),
      [
        ['enable', 'draft-one', 'external-user'],
        ['disable', 'draft-one', 'external-user'],
      ],
    );
  });

  it('rejects a mutation without trusted acting identity', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/internal/skills/draft-one/enable`,
      { method: 'POST' },
    );
    assert.equal(response.status, 400);
  });
});
