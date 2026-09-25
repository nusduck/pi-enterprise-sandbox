/**
 * `/api/admin/runs*` 的 BFF 侧：受保护路径、身份头由服务端写入、只转发白名单查询参数、
 * Agent 的 403/404 原样传回、事件分页拉齐。角色与作用域的判定在 agent/（见其单测）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isProtectedApiPath } from '../src/config.js';
import {
  getAdminRun,
  getAdminSkillUsage,
  listAdminRuns,
  listAllAdminRunEvents,
} from '../src/services/agent-admin-client.js';
import { asHttpError } from '../src/http/errors.js';

const AUTH = { actingUserId: 'user-1', actingOrganizationId: 'org-1', actingRole: 'admin' };

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/admin/runs', () => {
  it('is an authenticated surface', () => {
    assert.equal(isProtectedApiPath('/api/admin/runs'), true);
    assert.equal(isProtectedApiPath('/api/admin/runs/stats'), true);
    assert.equal(isProtectedApiPath('/api/admin/runs/RUN/events'), true);
  });

  it('forwards the projected identity and only the allowed query keys', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ url: new URL(String(url)), init });
      return jsonResponse(200, { runs: [], next_cursor: null });
    }));
    const browser = new URLSearchParams({ status: 'failed', q: '周报', limit: '20', org_id: 'other-org', user_role: 'admin' });
    await listAdminRuns(browser, { auth: AUTH });
    const { url, init } = seen[0];
    assert.equal(url.pathname, '/internal/admin/runs');
    assert.deepEqual(Object.fromEntries(url.searchParams), { status: 'failed', q: '周报', limit: '20' });
    assert.equal(init.headers['X-Acting-User-Id'], 'user-1');
    assert.equal(init.headers['X-Acting-Organization-Id'], 'org-1');
    assert.equal(init.headers['X-Acting-Role'], 'admin');
  });

  it('passes the Agent’s 403 and 404 through unchanged', async (t) => {
    let status = 403;
    t.after(stubFetch(async () => jsonResponse(status, { error: status === 403 ? 'Administrator role is required' : 'Run not found', code: status === 403 ? 'ADMIN_REQUIRED' : 'NOT_FOUND' })));
    await assert.rejects(getAdminRun('R', { auth: { ...AUTH, actingRole: 'user' } }), (err) => {
      const http = asHttpError(err);
      return http.status === 403 && http.code === 'ADMIN_REQUIRED';
    });
    status = 404;
    await assert.rejects(getAdminRun('R', { auth: AUTH }), (err) => asHttpError(err).status === 404);
  });

  it('pages events until a short page', async (t) => {
    const pages = [];
    t.after(stubFetch(async (url) => {
      const after = Number(new URL(String(url)).searchParams.get('after_sequence'));
      pages.push(after);
      const count = after === 0 ? 1000 : 3;
      const events = Array.from({ length: count }, (_, i) => ({ run_id: 'R', sequence: after + i + 1, event_id: `e${after + i + 1}`, type: 'message.delta', payload: {} }));
      return jsonResponse(200, { events });
    }));
    const { events, truncated } = await listAllAdminRunEvents('R', { auth: AUTH });
    assert.deepEqual(pages, [0, 1000]);
    assert.equal(events.length, 1003);
    assert.equal(truncated, false);
  });

  it('forwards only days to the skill usage endpoint', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url) => {
      seen.push(new URL(String(url)));
      return jsonResponse(200, { days: 7, usage: [] });
    }));
    await getAdminSkillUsage(new URLSearchParams({ days: '7', org_id: 'x' }), { auth: AUTH });
    assert.equal(seen[0].pathname, '/internal/admin/skill-usage');
    assert.deepEqual(Object.fromEntries(seen[0].searchParams), { days: '7' });
    assert.equal(isProtectedApiPath('/api/admin/skill-usage'), true);
  });
});

