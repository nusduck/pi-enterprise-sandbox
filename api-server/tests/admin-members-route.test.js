/**
 * `/api/admin/users*` 的 BFF 路由层（design rbac-roles §5）：路径段解码。
 *
 * 走**生产身份路径**（先经 Agent `/internal/auth/me`），与 `a2a-admin-role.test.js` 同一写法。
 * 这里只证明路由层对畸形路径的处理：非法百分号编码是 404，不是 500，也不转发给 Agent。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = {
  AGENT_BASE_URL: process.env.AGENT_BASE_URL,
  AUTH_ENABLED: process.env.AUTH_ENABLED,
};

process.env.AGENT_BASE_URL = 'http://agent.rbac.test';
process.env.AUTH_ENABLED = 'true';

const { handleAdminMembersRoute } = await import(`../src/routes/admin-members.js?test=${Date.now()}`);

const ME = '01K0G2PAV8FPMVC9QHJG7JPN50';
const ORG = '01K0G2PAV8FPMVC9QHJG7JPN51';
const calls = [];

function responseCapture() {
  const captured = { statusCode: 0, body: '' };
  return {
    captured,
    response: {
      headersSent: false,
      writeHead(status) {
        captured.statusCode = status;
      },
      end(body) {
        captured.body = body || '';
      },
    },
    json() {
      return captured.body ? JSON.parse(captured.body) : null;
    },
  };
}

const request = (method) => ({ method, headers: { authorization: 'Bearer browser-token' }, requestId: 'req-1' });

before(() => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === '/internal/auth/me') {
      return new Response(
        JSON.stringify({ id: ME, organization_id: ORG, username: 'alice', roles: ['admin'] }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ user_id: ME, roles: ['admin'], pinned_roles: [] }), { status: 200 });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('/api/admin/users* 路径段解码', () => {
  it('非法百分号编码是 404 NOT_FOUND，且不转发给 Agent 的管理面', async () => {
    for (const [method, path] of [
      ['PUT', '/api/admin/users/%E0/roles/admin'],
      ['DELETE', `/api/admin/users/${ME}/roles/%E0`],
      ['GET', '/api/admin/users/%/role-events'],
    ]) {
      calls.length = 0;
      const { captured, response, json } = responseCapture();
      const handled = await handleAdminMembersRoute(method, path, new URL(`http://bff${path}`), response, request(method));
      assert.equal(handled, true);
      assert.equal(captured.statusCode, 404, `${method} ${path}`);
      assert.equal(json().code, 'NOT_FOUND');
      assert.equal(calls.some((p) => p.startsWith('/internal/admin/members')), false);
    }
  });

  it('合法编码照常转发（正向对照）', async () => {
    calls.length = 0;
    const { captured, response } = responseCapture();
    const path = `/api/admin/users/${ME}/roles/reviewer`;
    await handleAdminMembersRoute('PUT', path, new URL(`http://bff${path}`), response, request('PUT'));
    assert.equal(captured.statusCode, 200);
    assert.ok(calls.includes(`/internal/admin/members/${ME}/roles/reviewer`));
  });
});
