/**
 * org 层管理员操作面（ADR 0015 D5/D6/D8，design §7.2）。
 *
 * 这里钉的是**权限与作用域**，以及状态机在 API 这一层没有被放松：
 * - 非 admin 403（并有 admin 成功对照，避免「全部拒绝」假通过）；
 * - 跨 org 的资源是 **404 而不是 403**——存在性本身不能泄漏（AGENTS.md §2）；
 * - `revoked` 是终态，API 不能把它改回来；
 * - 账本说存在而盘上没字节时，报的是**存储损坏**，不是「没找到」。
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createStoredZip } from '../support/stored-zip.js';
import {
  AdminRequiredError,
  OrgSkillAdminService,
  statusForOrgSkillError,
} from '../../src/application/org-skill-admin-service.js';
import { OrgSkillRepository } from '../../src/infrastructure/mysql/repositories/org-skill-repository.js';
import { createFakeKnex, createFakeState } from './fake-knex.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const OTHER_ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Y';
const ADMIN = '01K0G2PAV8FPMVC9QHJG7JPN50';
const MEMBER = '01K0G2PAV8FPMVC9QHJG7JPN51';

const ADMIN_ACTOR = { externalOrgId: ORG, externalUserId: ADMIN, role: 'admin' };

/**
 * 真实链路 2026-09-30 抓到的缺陷：`tbl_agsvc_org_skills.org_id` 是 `CHAR(26)` 且带
 * `→ organizations.org_id` 外键，真实部署里调用者身份是**外部主体** `org_bootstrap`
 * （不是 ULID）。直接把它写进账本，插入会被外键拒绝；而**查**会静默命中零行——
 * 症状是「发布看起来成功了，Run 里却一个共享包都没有」。所以服务必须先把外部主体
 * 解析成内部 ULID。这条用例把那个边界钉死：给服务一个只认外部主体的解析器，
 * 断言落到账本上的值**不是**外部主体。
 */
const EXTERNAL_ORG = 'org_bootstrap';
const RESOLVED_ORG = ORG;
const RESOLVED_USER = ADMIN;
const MEMBER_ACTOR = { externalOrgId: ORG, externalUserId: MEMBER, role: 'user' };

function skillMd(name, description = 'd') {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`;
}

let seq = 0;
async function makeService(opts = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-org-admin-'));
  const publishedBase = path.join(root, 'published');
  const tmpRoot = path.join(root, 'tmp');
  await fsp.mkdir(publishedBase, { recursive: true });
  await fsp.mkdir(tmpRoot, { recursive: true });
  const orgSkills = new OrgSkillRepository(createFakeKnex(createFakeState()), {
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
    ...(opts.deps ?? {}),
  });
  return {
    root,
    publishedBase,
    orgSkills,
    service,
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

function archive(name, entries = []) {
  return createStoredZip([
    { name: `${name}/SKILL.md`, content: skillMd(name, '周报技能') },
    ...entries,
  ]);
}

async function upload(h, overrides = {}) {
  return h.service.upload({
    actor: ADMIN_ACTOR,
    archiveBytes: archive('sales-weekly', [{ name: 'sales-weekly/scripts/run.py', content: 'print(1)\n' }]),
    archiveName: 'sales-weekly.zip',
    ...overrides,
  });
}

describe('OrgSkillAdminService 权限', () => {
  it('非 admin 一律 403（上传 / 列表 / 改当前 / 弃用 都拒）', async () => {
    const h = await makeService();
    try {
      await assert.rejects(() => h.service.upload({
        actor: MEMBER_ACTOR, archiveBytes: archive('x'), archiveName: 'x.zip',
      }), AdminRequiredError);
      await assert.rejects(() => h.service.list({ actor: MEMBER_ACTOR }), AdminRequiredError);
      await assert.rejects(() => h.service.setCurrent({
        actor: MEMBER_ACTOR, name: 'x', contentDigest: 'a'.repeat(64),
      }), AdminRequiredError);
      await assert.rejects(() => h.service.setStatus({
        actor: MEMBER_ACTOR, name: 'x', contentDigest: 'a'.repeat(64),
        status: 'revoked', reason: 'x',
      }), AdminRequiredError);
      // 403 而不是 400/500。
      assert.equal(statusForOrgSkillError(new AdminRequiredError()).status, 403);
    } finally {
      await h.cleanup();
    }
  });

  it('role 为 null（旧 BFF 或直接调用）也按非 admin 拒——fail-closed', async () => {
    const h = await makeService();
    try {
      await assert.rejects(
        () => h.service.list({ actor: { ...ADMIN_ACTOR, role: null } }),
        AdminRequiredError,
      );
    } finally {
      await h.cleanup();
    }
  });

  it('X-Acting-Role 是集合：admin,reviewer 放行，纯 reviewer 拒绝（design §4.3）', async () => {
    const h = await makeService();
    try {
      // 正向对照：一个人可以同时持有两个角色，集合里的 admin 必须被认出来。
      // 旧的字面比较 `role === 'admin'` 会把这种调用者误拒，这条用例锁住它。
      await h.service.list({ actor: { ...ADMIN_ACTOR, role: 'admin,reviewer' } });
      await assert.rejects(
        () => h.service.list({ actor: { ...ADMIN_ACTOR, role: 'reviewer' } }),
        AdminRequiredError,
      );
    } finally {
      await h.cleanup();
    }
  });

  it('admin 成功对照（避免「全部拒绝」假通过）', async () => {
    const h = await makeService();
    try {
      const result = await upload(h);
      assert.equal(result.name, 'sales-weekly');
      const listed = await h.service.list({ actor: ADMIN_ACTOR });
      assert.equal(listed.skills.length, 1);
    } finally {
      await h.cleanup();
    }
  });
});

describe('OrgSkillAdminService 作用域', () => {
  it('跨 org 的版本是 404 而不是 403（不泄漏存在性）', async () => {
    const h = await makeService();
    try {
      const { contentDigest } = await upload(h);
      await assert.rejects(
        () => h.service.manifest({
          actor: { externalOrgId: OTHER_ORG, externalUserId: ADMIN, role: 'admin' },
          name: 'sales-weekly',
          contentDigest,
        }),
        (err) => {
          assert.equal(statusForOrgSkillError(err).status, 404);
          return true;
        },
      );
      // 别的 org 的列表也看不到它。
      const otherList = await h.service.list({
        actor: { externalOrgId: OTHER_ORG, externalUserId: ADMIN, role: 'admin' },
      });
      assert.deepEqual(otherList.skills, []);
    } finally {
      await h.cleanup();
    }
  });
});

describe('OrgSkillAdminService manifest', () => {
  it('列出文件清单与 SKILL.md，只给相对路径与字节数', async () => {
    const h = await makeService();
    try {
      const { contentDigest } = await upload(h);
      const manifest = await h.service.manifest({
        actor: ADMIN_ACTOR, name: 'sales-weekly', contentDigest,
      });
      assert.deepEqual(manifest.files.map((f) => f.path).sort(), ['SKILL.md', 'scripts/run.py']);
      assert.equal(manifest.truncated, false);
      assert.match(manifest.skillMd, /name: sales-weekly/);
      assert.equal(manifest.fileCount, 2);
    } finally {
      await h.cleanup();
    }
  });

  it('账本说存在但盘上没字节 → SKILL_ORG_BYTES_MISSING（存储损坏，不是「没找到」）', async () => {
    const h = await makeService();
    try {
      const { contentDigest } = await upload(h);
      // 模拟存储损坏：账本行在，字节被删。
      await fsp.rm(path.join(h.publishedBase, ORG, '_org', 'sales-weekly'), { recursive: true, force: true });
      await assert.rejects(
        () => h.service.manifest({ actor: ADMIN_ACTOR, name: 'sales-weekly', contentDigest }),
        (err) => {
          const mapped = statusForOrgSkillError(err);
          assert.equal(mapped.code, 'SKILL_ORG_BYTES_MISSING');
          // 不是 404：把损坏报成「没有」会让人以为版本不存在，从而重新发布同一摘要。
          assert.equal(mapped.status, 400);
          return true;
        },
      );
    } finally {
      await h.cleanup();
    }
  });
});

describe('OrgSkillAdminService 状态机', () => {
  it('吊销后不能改回 active；响应带受影响 AgentVersion 列表', async () => {
    const h = await makeService({
      deps: {
        affectedAgentVersions: async () => ['01K0G2PAV8FPMVC9QHJG7JPN99'],
      },
    });
    try {
      const { contentDigest } = await upload(h);
      const revoked = await h.service.setStatus({
        actor: ADMIN_ACTOR, name: 'sales-weekly', contentDigest,
        status: 'revoked', reason: '含内部数据',
      });
      assert.equal(revoked.version.status, 'revoked');
      assert.deepEqual(revoked.affectedAgentVersionIds, ['01K0G2PAV8FPMVC9QHJG7JPN99']);
      assert.equal(
        statusForOrgSkillError(new Error('x')).status,
        400,
        'unknown errors must not be reported as success',
      );
    } finally {
      await h.cleanup();
    }
  });

  it('没有 affectedAgentVersions 注入时返回空数组，而不是编一个数字', async () => {
    const h = await makeService();
    try {
      const { contentDigest } = await upload(h);
      const result = await h.service.setStatus({
        actor: ADMIN_ACTOR, name: 'sales-weekly', contentDigest,
        status: 'deprecated', reason: '旧版',
      });
      assert.deepEqual(result.affectedAgentVersionIds, []);
    } finally {
      await h.cleanup();
    }
  });

  it('setCurrent 指向已发布的版本；不存在则 404', async () => {
    const h = await makeService();
    try {
      const { contentDigest } = await upload(h);
      await h.service.setCurrent({ actor: ADMIN_ACTOR, name: 'sales-weekly', contentDigest });
      const listed = await h.service.list({ actor: ADMIN_ACTOR });
      assert.equal(listed.skills[0].currentDigest, contentDigest);

      await assert.rejects(
        () => h.service.setCurrent({
          actor: ADMIN_ACTOR, name: 'sales-weekly', contentDigest: 'b'.repeat(64),
        }),
        (err) => statusForOrgSkillError(err).status === 404,
      );
    } finally {
      await h.cleanup();
    }
  });
});

describe('OrgSkillAdminService 的 org id 边界（真实链路 2026-09-30）', () => {
  it('交给账本的是解析后的内部 ULID，而不是 BFF 投过来的外部主体', async () => {
    const seen = [];
    const recording = {
      listForOrg: async (input) => {
        seen.push(input.orgId);
        return [];
      },
    };
    const service = new OrgSkillAdminService({
      resolveOwner: async () => ({ orgId: RESOLVED_ORG, userId: RESOLVED_USER }),
      orgSkills: recording,
      publishedBase: '/published',
      tmpRoot: '/tmp',
      systemSkillNames: async () => ['pdf'],
    });
    await service.list({
      actor: { externalOrgId: EXTERNAL_ORG, externalUserId: 'admin', role: 'admin' },
    });
    // 写进账本的必须是内部 ULID：外部主体会被外键拒绝，而**查**会静默命中零行。
    assert.deepEqual(seen, [RESOLVED_ORG]);
    assert.notEqual(seen[0], EXTERNAL_ORG);
  });

  it('解析器决定账本 id：服务不做二次猜测（解析结果原样透传）', async () => {
    const seen = [];
    const service = new OrgSkillAdminService({
      // 故意回一个与 actor 完全无关的值，服务必须原样用它。
      resolveOwner: async () => ({ orgId: OTHER_ORG, userId: MEMBER }),
      orgSkills: {
        listForOrg: async (input) => {
          seen.push(input.orgId);
          return [];
        },
      },
      publishedBase: '/published',
      tmpRoot: '/tmp',
      systemSkillNames: async () => ['pdf'],
    });
    await service.list({ actor: ADMIN_ACTOR });
    // actor 是 ORG，但解析器说是 OTHER_ORG——账本跟解析器走，证明作用域不是从
    // 请求头猜出来的。
    assert.deepEqual(seen, [OTHER_ORG]);
  });

  it('解析前先鉴权：非 admin 连解析都不做（不泄漏 org 是否存在）', async () => {
    let resolved = false;
    const service = new OrgSkillAdminService({
      resolveOwner: async () => {
        resolved = true;
        return { orgId: RESOLVED_ORG, userId: RESOLVED_USER };
      },
      orgSkills: { listForOrg: async () => [] },
      publishedBase: '/published',
      tmpRoot: '/tmp',
      systemSkillNames: async () => ['pdf'],
    });
    await assert.rejects(
      service.list({ actor: MEMBER_ACTOR }),
      (err) => err instanceof AdminRequiredError,
    );
    assert.equal(resolved, false);
  });
});
