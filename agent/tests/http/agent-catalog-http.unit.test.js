/**
 * `/internal/agents` 的路由接线：可信身份、方法分派、领域错误 → HTTP 状态。
 *
 * 归属判定与角色闸门在 `AgentCatalogService`（见
 * `tests/run-services/agent-catalog-service.unit.test.js`）；这里只证明它们的
 * 结果确实以正确的状态码到达调用方。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';
import {
  AdminRoleRequiredError,
  OwnerScopedNotFoundError,
} from '../../src/application/errors.js';

const HEADERS = {
  'X-Acting-User-Id': 'external-user',
  'X-Acting-Organization-Id': 'external-org',
  'Content-Type': 'application/json',
};

function baseDeps(agentCatalogService) {
  return {
    createRunService: { execute: async () => ({}) },
    getRunService: { execute: async () => ({}) },
    cancelRunService: { execute: async () => ({}) },
    eventQueryService: { listEvents: async () => ({ events: [] }) },
    config: { ALLOW_UNAUTHENTICATED_INTERNAL: true },
    agentCatalogService,
  };
}

async function listen(deps) {
  const server = createAgentHttpServer(deps);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

describe('Agent catalog HTTP', () => {
  let server;
  let port;
  const calls = [];

  before(async () => {
    const service = {
      async listAgents(auth, opts) {
        calls.push(['listAgents', auth.externalUserId, opts.limit ?? null]);
        return { agents: [] };
      },
      async createAgent(auth, body) {
        calls.push(['createAgent', auth.role, body.name]);
        if (auth.role !== 'admin') throw new AdminRoleRequiredError();
        return { agent: { agent_id: 'A' }, version: { version_no: 1 } };
      },
      async listVersions(_auth, agentId) {
        if (agentId !== 'owned') {
          throw new OwnerScopedNotFoundError('Agent not found', {
            resource: 'agent_definitions',
            id: agentId,
          });
        }
        return { agent: { agent_id: agentId }, versions: [] };
      },
      async createVersion(_auth, agentId, body) {
        calls.push(['createVersion', agentId, body.activate]);
        return { agent: { agent_id: agentId }, version: { version_no: 2 } };
      },
      async setActiveVersion(_auth, agentId, agentVersionId) {
        calls.push(['setActiveVersion', agentId, agentVersionId]);
        return { agent: { agent_id: agentId }, version: { version_no: 1 } };
      },
    };
    ({ server, port } = await listen(baseDeps(service)));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const url = (path) => `http://127.0.0.1:${port}${path}`;

  it('lists agents under a trusted acting identity', async () => {
    const response = await fetch(url('/internal/agents?limit=10'), { headers: HEADERS });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { agents: [] });
    assert.deepEqual(calls.at(-1), ['listAgents', 'external-user', 10]);
  });

  it('rejects any catalog call without trusted acting subjects', async () => {
    for (const [method, path] of [
      ['GET', '/internal/agents'],
      ['POST', '/internal/agents'],
      ['GET', '/internal/agents/owned/versions'],
      ['POST', '/internal/agents/owned/active-version'],
    ]) {
      const response = await fetch(url(path), { method });
      assert.equal(response.status, 400, `${method} ${path}`);
      assert.equal((await response.json()).code, 'AUTH_CONTEXT_REQUIRED');
    }
  });

  it('surfaces the admin gate as 403, not 400', async () => {
    const response = await fetch(url('/internal/agents'), {
      method: 'POST',
      headers: { ...HEADERS, 'X-Acting-Role': 'user' },
      body: JSON.stringify({ name: 'nope' }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'ADMIN_REQUIRED');
  });

  it('creates an agent for an admin', async () => {
    const response = await fetch(url('/internal/agents'), {
      method: 'POST',
      headers: { ...HEADERS, 'X-Acting-Role': 'admin' },
      body: JSON.stringify({ name: '数据分析助手' }),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).agent.agent_id, 'A');
  });

  it('answers 404 for an agent outside the caller tenant', async () => {
    const response = await fetch(url('/internal/agents/foreign/versions'), {
      headers: { ...HEADERS, 'X-Acting-Role': 'admin' },
    });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.code, 'NOT_FOUND');
    // 响应体不得泄漏该 Agent 是否存在，也不得回显请求里的 id。
    assert.equal(body.error, 'Agent not found');
    assert.equal(JSON.stringify(body).includes('foreign'), false);
  });

  it('routes version creation and activation to the catalog service', async () => {
    const created = await fetch(url('/internal/agents/owned/versions'), {
      method: 'POST',
      headers: { ...HEADERS, 'X-Acting-Role': 'admin' },
      body: JSON.stringify({ config: {}, activate: false }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(calls.at(-1), ['createVersion', 'owned', false]);

    const activated = await fetch(url('/internal/agents/owned/active-version'), {
      method: 'POST',
      headers: { ...HEADERS, 'X-Acting-Role': 'admin' },
      body: JSON.stringify({ agent_version_id: 'V1' }),
    });
    assert.equal(activated.status, 200);
    assert.deepEqual(calls.at(-1), ['setActiveVersion', 'owned', 'V1']);
  });

  it('rejects a malformed JSON body before reaching the service', async () => {
    const response = await fetch(url('/internal/agents'), {
      method: 'POST',
      headers: { ...HEADERS, 'X-Acting-Role': 'admin' },
      body: '{',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'VALIDATION');
  });
});

describe('Agent catalog HTTP without the catalog service', () => {
  it('fails closed with 503 rather than 404-by-omission', async () => {
    const { server, port } = await listen(baseDeps(null));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/internal/agents`, {
        headers: HEADERS,
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'DEPENDENCY');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
