/**
 * 产物库 `GET /api/artifacts`（不带 session_id）：归属 ID 来自 Agent，不来自浏览器；
 * exec 跳转用最小权限角色；只转发白名单查询参数；拿不到归属时 fail-closed。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { handleListArtifacts } from '../src/routes/artifacts.js';
import { config } from '../src/config.js';

class MockResponse extends EventEmitter {
  status = null;
  body = '';
  writeHead(status) { this.status = status; }
  end(body = '') { this.body += String(body); }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function withStubs(handler, run) {
  const originalFetch = globalThis.fetch;
  const originalAuth = config.AUTH_ENABLED;
  globalThis.fetch = handler;
  config.AUTH_ENABLED = false;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    config.AUTH_ENABLED = originalAuth;
  }
}

describe('artifact library proxy', () => {
  it('lists through exec with the Agent-resolved owner and least privilege', async () => {
    const calls = [];
    await withStubs(async (url, init = {}) => {
      const value = new URL(String(url));
      calls.push({ url: value, init });
      if (value.pathname === '/internal/identity/owner') {
        return jsonResponse({ org_id: '01M29ZHZV8VF2G344QZFM9MKDN', user_id: '01M2T4AHKZFTPB5WYQD4M7YHDY' });
      }
      return jsonResponse({ artifacts: [{ artifact_id: 'A' }], next_cursor: null });
    }, async () => {
      const res = new MockResponse();
      const url = new URL('http://bff/api/artifacts?kind=image&q=chart&limit=20&org_id=evil&user_id=evil');
      await handleListArtifacts(url, res, { headers: { 'x-acting-user-id': 'browser-claim' } });
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body).artifacts, [{ artifact_id: 'A' }]);
    });
    assert.equal(calls[0].url.pathname, '/internal/identity/owner');
    const exec = calls[1];
    assert.equal(exec.url.pathname, '/artifacts');
    assert.deepEqual(Object.fromEntries(exec.url.searchParams), { q: 'chart', kind: 'image', limit: '20' });
    assert.equal(exec.init.headers['X-Acting-Organization-Id'], '01M29ZHZV8VF2G344QZFM9MKDN');
    assert.equal(exec.init.headers['X-Acting-User-Id'], '01M2T4AHKZFTPB5WYQD4M7YHDY');
    assert.equal(exec.init.headers['X-Acting-Role'], 'user');
  });

  it('fails closed when the Agent cannot resolve the owner', async () => {
    for (const [status, body, expected] of [[200, { org_id: '' }, 503], [404, { error: 'not found', code: 'NOT_FOUND' }, 404]]) {
      let execCalled = false;
      await withStubs(async (url) => {
        if (new URL(String(url)).pathname === '/internal/identity/owner') return jsonResponse(body, status);
        execCalled = true;
        return jsonResponse({ artifacts: [] });
      }, async () => {
        const res = new MockResponse();
        await handleListArtifacts(new URL('http://bff/api/artifacts'), res, { headers: {} });
        assert.equal(res.status, expected);
      });
      assert.equal(execCalled, false, 'exec is never called without a formal owner');
    }
  });
});
