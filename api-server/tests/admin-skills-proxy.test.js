/**
 * `/api/admin/skills*` 与用户侧共享申请的 BFF 面（ADR 0015 §7.2）。
 *
 * BFF 的职责边界只有两条，这里把两条都钉住：
 * 1. **身份头由服务端写入**（`X-Acting-*` 含角色），浏览器的同名头永远不能透传；
 * 2. **只转发，不判权限**——agent 的 403/404/409 原样传回，BFF 不把「跨 org 404」
 *    改写成 403（存在性本身不能泄漏），也不把 403 吞成 200。
 *
 * 角色判定与 org 作用域的正确性由 agent/ 的单测与真实链路证明；这里只证明
 * 「说出去的话」与浏览器请求里出现的东西对得上。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isProtectedApiPath } from '../src/config.js';
import {
  createAgentSkillShareRequest,
  decideAdminSkillShareRequest,
  getAdminOrgSkillManifest,
  listAdminOrgSkills,
  listAdminSkillShareRequests,
  setAdminOrgSkillCurrent,
  setAdminOrgSkillVersionStatus,
  uploadAdminOrgSkill,
  withdrawAgentSkillShareRequest,
} from '../src/services/agent-skill-admin-client.js';
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

describe('BFF /api/admin/skills', () => {
  it('is an authenticated surface', () => {
    assert.equal(isProtectedApiPath('/api/admin/skills/org'), true);
    assert.equal(isProtectedApiPath('/api/admin/skills/share-requests'), true);
    assert.equal(isProtectedApiPath('/api/capabilities/skills/share-requests'), true);
  });

  it('管理员队列强制 scope=org，且白名单只放 status', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url) => {
      seen.push(new URL(String(url)));
      return jsonResponse(200, { requests: [] });
    }));
    await listAdminSkillShareRequests(
      new URLSearchParams({ status: 'pending', scope: 'user', requester_user_id: 'other' }),
      { auth: AUTH },
    );
    assert.equal(seen[0].pathname, '/internal/skills/share-requests');
    // `scope` 由 BFF 写死成 org：浏览器说 `scope=user` 不能把队列换成别人的名单。
    assert.deepEqual(Object.fromEntries(seen[0].searchParams), { status: 'pending', scope: 'org' });
  });

  it('写操作带上服务端解析出的角色，浏览器的同名头进不来', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ url: new URL(String(url)), init });
      return jsonResponse(200, { ok: true });
    }));
    await setAdminOrgSkillVersionStatus('sales-weekly', 'a'.repeat(64), 'revoke', '泄露风险', { auth: AUTH });
    const { url, init } = seen[0];
    assert.equal(url.pathname, `/internal/skills/org/sales-weekly/versions/${'a'.repeat(64)}/revoke`);
    assert.equal(init.headers['X-Acting-Role'], 'admin');
    assert.equal(init.headers['X-Acting-User-Id'], 'user-1');
    assert.deepEqual(JSON.parse(init.body), { reason: '泄露风险' });
  });

  it('跨 org 的 404 与未授权的 403 原样传回，不互相改写', async (t) => {
    let status = 403;
    t.after(stubFetch(async () => jsonResponse(
      status,
      status === 403
        ? { error: 'Administrator role is required', code: 'ADMIN_REQUIRED' }
        : { error: 'Org skill version not found', code: 'SKILL_ORG_VERSION_UNKNOWN' },
    )));
    await assert.rejects(
      listAdminOrgSkills({ auth: { ...AUTH, actingRole: 'user' } }),
      (err) => {
        const http = asHttpError(err);
        return http.status === 403 && http.code === 'ADMIN_REQUIRED';
      },
    );
    status = 404;
    await assert.rejects(
      getAdminOrgSkillManifest('ghost', 'b'.repeat(64), { auth: AUTH }),
      (err) => {
        const http = asHttpError(err);
        return http.status === 404 && http.code === 'SKILL_ORG_VERSION_UNKNOWN';
      },
    );
  });

  it('改「当前推荐版本」把摘要放在 body 而不是 query', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ url: new URL(String(url)), init });
      return jsonResponse(200, { ok: true });
    }));
    await setAdminOrgSkillCurrent('sales-weekly', 'c'.repeat(64), { auth: AUTH });
    assert.equal(seen[0].url.pathname, '/internal/skills/org/sales-weekly/current');
    assert.equal(seen[0].url.search, '');
    assert.deepEqual(JSON.parse(seen[0].init.body), { contentDigest: 'c'.repeat(64) });
  });

  it('驳回是写操作、批准可以带 setCurrent', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ url: new URL(String(url)), init });
      return jsonResponse(200, { request: {} });
    }));
    await decideAdminSkillShareRequest('req-1', 'approve', { setCurrent: true, note: 'ok' }, { auth: AUTH });
    await decideAdminSkillShareRequest('req-1', 'reject', { note: '描述不符' }, { auth: AUTH });
    assert.deepEqual(
      seen.map((s) => s.url.pathname),
      [
        '/internal/skills/share-requests/req-1/approve',
        '/internal/skills/share-requests/req-1/reject',
      ],
    );
    assert.deepEqual(JSON.parse(seen[1].init.body), { note: '描述不符' });
  });

  it('归档上传走流式转发，文件名与 set_current 进 query/头', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ url: new URL(String(url)), init });
      return jsonResponse(201, { name: 'sales-weekly' });
    }));
    const { Readable } = await import('node:stream');
    await uploadAdminOrgSkill(Readable.from([Buffer.from('zip')]), 'sales-weekly.zip', {
      setCurrent: true,
      auth: AUTH,
    });
    assert.equal(seen[0].url.pathname, '/internal/skills/org');
    assert.equal(seen[0].url.searchParams.get('filename'), 'sales-weekly.zip');
    assert.equal(seen[0].url.searchParams.get('set_current'), 'true');
    // 流式转发必须声明 duplex，否则 undici 会拒收一个流请求体。
    assert.equal(seen[0].init.duplex, 'half');
  });
});

describe('BFF /api/capabilities/skills/share-requests', () => {
  it('创建申请把名字放在 body，不让调用方指定摘要', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ url: new URL(String(url)), init });
      return jsonResponse(201, { request: { requestId: 'r1' } });
    }));
    await createAgentSkillShareRequest('sales-weekly', '给销售团队用', { auth: AUTH });
    assert.equal(seen[0].url.pathname, '/internal/skills/share-requests');
    assert.deepEqual(JSON.parse(seen[0].init.body), {
      name: 'sales-weekly',
      note: '给销售团队用',
    });
  });

  it('没有备注时不写 note 字段（而不是写空串）', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ init });
      return jsonResponse(201, { request: {} });
    }));
    await createAgentSkillShareRequest('sales-weekly', undefined, { auth: AUTH });
    assert.deepEqual(JSON.parse(seen[0].init.body), { name: 'sales-weekly' });
  });

  it('撤回用请求 id，并且不把用户的角色头带成管理员', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ url: new URL(String(url)), init });
      return jsonResponse(200, { request: {} });
    }));
    await withdrawAgentSkillShareRequest('req/with space', { auth: { ...AUTH, actingRole: 'user' } });
    // 路径段必须转义：未转义的 `/` 会把请求打到另一个端点上。
    assert.equal(seen[0].url.pathname, '/internal/skills/share-requests/req%2Fwith%20space/withdraw');
    assert.equal(seen[0].init.headers['X-Acting-Role'], 'user');
  });
});
