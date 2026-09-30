/**
 * 共享申请路由（ADR 0015 §7.2/§7.3，design §7.2）。
 *
 * 走**真实的 HTTP 服务器**，因为这里要证明的两件事都只在这条路径上成立：
 * - 角色来自服务端写入的 `X-Acting-Role`，浏览器不能靠自己声明就变成 admin；
 * - 用户侧与管理员共用 `GET /internal/skills/share-requests`，**`scope=org` 不能成为
 *   绕过 admin 检查的开关**——它只是选择列表口径，权限仍按角色判。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';
import {
  SkillShareService,
  createSkillShareHandler,
} from '../../src/application/skill-share-service.js';
import { SkillShareRequestRepository } from '../../src/infrastructure/mysql/repositories/skill-share-request-repository.js';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const ALICE = '01K0G2PAV8FPMVC9QHJG7JPN50';
const BOB = '01K0G2PAV8FPMVC9QHJG7JPN51';
const ADMIN = '01K0G2PAV8FPMVC9QHJG7JPN52';
const DIGEST = 'a'.repeat(64);

describe('共享申请路由 (/internal/skills/share-requests*)', () => {
  let server;
  let port;
  let requests;

  before(async () => {
    let seq = 0;
    requests = new SkillShareRequestRepository(createFakeKnex(createFakeState()), {
      generateId: () => `01K0G2PAV8FPMVC9QHJG7JPN${String(60 + seq++).slice(-2)}`,
    });
    const service = new SkillShareService({
    // 单测里外部主体就是内部 ULID：账本 id 的解析在 http-main 一处完成；
    // 服务只要求「进来的 actor 已经是内部 id」。
    resolveOwner: async (auth) => ({ orgId: auth.externalOrgId, userId: auth.externalUserId }),
      requests,
      orgSkills: {},
      enabledVersionOf: async ({ name }) => (name === 'enabled-skill' ? { contentDigest: DIGEST } : null),
      orgSkillOwnerOf: async () => null,
      publishFromPublished: async () => ({ contentDigest: DIGEST }),
      manifestOfRequestedVersion: async () => ({
        files: [{ path: 'SKILL.md', bytes: 42 }],
        skillMd: '---\nname: enabled-skill\n---\n',
        truncated: false,
      }),
    });

    server = createAgentHttpServer({
      createRunService: { execute: async () => ({}) },
      getRunService: { execute: async () => ({}) },
      cancelRunService: { execute: async () => ({}) },
      eventQueryService: { listEvents: async () => ({ events: [] }) },
      skillShare: createSkillShareHandler(service),
      config: { ALLOW_UNAUTHENTICATED_INTERNAL: true },
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function headers(role, userId = ALICE) {
    return {
      'x-acting-user-id': userId,
      'x-acting-organization-id': ORG,
      'x-acting-role': role,
      'content-type': 'application/json',
    };
  }

  const url = (suffix = '') => `http://127.0.0.1:${port}/internal/skills/share-requests${suffix}`;

  it('未启用 → 409 SKILL_NOT_ENABLED', async () => {
    const response = await fetch(url(), {
      method: 'POST',
      headers: headers('user'),
      body: JSON.stringify({ name: 'never-enabled' }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'SKILL_NOT_ENABLED');
  });

  it('对已启用版本发起申请 → 201；本人列表能读到', async () => {
    const created = await fetch(url(), {
      method: 'POST',
      headers: headers('user'),
      body: JSON.stringify({ name: 'enabled-skill', note: '共享给团队' }),
    });
    assert.equal(created.status, 201);
    const row = (await created.json()).request;
    assert.equal(row.status, 'pending');
    assert.equal(row.contentDigest, DIGEST);

    const mine = await (await fetch(url(), { headers: headers('user') })).json();
    assert.equal(mine.requests.length, 1);
  });

  it('缺少 name → 400', async () => {
    const response = await fetch(url(), {
      method: 'POST',
      headers: headers('user'),
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'SKILL_SHARE_NAME_REQUIRED');
  });

  it('scope=org 不能绕过 admin 检查——普通成员仍是 403', async () => {
    const response = await fetch(url('?scope=org'), { headers: headers('user') });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'ADMIN_REQUIRED');
  });

  it('admin 能用 scope=org 看到全 org 队列，也能审阅被申请版本', async () => {
    const queue = await (await fetch(url('?scope=org&status=pending'), {
      headers: headers('admin', ADMIN),
    })).json();
    assert.equal(queue.requests.length, 1);
    const requestId = queue.requests[0].requestId;

    const review = await (await fetch(url(`/${requestId}/manifest`), {
      headers: headers('admin', ADMIN),
    })).json();
    assert.deepEqual(review.files, [{ path: 'SKILL.md', bytes: 42 }]);
    assert.match(review.skillMd, /enabled-skill/);
    // 摘要行：前端 ManifestView 与 org 版本清单共用一个类型，HTTP 层不能把它们挑掉。
    assert.equal(review.fileCount, 1);
    assert.equal(review.totalBytes, 42);
    assert.equal(review.contentDigest, queue.requests[0].contentDigest);
    assert.equal(review.name, queue.requests[0].name);
  });

  it('驳回必须带原因（没有原因的驳回在审计里等于没解释）', async () => {
    const queue = await (await fetch(url('?scope=org&status=pending'), {
      headers: headers('admin', ADMIN),
    })).json();
    const requestId = queue.requests[0].requestId;

    const noNote = await fetch(url(`/${requestId}/reject`), {
      method: 'POST',
      headers: headers('admin', ADMIN),
      body: JSON.stringify({}),
    });
    assert.equal(noNote.status, 400);
    assert.equal((await noNote.json()).code, 'SKILL_SHARE_NOTE_REQUIRED');

    const rejected = await fetch(url(`/${requestId}/reject`), {
      method: 'POST',
      headers: headers('admin', ADMIN),
      body: JSON.stringify({ note: '含客户名单' }),
    });
    assert.equal(rejected.status, 200);
    assert.equal((await rejected.json()).request.status, 'rejected');
  });

  it('已决定的申请不能再批（409），且不重复发布', async () => {
    // 新建一条并批准。
    await fetch(url(), {
      method: 'POST',
      headers: headers('user'),
      body: JSON.stringify({ name: 'enabled-skill' }),
    });
    const queue = await (await fetch(url('?scope=org&status=pending'), {
      headers: headers('admin', ADMIN),
    })).json();
    const requestId = queue.requests[0].requestId;
    const approved = await fetch(url(`/${requestId}/approve`), {
      method: 'POST',
      headers: headers('admin', ADMIN),
      body: JSON.stringify({}),
    });
    assert.equal(approved.status, 200);
    assert.equal((await approved.json()).request.status, 'approved');

    const again = await fetch(url(`/${requestId}/approve`), {
      method: 'POST',
      headers: headers('admin', ADMIN),
      body: JSON.stringify({}),
    });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).code, 'SKILL_SHARE_REQUEST_DECIDED');
  });

  it('别的成员撤不了我的申请（404，不泄漏存在性）', async () => {
    await fetch(url(), {
      method: 'POST',
      headers: headers('user'),
      body: JSON.stringify({ name: 'enabled-skill' }),
    });
    const mine = await (await fetch(url(), { headers: headers('user') })).json();
    const requestId = mine.requests.find((r) => r.status === 'pending').requestId;

    const other = await fetch(url(`/${requestId}/withdraw`), {
      method: 'POST',
      headers: headers('user', BOB),
    });
    assert.equal(other.status, 404);

    const own = await fetch(url(`/${requestId}/withdraw`), {
      method: 'POST',
      headers: headers('user'),
    });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).request.status, 'withdrawn');
  });

  it('没有 acting 身份 → 400（不能靠「没带头」蒙过去）', async () => {
    const response = await fetch(url());
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'AUTH_CONTEXT_REQUIRED');
  });
});
