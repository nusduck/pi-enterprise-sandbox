/**
 * `/api/a2a/*` 管理面的角色闸门（design rbac-roles §4.2/§4.3）。
 *
 * 这条用例走的是**生产身份路径**：BFF 先经 Agent 的 `/internal/auth/me` 拿 `roles`，
 * 再把 `X-Acting-Role` 拼成**逗号集合**写给下游，最后用同一个集合判本地的 admin 闸门。
 * 单独测 `hasRole()` 证明不了这条链——「`me.roles` 有没有接上」只有真跑一遍才知道。
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

const { handleGetA2aConfig } = await import(`../src/routes/a2a.js?test=${Date.now()}`);

const ME = '01K0G2PAV8FPMVC9QHJG7JPN50';
const ORG = '01K0G2PAV8FPMVC9QHJG7JPN51';
const calls = [];
/** 每个用例自己决定 `/internal/auth/me` 返回什么角色。 */
let meRoles = ['admin'];
let meFailure = null;

function responseCapture() {
  const captured = { statusCode: 0, body: '', headers: {} };
  return {
    captured,
    response: {
      headersSent: false,
      writeHead(status, headers) {
        captured.statusCode = status;
        captured.headers = headers || {};
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

/** 只带 Authorization 的请求：角色由服务端解析，浏览器声明不了。 */
const BROWSER_REQUEST = { method: 'GET', headers: { authorization: 'Bearer browser-token' }, requestId: 'req-1' };

before(() => {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, search: url.search, headers: init.headers || {} });
    if (url.pathname === '/internal/auth/me') {
      if (meFailure) return new Response(JSON.stringify(meFailure.body), { status: meFailure.status });
      return new Response(
        JSON.stringify({ id: ME, organization_id: ORG, username: 'alice', roles: meRoles }),
        { status: 200 },
      );
    }
    if (url.pathname === '/internal/a2a/config') {
      return new Response(JSON.stringify({ agent_id: null, credentials: [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('/api/a2a/* 管理面的角色闸门', () => {
  it('me.roles 含 admin 时放行，并把逗号集合写给下游', async () => {
    meRoles = ['admin', 'reviewer'];
    meFailure = null;
    calls.length = 0;
    const { captured, response, json } = responseCapture();
    await handleGetA2aConfig(new URL('http://bff/api/a2a/config'), response, BROWSER_REQUEST);
    assert.equal(captured.statusCode, 200);
    assert.deepEqual(json(), { agent_id: null, credentials: [] });
    // 关键断言：wire 上真的是集合，而不是被压成单值。
    const downstream = calls.find((c) => c.path === '/internal/a2a/config');
    assert.equal(downstream.headers['X-Acting-Role'], 'admin,reviewer');
    assert.equal(downstream.headers['X-Acting-User-Id'], ME);
    assert.equal(downstream.headers['X-Acting-Organization-Id'], ORG);
  });

  it('只有 reviewer 时 403 ADMIN_REQUIRED，且不访问下游', async () => {
    meRoles = ['reviewer'];
    meFailure = null;
    calls.length = 0;
    const { captured, response, json } = responseCapture();
    await handleGetA2aConfig(new URL('http://bff/api/a2a/config'), response, BROWSER_REQUEST);
    assert.equal(captured.statusCode, 403);
    assert.equal(json().code, 'ADMIN_REQUIRED');
    assert.equal(calls.some((c) => c.path === '/internal/a2a/config'), false);
  });

  it('me 解析不出角色时同样 403（fail-closed）', async () => {
    meRoles = undefined;
    meFailure = null;
    calls.length = 0;
    const { captured, response, json } = responseCapture();
    await handleGetA2aConfig(new URL('http://bff/api/a2a/config'), response, BROWSER_REQUEST);
    assert.equal(captured.statusCode, 403);
    assert.equal(json().code, 'ADMIN_REQUIRED');
    assert.equal(calls.some((c) => c.path === '/internal/a2a/config'), false);
  });
});
