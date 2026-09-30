/**
 * org 层管理员路由（ADR 0015 §7.2，design §7.2）。
 *
 * 走**真实的 HTTP 服务器**，因为这里要证明的是「浏览器不能靠自己声明就变成 admin」：
 * 角色来自服务端写入的 `X-Acting-*` 头，而路由必须按它拒人。这条纪律用直接调用
 * 服务层的单测证明不了。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';
import {
  OrgSkillAdminService,
  createOrgSkillAdminHandler,
} from '../../src/application/org-skill-admin-service.js';
import { OrgSkillRepository } from '../../src/infrastructure/mysql/repositories/org-skill-repository.js';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createStoredZip } from '../support/stored-zip.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const ADMIN = '01K0G2PAV8FPMVC9QHJG7JPN50';
const MEMBER = '01K0G2PAV8FPMVC9QHJG7JPN51';

function skillMd(name) {
  return `---\nname: ${name}\ndescription: d\n---\n\nbody\n`;
}

describe('org 层管理员路由 (/internal/skills/org*)', () => {
  let server;
  let port;
  let root;
  let orgSkills;

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-org-admin-http-'));
    const publishedBase = path.join(root, 'published');
    const tmpRoot = path.join(root, 'tmp');
    await fsp.mkdir(publishedBase, { recursive: true });
    await fsp.mkdir(tmpRoot, { recursive: true });
    let seq = 0;
    orgSkills = new OrgSkillRepository(createFakeKnex(createFakeState()), {
      generateId: () => `01K0G2PAV8FPMVC9QHJG7JPN${String(60 + seq++).slice(-2)}`,
    });
    const service = new OrgSkillAdminService({
    // 单测里外部主体就是内部 ULID：账本 id 的解析在 http-main 一处完成；
    // 服务只要求「进来的 actor 已经是内部 id」。
    resolveOwner: async (auth) => ({ orgId: auth.externalOrgId, userId: auth.externalUserId }),
      orgSkills,
      publishedBase,
      tmpRoot,
      systemSkillNames: async () => ['pdf'],
    });

    server = createAgentHttpServer({
      createRunService: { execute: async () => ({}) },
      getRunService: { execute: async () => ({}) },
      cancelRunService: { execute: async () => ({}) },
      eventQueryService: { listEvents: async () => ({ events: [] }) },
      orgSkillAdmin: createOrgSkillAdminHandler(service),
      config: { ALLOW_UNAUTHENTICATED_INTERNAL: true },
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(root, { recursive: true, force: true });
  });

  function actingHeaders(role, userId = ADMIN) {
    return {
      'x-acting-user-id': userId,
      'x-acting-organization-id': ORG,
      'x-acting-role': role,
    };
  }

  function zip(name) {
    return createStoredZip([{ name: `${name}/SKILL.md`, content: skillMd(name) }]);
  }

  it('非 admin 上传被 403，且账本里不留东西', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/internal/skills/org?filename=x.zip`, {
      method: 'POST',
      headers: { ...actingHeaders('user', MEMBER), 'content-type': 'application/zip' },
      body: zip('sneaky'),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'ADMIN_REQUIRED');
    assert.deepEqual(await orgSkills.listForOrg({ orgId: ORG }), []);
  });

  it('admin 上传 → 201；随后列表与 manifest 都能读到', async () => {
    const upload = await fetch(
      `http://127.0.0.1:${port}/internal/skills/org?filename=sales-weekly.zip&set_current=true`,
      {
        method: 'POST',
        headers: { ...actingHeaders('admin'), 'content-type': 'application/zip' },
        body: zip('sales-weekly'),
      },
    );
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    assert.equal(uploaded.name, 'sales-weekly');
    assert.equal(uploaded.status, 'active');

    const listed = await (await fetch(`http://127.0.0.1:${port}/internal/skills/org`, {
      headers: actingHeaders('admin'),
    })).json();
    assert.equal(listed.skills.length, 1);
    assert.equal(listed.skills[0].currentDigest, uploaded.contentDigest);

    const manifest = await (await fetch(
      `http://127.0.0.1:${port}/internal/skills/org/sales-weekly/versions/${uploaded.contentDigest}/manifest`,
      { headers: actingHeaders('admin') },
    )).json();
    assert.deepEqual(manifest.files.map((f) => f.path), ['SKILL.md']);
    assert.match(manifest.skillMd, /name: sales-weekly/);
  });

  it('revoke 需要原因，响应带受影响 AgentVersion 列表；吊销后不能再次上传同一摘要', async () => {
    const digest = (await orgSkills.listForOrg({ orgId: ORG }))[0].currentDigest;
    const revoke = await fetch(
      `http://127.0.0.1:${port}/internal/skills/org/sales-weekly/versions/${digest}/revoke`,
      {
        method: 'POST',
        headers: { ...actingHeaders('admin'), 'content-type': 'application/json' },
        body: JSON.stringify({ reason: '含内部数据' }),
      },
    );
    assert.equal(revoke.status, 200);
    const revoked = await revoke.json();
    assert.equal(revoked.status, 'revoked');
    assert.deepEqual(revoked.affectedAgentVersionIds, []);

    // 撤销过的摘要不允许再次发布（防止原样回流）。
    const republish = await fetch(
      `http://127.0.0.1:${port}/internal/skills/org?filename=sales-weekly.zip`,
      {
        method: 'POST',
        headers: { ...actingHeaders('admin'), 'content-type': 'application/zip' },
        body: zip('sales-weekly'),
      },
    );
    assert.equal(republish.status, 400);
  });

  it('没有 acting 身份时 400（不能靠「没带头」蒙过去）', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/internal/skills/org`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'AUTH_CONTEXT_REQUIRED');
  });

  it('不归我管的子路径返回 501 之外的行为——留给后续路由，不被静默吞掉', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/internal/skills/org/unknown/shape`, {
      method: 'GET',
      headers: actingHeaders('admin'),
    });
    // 既不是 200 也不是 500：handler 返回 null 之后没有别的路由认领，框架给 404。
    assert.notEqual(response.status, 200);
    assert.notEqual(response.status, 500);
  });
});
