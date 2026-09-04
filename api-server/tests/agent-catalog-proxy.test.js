/**
 * `/api/agents` 的 BFF 侧：纯转发 + 鉴权投影。
 *
 * 这一层**不做任何目录状态判断**——归属、活跃版本、角色都是 agent/ 的权威事实
 * （AGENTS.md §1）。所以这里能测的只有三件事：路径受保护、身份头由服务端写入、
 * Agent 的错误状态码原样传回浏览器。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isProtectedApiPath } from '../src/config.js';
import { normalizeCreateRunBody } from '../src/routes/runs.js';
import {
  listAgentDefinitions,
  createAgentDefinition,
  setAgentDefinitionActiveVersion,
} from '../src/services/agent-catalog-client.js';

const AUTH = {
  actingUserId: 'user-1',
  actingOrganizationId: 'org-1',
  actingRole: 'admin',
};

/** 换掉全局 fetch：agentFetch 是 ESM 命名空间导出，无法被重定义。 */
function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('/api/agents is an authenticated surface', () => {
  it('requires browser auth like every other owner-scoped route', () => {
    assert.equal(isProtectedApiPath('/api/agents'), true);
    assert.equal(isProtectedApiPath('/api/agents/AGENT/versions'), true);
    assert.equal(isProtectedApiPath('/api/agents/AGENT/active-version'), true);
  });
});

describe('Agent catalog client', () => {
  it('projects the resolved identity into X-Acting-* and never trusts the body', async (t) => {
    const seen = [];
    const restore = stubFetch(async (url, init) => {
      seen.push({ url: String(url), init });
      return jsonResponse(200, { agents: [] });
    });
    t.after(restore);

    await listAgentDefinitions({ limit: 25 }, { auth: AUTH, traceId: null });

    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/internal\/agents\?limit=25$/);
    assert.equal(seen[0].init.headers['X-Acting-User-Id'], 'user-1');
    assert.equal(seen[0].init.headers['X-Acting-Organization-Id'], 'org-1');
    assert.equal(seen[0].init.headers['X-Acting-Role'], 'admin');
  });

  it('forwards the create body verbatim', async (t) => {
    let sent = null;
    const restore = stubFetch(async (_url, init) => {
      sent = JSON.parse(init.body);
      return jsonResponse(201, { agent: {}, version: {} });
    });
    t.after(restore);

    await createAgentDefinition(
      { name: '数据分析助手', config: { systemPrompt: 'x' } },
      { auth: AUTH },
    );
    assert.deepEqual(sent, {
      name: '数据分析助手',
      config: { systemPrompt: 'x' },
    });
  });

  it('preserves the Agent status code so cross-tenant stays 404, not 500', async (t) => {
    const restore = stubFetch(async () =>
      jsonResponse(404, { error: 'Agent not found', code: 'NOT_FOUND' }),
    );
    t.after(restore);

    await assert.rejects(
      () => setAgentDefinitionActiveVersion('FOREIGN', { agent_version_id: 'V' }, { auth: AUTH }),
      (err) => {
        assert.equal(err.status, 404);
        assert.equal(err.code, 'NOT_FOUND');
        assert.equal(err.message, 'Agent not found');
        return true;
      },
    );
  });
});

describe('create-run body carries the selected agent', () => {
  it('passes agent_id through in both wire spellings', () => {
    const snake = normalizeCreateRunBody({
      messages: [{ role: 'user', content: 'hi' }],
      agent_id: 'AGENT_ULID',
    });
    const camel = normalizeCreateRunBody({
      messages: [{ role: 'user', content: 'hi' }],
      agentId: 'AGENT_ULID',
    });
    assert.equal(snake.agent_id, 'AGENT_ULID');
    assert.equal(camel.agent_id, 'AGENT_ULID');
  });

  it('omits agent_id when the caller did not choose one', () => {
    const normalized = normalizeCreateRunBody({
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(normalized.agent_id, undefined);
  });
});
