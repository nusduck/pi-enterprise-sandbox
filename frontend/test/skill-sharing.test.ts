/**
 * 共享申请与 org 层管理的前端适配（ADR 0015 §7.1/§7.2）。
 *
 * 这一层的职责只有两件，两件都容易写错：
 * 1. **错误要带着 code 出来**——页面靠 `SKILL_NOT_ENABLED` / `SKILL_NAME_RESERVED_BY_ORG`
 *    这类码给出可操作的提示，把 409 变成一句「操作失败」等于让用户猜；
 * 2. **请求形状要与服务端约定一致**——摘要类字段只能由服务端算，前端多传一个
 *    就是让人给自己背书。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  listMySkillShareRequests,
  listOrgSkills,
  listSkillShareQueue,
  rejectSkillShare,
  requestSkillShare,
  setOrgSkillCurrent,
  setOrgSkillVersionStatus,
  uploadOrgSkill,
  withdrawSkillShare,
} from '../src/shared/api/skillSharing.ts';

describe('skillSharing：请求形状', () => {
  it('发起申请只带 name 与可选 note，摘要由服务端决定', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ url: new URL(String(url), ORIGIN), init });
      return jsonResponse(201, { request: { requestId: 'r1' } });
    }));
    await requestSkillShare('sales-weekly', '给销售用');
    assert.equal(seen[0].url.pathname, '/api/capabilities/skills/sales-weekly/share-requests');
    assert.deepEqual(JSON.parse(seen[0].init.body), { note: '给销售用' });
  });

  it('没有备注时 body 是空对象，不是 { note: "" }', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ init });
      return jsonResponse(201, { request: {} });
    }));
    await requestSkillShare('sales-weekly');
    assert.deepEqual(JSON.parse(seen[0].init.body), {});
  });

  it('管理员队列把 status 透传，未给时不带 query', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url) => {
      seen.push(new URL(String(url), ORIGIN));
      return jsonResponse(200, { requests: [] });
    }));
    await listSkillShareQueue('pending');
    await listSkillShareQueue();
    assert.equal(seen[0].pathname, '/api/admin/skills/share-requests');
    assert.equal(seen[0].searchParams.get('status'), 'pending');
    assert.equal(seen[1].search, '');
  });

  it('驳回必须把原因发出去（空原因不拦在客户端，交给服务端判）', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ init });
      return jsonResponse(200, { request: {} });
    }));
    await rejectSkillShare('req-1', '描述与实际不符');
    assert.deepEqual(JSON.parse(seen[0].init.body), { note: '描述与实际不符' });
  });

  it('改当前版本只发 contentDigest', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ url: new URL(String(url), ORIGIN), init });
      return jsonResponse(200, { ok: true });
    }));
    await setOrgSkillCurrent('sales-weekly', 'a'.repeat(64));
    assert.equal(seen[0].url.pathname, '/api/admin/skills/org/sales-weekly/current');
    assert.deepEqual(JSON.parse(seen[0].init.body), { contentDigest: 'a'.repeat(64) });
  });

  it('吊销把 reason 一起发出去（吊销是安全动作，要有留痕）', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ url: new URL(String(url), ORIGIN), init });
      return jsonResponse(200, { ok: true, status: 'revoked', affectedAgentVersionIds: ['v1'] });
    }));
    const result = await setOrgSkillVersionStatus('sales-weekly', 'b'.repeat(64), 'revoke', '含内部数据');
    assert.equal(seen[0].url.pathname, `/api/admin/skills/org/sales-weekly/versions/${'b'.repeat(64)}/revoke`);
    assert.deepEqual(JSON.parse(seen[0].init.body), { reason: '含内部数据' });
    // 受影响版本列表要能到达页面：管理员据此知道谁会丢挂载。
    assert.deepEqual(result.affectedAgentVersionIds, ['v1']);
  });

  it('归档上传把文件名与 set_current 同时放进头与 query', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ url: new URL(String(url), ORIGIN), init });
      return jsonResponse(201, { name: 'sales-weekly' });
    }));
    const file = new Blob([new Uint8Array([1, 2, 3])]);
    await uploadOrgSkill(file, 'sales weekly.zip', true);
    assert.equal(seen[0].url.pathname, '/api/admin/skills/org');
    assert.equal(seen[0].url.searchParams.get('set_current'), 'true');
    assert.equal(seen[0].init.headers['X-Filename'], encodeURIComponent('sales weekly.zip'));
    assert.equal(seen[0].init.headers['X-Set-Current'], '1');
  });
});

describe('skillSharing：错误与降级', () => {
  it('把服务端的 code 带出来，页面才能给出可操作的提示', async (t) => {
    t.after(stubFetch(async () => jsonResponse(409, {
      error: 'Skill is not enabled',
      code: 'SKILL_NOT_ENABLED',
    })));
    await assert.rejects(requestSkillShare('mine'), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'SKILL_NOT_ENABLED');
      return true;
    });
  });

  it('403 不会被吞成空列表：调用方必须能分辨「没有申请」与「看不到」', async (t) => {
    t.after(stubFetch(async () => jsonResponse(403, {
      error: 'Administrator role is required',
      code: 'ADMIN_REQUIRED',
    })));
    await assert.rejects(listSkillShareQueue('pending'), (err) => err.status === 403);
  });

  it('没有 requests 字段时返回空数组，不是 undefined', async (t) => {
    t.after(stubFetch(async () => jsonResponse(200, {})));
    assert.deepEqual(await listMySkillShareRequests(), []);
    assert.deepEqual(await listOrgSkills(), []);
  });

  it('非 JSON 的响应体不会把解析错误当成成功', async (t) => {
    t.after(stubFetch(async () => new Response('<html>502</html>', { status: 502 })));
    await assert.rejects(withdrawSkillShare('req-1'), (err) => err.status === 502);
  });

  it('org 层列表只认 `skills` 这个键（`org_skills` 是历史名，读错会显示空列表）', async (t) => {
    t.after(stubFetch(async () => jsonResponse(200, { org_skills: [{ name: 'x' }] })));
    assert.deepEqual(await listOrgSkills(), []);
  });
});

/** BFF 的路由是相对路径；测试里给它们一个固定 origin 才解析得动。 */
const ORIGIN = 'http://bff.test';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}
