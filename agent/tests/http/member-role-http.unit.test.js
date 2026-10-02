/**
 * 平台角色管理路由（`/internal/admin/members*`，design rbac-roles §5）。
 *
 * 走**真实的 HTTP 服务器**：这里要证明的是路由层的形状——路径解析、方法分发、
 * 身份头缺失时的 400，以及服务端错误码（403 / 404 / 422 / 409）原样透传。
 * 「谁能管角色」的语义在集成测试里对着真表证明，不在这里用替身假装。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';
import { MemberRoleError } from '../../src/application/member-role-service.js';

const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';

/** 记录调用的替身服务：只回答「路由把什么转给了服务」。 */
function stubService() {
  const calls = [];
  return {
    calls,
    async listMembers(actor, query) {
      calls.push({ op: 'list', actor, query });
      return { members: [{ user_id: USER, username: 'alice', department: '工程部', roles: ['admin'], pinned_roles: [] }], next_cursor: null };
    },
    async grantRole(actor, userId, role) {
      calls.push({ op: 'grant', actor, userId, role });
      if (role === 'banned') throw new MemberRoleError(422, 'ROLE_UNKNOWN', 'Unknown role');
      return { user_id: userId, roles: [role], pinned_roles: [] };
    },
    async revokeRole(actor, userId, role) {
      calls.push({ op: 'revoke', actor, userId, role });
      if (role === 'banned') throw new MemberRoleError(422, 'ROLE_UNKNOWN', 'Unknown role');
      if (userId === 'last') {
        throw new MemberRoleError(409, 'LAST_ADMIN', 'Cannot revoke the last administrator of this organization');
      }
      return { user_id: userId, roles: [], pinned_roles: [] };
    },
    async listRoleEvents(actor, userId, opts) {
      calls.push({ op: 'events', actor, userId, opts });
      return { events: [{ event_id: '01K0', action: 'grant', role: 'admin', source: 'console' }] };
    },
  };
}

describe('平台角色管理路由 (/internal/admin/members*)', () => {
  let server;
  let port;
  let service;

  before(async () => {
    service = stubService();
    server = createAgentHttpServer({
      createRunService: { execute: async () => ({}) },
      getRunService: { execute: async () => ({}) },
      cancelRunService: { execute: async () => ({}) },
      eventQueryService: { listEvents: async () => ({ events: [] }) },
      memberRoleService: service,
      config: { ALLOW_UNAUTHENTICATED_INTERNAL: true },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => new Promise((resolve) => server.close(resolve)));

  const acting = (role) => ({
    'x-acting-user-id': '01K0G2PAV8FPMVC9QHJG7JPN60',
    'x-acting-organization-id': '01K0G2PAV8FPMVC9QHJG7JPN61',
    'x-acting-role': role,
  });
  const url = (path) => `http://127.0.0.1:${port}${path}`;

  it('缺 X-Acting-* 身份头时 400，且不碰服务', async () => {
    const response = await fetch(url('/internal/admin/members'));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'AUTH_CONTEXT_REQUIRED');
    assert.equal(service.calls.length, 0);
  });

  it('GET 列表把查询参数投影给服务，角色集合原样传下去', async () => {
    const response = await fetch(
      `${url('/internal/admin/members')}?q=ali&role=admin&cursor=01K0&limit=10`,
      { headers: acting('admin,reviewer') },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.members[0].username, 'alice');
    assert.equal(body.members[0].department, '工程部');
    const call = service.calls.at(-1);
    assert.equal(call.op, 'list');
    // 身份来自服务端写入的 `X-Acting-*`，角色集合原样保留（`requestId` 由服务端生成，
    // 每次不同，不在这里断言它）。
    assert.equal(call.actor.provider, 'bff');
    assert.equal(call.actor.callerType, 'web');
    assert.equal(call.actor.externalOrgId, '01K0G2PAV8FPMVC9QHJG7JPN61');
    assert.equal(call.actor.externalUserId, '01K0G2PAV8FPMVC9QHJG7JPN60');
    assert.equal(call.actor.role, 'admin,reviewer');
    assert.deepEqual(call.query, { q: 'ali', role: 'admin', cursor: '01K0', limit: '10' });
  });

  it('PUT / DELETE 授予与撤销（role 允许 URL 编码）', async () => {
    const granted = await fetch(`${url(`/internal/admin/members/${USER}/roles/reviewer`)}`, {
      method: 'PUT',
      headers: acting('admin'),
    });
    assert.equal(granted.status, 200);
    assert.equal(service.calls.at(-1).op, 'grant');
    assert.equal(service.calls.at(-1).role, 'reviewer');

    const revoked = await fetch(`${url(`/internal/admin/members/${USER}/roles/reviewer`)}`, {
      method: 'DELETE',
      headers: acting('admin'),
    });
    assert.equal(revoked.status, 200);
    assert.equal(service.calls.at(-1).op, 'revoke');
  });

  it('角色变更记录走子路径，并接受 limit', async () => {
    const response = await fetch(`${url(`/internal/admin/members/${USER}/role-events`)}?limit=5`, {
      headers: acting('admin'),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).events[0].action, 'grant');
    assert.deepEqual(service.calls.at(-1).opts, { limit: '5' });
  });

  it('服务端错误码原样透传（422 ROLE_UNKNOWN / 409 LAST_ADMIN）', async () => {
    const unknown = await fetch(`${url(`/internal/admin/members/${USER}/roles/banned`)}`, {
      method: 'PUT',
      headers: acting('admin'),
    });
    assert.equal(unknown.status, 422);
    assert.equal((await unknown.json()).code, 'ROLE_UNKNOWN');

    const last = await fetch(`${url('/internal/admin/members/last/roles/admin')}`, {
      method: 'DELETE',
      headers: acting('admin'),
    });
    assert.equal(last.status, 409);
    assert.equal((await last.json()).code, 'LAST_ADMIN');
  });

  it('方法不允许与未知子路径不会静默落到别的路由', async () => {
    const posted = await fetch(url('/internal/admin/members'), {
      method: 'POST',
      headers: acting('admin'),
    });
    assert.equal(posted.status, 405);
    const putList = await fetch(`${url(`/internal/admin/members/${USER}/role-events`)}`, {
      method: 'PUT',
      headers: acting('admin'),
    });
    assert.equal(putList.status, 405);
    const bogus = await fetch(`${url(`/internal/admin/members/${USER}/roles`)}`, {
      method: 'PUT',
      headers: acting('admin'),
    });
    assert.equal(bogus.status, 404);
    const deeper = await fetch(`${url(`/internal/admin/members/${USER}/nope/deeper`)}`, {
      headers: acting('admin'),
    });
    assert.equal(deeper.status, 404);
  });

  it('路径段是非法百分号编码时 404，且不碰服务（不能 500）', async () => {
    const before = service.calls.length;
    for (const [method, path] of [
      ['PUT', '/internal/admin/members/%E0/roles/admin'],
      ['DELETE', `/internal/admin/members/${USER}/roles/%E0`],
      ['GET', '/internal/admin/members/%/role-events'],
    ]) {
      const res = await fetch(url(path), { method, headers: acting('admin') });
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.equal((await res.json()).code, 'NOT_FOUND');
    }
    assert.equal(service.calls.length, before);
  });
});

describe('平台角色管理路由 —— 服务未装配', () => {
  let server;
  let port;

  before(async () => {
    server = createAgentHttpServer({
      createRunService: { execute: async () => ({}) },
      getRunService: { execute: async () => ({}) },
      cancelRunService: { execute: async () => ({}) },
      eventQueryService: { listEvents: async () => ({ events: [] }) },
      config: { ALLOW_UNAUTHENTICATED_INTERNAL: true },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => new Promise((resolve) => server.close(resolve)));

  it('没有角色账本时 503，而不是空列表（不能把「不可用」渲染成「没有成员」）', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/internal/admin/members`, {
      headers: {
        'x-acting-user-id': '01K0G2PAV8FPMVC9QHJG7JPN60',
        'x-acting-organization-id': '01K0G2PAV8FPMVC9QHJG7JPN61',
        'x-acting-role': 'admin',
      },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'DEPENDENCY');
  });
});
