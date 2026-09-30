/**
 * `/api/admin/users*` 的 BFF 侧（design rbac-roles §5）：
 * 受保护路径、身份与**角色集合**由服务端写入、只转发白名单查询参数、
 * Agent 的 403/404/409 原样传回。角色与作用域的判定在 agent/（见其集成测试）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isProtectedApiPath } from '../src/config.js';
import {
  grantAdminMemberRole,
  listAdminMemberRoleEvents,
  listAdminMembers,
  revokeAdminMemberRole,
} from '../src/services/agent-member-role-client.js';
import { asHttpError } from '../src/http/errors.js';

const AUTH = {
  actingUserId: 'user-1',
  actingOrganizationId: 'org-1',
  actingRole: 'admin,reviewer',
};

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

describe('/api/admin/users', () => {
  it('is an authenticated surface', () => {
    assert.equal(isProtectedApiPath('/api/admin/users'), true);
    assert.equal(isProtectedApiPath('/api/admin/users/U/roles/admin'), true);
    assert.equal(isProtectedApiPath('/api/admin/users/U/role-events'), true);
  });

  it('forwards the projected identity (including the role set) and only allowed query keys', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ url: new URL(String(url)), init });
      return jsonResponse(200, { members: [], next_cursor: null });
    }));
    const browser = new URLSearchParams({
      q: 'ali',
      role: 'admin',
      cursor: 'C',
      limit: '20',
      org_id: 'other-org',
      x_acting_role: 'admin',
    });
    await listAdminMembers(browser, { auth: AUTH });
    const { url, init } = seen[0];
    assert.equal(url.pathname, '/internal/admin/members');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      q: 'ali',
      role: 'admin',
      cursor: 'C',
      limit: '20',
    });
    assert.equal(init.headers['X-Acting-User-Id'], 'user-1');
    assert.equal(init.headers['X-Acting-Organization-Id'], 'org-1');
    // 集合形态原样转发：agent 的 hasRole 解析它，不能被 BFF 压成单值。
    assert.equal(init.headers['X-Acting-Role'], 'admin,reviewer');
  });

  it('grants and revokes with the role in the path, encoding both segments', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ url: new URL(String(url)), method: init?.method });
      return jsonResponse(200, { user_id: 'U', roles: ['reviewer'], pinned_roles: [] });
    }));
    await grantAdminMemberRole('U/1', 'reviewer', { auth: AUTH });
    await revokeAdminMemberRole('U/1', 'reviewer', { auth: AUTH });
    assert.deepEqual(seen.map((s) => [s.url.pathname, s.method]), [
      ['/internal/admin/members/U%2F1/roles/reviewer', 'PUT'],
      ['/internal/admin/members/U%2F1/roles/reviewer', 'DELETE'],
    ]);
  });

  it('passes the Agent’s 403 / 404 / 409 through unchanged', async (t) => {
    let status = 403;
    let code = 'ADMIN_REQUIRED';
    t.after(stubFetch(async () => jsonResponse(status, { error: 'denied', code })));
    await assert.rejects(listAdminMembers(new URLSearchParams(), { auth: { ...AUTH, actingRole: 'reviewer' } }), (err) => {
      const http = asHttpError(err);
      return http.status === 403 && http.code === 'ADMIN_REQUIRED';
    });
    status = 404;
    code = 'NOT_FOUND';
    await assert.rejects(grantAdminMemberRole('U', 'admin', { auth: AUTH }), (err) => asHttpError(err).status === 404);
    status = 409;
    code = 'LAST_ADMIN';
    await assert.rejects(revokeAdminMemberRole('U', 'admin', { auth: AUTH }), (err) => {
      const http = asHttpError(err);
      return http.status === 409 && http.code === 'LAST_ADMIN';
    });
  });

  it('forwards only limit to the role-events endpoint', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url) => {
      seen.push(new URL(String(url)));
      return jsonResponse(200, { events: [] });
    }));
    await listAdminMemberRoleEvents('U', new URLSearchParams({ limit: '5', q: 'drop-me' }), { auth: AUTH });
    assert.equal(seen[0].pathname, '/internal/admin/members/U/role-events');
    assert.deepEqual(Object.fromEntries(seen[0].searchParams), { limit: '5' });
  });
});
