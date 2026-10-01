/**
 * `/api/reviews*` 的 BFF 路由层（design `agent-output-review.md` §7）。
 *
 * 走**生产身份路径**（先经 Agent `/internal/auth/me`，与 `admin-members-route.test.js`
 * 同一写法）。这里证明的是 BFF 该管的部分：
 *
 * - 路径段解码：非法百分号编码是 404，不是 500，也不转发给 Agent；
 * - `X-Acting-Role` 由服务端从 `me.roles` 投影（浏览器声明不了自己的角色）；
 * - 驳回反馈必填在 BFF 就挡住（`REVIEW_FEEDBACK_REQUIRED`），不白跑一次往返；
 * - `base_revision` 非法给 422，不把 `NaN` 转发下去。
 *
 * 「谁能审、能不能审」在 agent/，这里不判（BFF 手上没有账本）。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = {
  AGENT_BASE_URL: process.env.AGENT_BASE_URL,
  AUTH_ENABLED: process.env.AUTH_ENABLED,
};

process.env.AGENT_BASE_URL = 'http://agent.review.test';
process.env.AUTH_ENABLED = 'true';

const { handleReviewsRoute } = await import(`../src/routes/reviews.js?test=${Date.now()}`);

const ME = '01K0G2PAV8FPMVC9QHJG7JPN50';
const ORG = '01K0G2PAV8FPMVC9QHJG7JPN51';
const TASK = '01K0G2PAV8FPMVC9QHJG7JPN70';
const calls = [];
/** 转发给 agent 的请求头，用于断言角色投影。 */
const agentHeaders = [];

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

const request = (method, extra = {}) => ({
  method,
  headers: { authorization: 'Bearer browser-token', ...extra },
  requestId: 'req-1',
  on() {},
  removeListener() {},
  resume() {},
});

/** 带 JSON body 的请求替身：`readJsonBody` 走 data/end 事件。 */
const jsonRequest = (method, body, extra = {}) => ({
  method,
  headers: { authorization: 'Bearer browser-token', 'content-type': 'application/json', ...extra },
  requestId: 'req-1',
  on(event, fn) {
    if (event === 'data') fn(Buffer.from(JSON.stringify(body), 'utf8'));
    if (event === 'end') fn();
  },
  removeListener() {},
  resume() {},
});

before(() => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method || 'GET'} ${url.pathname}`);
    if (url.pathname === '/internal/auth/me') {
      return new Response(
        JSON.stringify({ id: ME, organization_id: ORG, username: 'alice', roles: ['reviewer'] }),
        { status: 200 },
      );
    }
    if (init?.headers) agentHeaders.push(init.headers);
    return new Response(JSON.stringify({ review_task_id: TASK, status: 'PENDING' }), { status: 200 });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('/api/reviews* BFF 路由', () => {
  it('非法百分号编码是 404 NOT_FOUND，且不转发给 Agent', async () => {
    for (const [method, path] of [
      ['GET', '/api/reviews/%E0'],
      ['GET', `/api/reviews/${TASK}/materials/%E0/download`],
      ['POST', `/api/reviews/%/claim`],
    ]) {
      calls.length = 0;
      const { captured, response, json } = responseCapture();
      const handled = await handleReviewsRoute(method, path, new URL(`http://bff${path}`), response, request(method));
      assert.equal(handled, true);
      assert.equal(captured.statusCode, 404, `${method} ${path}`);
      assert.equal(json().code, 'NOT_FOUND');
      assert.equal(calls.some((p) => p.includes('/internal/reviews')), false);
    }
  });

  it('合法路径照常转发，角色由服务端投影成 X-Acting-Role', async () => {
    calls.length = 0;
    agentHeaders.length = 0;
    const { captured, response } = responseCapture();
    await handleReviewsRoute('GET', `/api/reviews/${TASK}`, new URL(`http://bff/api/reviews/${TASK}`), response, request('GET'));
    assert.equal(captured.statusCode, 200);
    assert.ok(calls.includes(`GET /internal/reviews/${TASK}`));
    assert.equal(agentHeaders.at(-1)['X-Acting-Role'], 'reviewer');
    assert.equal(agentHeaders.at(-1)['X-Acting-User-Id'], ME);
    assert.equal(agentHeaders.at(-1)['X-Acting-Organization-Id'], ORG);
  });

  it('浏览器自带的 X-Acting-* 被剥掉（身份只由服务端写）', async () => {
    agentHeaders.length = 0;
    const { response } = responseCapture();
    await handleReviewsRoute(
      'GET',
      `/api/reviews/${TASK}`,
      new URL(`http://bff/api/reviews/${TASK}`),
      response,
      request('GET', {
        'x-acting-user-id': 'attacker',
        'x-acting-organization-id': 'attacker-org',
        'x-acting-role': 'admin',
      }),
    );
    assert.equal(agentHeaders.at(-1)['X-Acting-User-Id'], ME);
    assert.equal(agentHeaders.at(-1)['X-Acting-Role'], 'reviewer');
  });

  it('驳回：反馈缺失在 BFF 就 422，不白跑一次 Agent 往返', async () => {
    calls.length = 0;
    const { captured, response, json } = responseCapture();
    await handleReviewsRoute(
      'POST',
      `/api/reviews/${TASK}/reject`,
      new URL(`http://bff/api/reviews/${TASK}/reject`),
      response,
      jsonRequest('POST', { base_revision: 3, feedback: '   ' }),
    );
    assert.equal(captured.statusCode, 422);
    assert.equal(json().code, 'REVIEW_FEEDBACK_REQUIRED');
    assert.equal(calls.some((p) => p.includes('/reject')), false);
  });

  it('通过：base_revision 非法给 422，不把 NaN 转发下去', async () => {
    calls.length = 0;
    const { captured, response, json } = responseCapture();
    await handleReviewsRoute(
      'POST',
      `/api/reviews/${TASK}/approve`,
      new URL(`http://bff/api/reviews/${TASK}/approve`),
      response,
      jsonRequest('POST', { base_revision: 'abc' }),
    );
    assert.equal(captured.statusCode, 422);
    assert.equal(json().code, 'REVIEW_INPUT_INVALID');
    assert.equal(calls.some((p) => p.includes('/approve')), false);
  });

  it('方法不对给 405；未知段给 404', async () => {
    for (const [method, path, expected] of [
      ['DELETE', `/api/reviews/${TASK}`, 405],
      ['GET', `/api/reviews/${TASK}/claim`, 405],
      ['GET', `/api/reviews/${TASK}/nope`, 404],
      ['POST', `/api/reviews/${TASK}/items/2/other`, 404],
    ]) {
      const { captured, response } = responseCapture();
      await handleReviewsRoute(method, path, new URL(`http://bff${path}`), response, request(method));
      assert.equal(captured.statusCode, expected, `${method} ${path}`);
    }
  });

  it('不是 /api/reviews 前缀时返回 false（交给别的路由）', async () => {
    const { response } = responseCapture();
    assert.equal(
      await handleReviewsRoute('GET', '/api/artifacts', new URL('http://bff/api/artifacts'), response, request('GET')),
      false,
    );
  });
});
