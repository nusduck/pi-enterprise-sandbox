/**
 * org 层发布服务（ADR 0015 D5/D6，design §5.1/§5.3）。
 *
 * 用**真实的归档与真实的磁盘字节**跑，因为这一层的价值全在「字节怎么落、账本写的
 * 摘要是不是那份字节」：用假 zip 或假文件系统就绕过了它唯一要守的东西。
 *
 * 这里钉的是顺序与不变量，不是实现：
 * - 解包→校验→落字节→写账本；失败时任一步都不会让账本出现这个版本；
 * - 摘要来自**复制后的暂存字节**，不是上传的 zip（zip 的压缩方式与顺序不该决定身份）;
 * - org 名与系统名冲突时拒绝（ADR 0015 D7）；
 * - 批准路径复制的是作者的**已发布**版本，重算摘要不等即拒绝。
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createStoredZip } from '../support/stored-zip.js';
import {
  OrgSkillPublishError,
  publishOrgSkillArchive,
  publishOrgSkillFromPublishedVersion,
} from '../../src/skills/org-publish.js';
import { OrgSkillRepository } from '../../src/infrastructure/mysql/repositories/org-skill-repository.js';
import { createFakeKnex, createFakeState } from './fake-knex.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const ADMIN = '01K0G2PAV8FPMVC9QHJG7JPN50';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN51';

function skillMd(name, description = 'd') {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`;
}

let seq = 0;
async function makeHarness(opts = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-org-publish-'));
  const publishedBase = path.join(root, 'published');
  const tmpRoot = path.join(root, 'tmp');
  await fsp.mkdir(publishedBase, { recursive: true });
  await fsp.mkdir(tmpRoot, { recursive: true });
  const orgSkills = new OrgSkillRepository(createFakeKnex(createFakeState()), {
    generateId: () => `01K0G2PAV8FPMVC9QHJG7JPN${String(60 + seq++).slice(-2)}`,
  });
  return {
    root,
    publishedBase,
    tmpRoot,
    orgSkills,
    deps: {
      orgSkills,
      publishedBase,
      tmpRoot,
      systemSkillNames: async () => opts.systemNames ?? ['pdf', 'xlsx'],
    },
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

function archive(name, entries = []) {
  return createStoredZip([
    { name: `${name}/SKILL.md`, content: skillMd(name, '周报技能') },
    ...entries,
  ]);
}

describe('publishOrgSkillArchive', () => {
  it('落字节到 <base>/<orgId>/_org，并把账本写成同一份摘要', async () => {
    const h = await makeHarness();
    try {
      const result = await publishOrgSkillArchive(h.deps, {
        orgId: ORG,
        archiveBytes: archive('sales-weekly', [{ name: 'sales-weekly/scripts/run.py', content: 'print(1)\n' }]),
        archiveName: 'sales-weekly.zip',
        publishedByUserId: ADMIN,
        originKind: 'admin_upload',
      });

      // 字节落在 org owner 根下，与用户层同一套布局。
      assert.equal(
        result.publishedPath,
        path.join(h.publishedBase, ORG, '_org', 'sales-weekly', '.v', result.version.contentDigest, 'sales-weekly'),
      );
      assert.equal(await fsp.readFile(path.join(result.publishedPath, 'SKILL.md'), 'utf8'), skillMd('sales-weekly', '周报技能'));
      // 侧车存在（读侧车是「发布完成」的判据）。
      const sidecar = JSON.parse(
        await fsp.readFile(path.join(h.publishedBase, ORG, '_org', 'sales-weekly', '.v', `${result.version.contentDigest}.json`), 'utf8'),
      );
      assert.equal(sidecar.contentDigest, result.version.contentDigest);
      assert.equal(sidecar.fileCount, 2);

      // 账本行与字节一致。
      assert.equal(result.version.name, 'sales-weekly');
      assert.equal(result.version.fileCount, 2);
      assert.equal(result.version.originKind, 'admin_upload');
      assert.equal(result.version.description, '周报技能');
      assert.equal(result.reused, false);

      const stored = await h.orgSkills.getVersion({
        orgId: ORG, name: 'sales-weekly', contentDigest: result.version.contentDigest,
      });
      assert.equal(stored?.status, 'active');
    } finally {
      await h.cleanup();
    }
  });

  it('同一份字节重复发布：字节复用、账本不新增版本行', async () => {
    const h = await makeHarness();
    try {
      const bytes = archive('sales-weekly');
      const first = await publishOrgSkillArchive(h.deps, {
        orgId: ORG, archiveBytes: bytes, archiveName: 'a.zip',
        publishedByUserId: ADMIN, originKind: 'admin_upload',
      });
      const second = await publishOrgSkillArchive(h.deps, {
        orgId: ORG, archiveBytes: bytes, archiveName: 'a.zip',
        publishedByUserId: ADMIN, originKind: 'admin_upload',
      });
      assert.equal(second.reused, true);
      assert.equal(second.version.contentDigest, first.version.contentDigest);
      const [group] = await h.orgSkills.listForOrg({ orgId: ORG });
      assert.equal(group.versions.length, 1);
    } finally {
      await h.cleanup();
    }
  });

  it('org 名与系统名冲突时拒绝，且账本里不留痕迹（ADR 0015 D7）', async () => {
    const h = await makeHarness();
    try {
      await assert.rejects(
        () => publishOrgSkillArchive(h.deps, {
          orgId: ORG, archiveBytes: archive('pdf'), archiveName: 'pdf.zip',
          publishedByUserId: ADMIN, originKind: 'admin_upload',
        }),
        // 归档安装阶段就会挡掉（与用户层同一条规则、同一处实现）。
        /is a bundled system Skill and cannot be replaced/,
      );
      assert.deepEqual(await h.orgSkills.listForOrg({ orgId: ORG }), []);
      // 失败也不能把半成品留在发布存储里。
      const orgRoot = path.join(h.publishedBase, ORG, '_org');
      assert.deepEqual(await fsp.readdir(orgRoot).catch(() => []), []);
    } finally {
      await h.cleanup();
    }
  });

  it('不合法的归档被拒绝，账本与发布存储都不留东西', async () => {
    const h = await makeHarness();
    try {
      await assert.rejects(
        () => publishOrgSkillArchive(h.deps, {
          orgId: ORG, archiveBytes: Buffer.from('not a zip'), archiveName: 'x.zip',
          publishedByUserId: ADMIN, originKind: 'admin_upload',
        }),
      );
      assert.deepEqual(await h.orgSkills.listForOrg({ orgId: ORG }), []);
    } finally {
      await h.cleanup();
    }
  });

  it('临时区不在发布存储里，且用完就清（半成品不能被列表/GC 看见）', async () => {
    const h = await makeHarness();
    try {
      await publishOrgSkillArchive(h.deps, {
        orgId: ORG, archiveBytes: archive('sales-weekly'), archiveName: 'a.zip',
        publishedByUserId: ADMIN, originKind: 'admin_upload',
      });
      assert.deepEqual(await fsp.readdir(h.tmpRoot), [], 'staging must be cleaned up');
    } finally {
      await h.cleanup();
    }
  });
});

describe('publishOrgSkillFromPublishedVersion（批准路径）', () => {
  it('复制已发布版本并核对摘要一致 → 发布成功，来源记为 share_request', async () => {
    const h = await makeHarness();
    try {
      // 先把作者的版本发布到**用户**层，模拟「已启用」。
      const { publishDraftVersion } = await import('../../src/skills/enablement.js');
      const userRoot = path.join(h.publishedBase, ORG, USER);
      const draft = path.join(h.root, 'draft', 'mine');
      await fsp.mkdir(draft, { recursive: true });
      await fsp.writeFile(path.join(draft, 'SKILL.md'), skillMd('mine', '我的技能'));
      const enabled = await publishDraftVersion({
        draftPackageDir: draft, publishedRoot: userRoot, expectedName: 'mine',
      });

      const result = await publishOrgSkillFromPublishedVersion(
        {
          ...h.deps,
          resolvePublishedPackageDir: async ({ name, contentDigest }) =>
            name === 'mine' && contentDigest === enabled.contentDigest
              ? { packageDir: enabled.publishedPath }
              : null,
        },
        {
          orgId: ORG, requesterUserId: USER, name: 'mine',
          contentDigest: enabled.contentDigest, originRequestId: 'REQ1',
          publishedByUserId: ADMIN,
        },
      );
      assert.equal(result.version.originKind, 'share_request');
      assert.equal(result.version.originUserId, USER);
      assert.equal(result.version.originRequestId, 'REQ1');
      assert.equal(result.version.contentDigest, enabled.contentDigest);
    } finally {
      await h.cleanup();
    }
  });

  it('摘要不一致时拒绝（作者在申请之后改过），带两个摘要', async () => {
    const h = await makeHarness();
    try {
      const { publishDraftVersion } = await import('../../src/skills/enablement.js');
      const userRoot = path.join(h.publishedBase, ORG, USER);
      const draft = path.join(h.root, 'draft', 'mine');
      await fsp.mkdir(draft, { recursive: true });
      await fsp.writeFile(path.join(draft, 'SKILL.md'), skillMd('mine'));
      const enabled = await publishDraftVersion({
        draftPackageDir: draft, publishedRoot: userRoot, expectedName: 'mine',
      });

      const pinned = 'a'.repeat(64);
      await assert.rejects(
        () => publishOrgSkillFromPublishedVersion(
          {
            ...h.deps,
            resolvePublishedPackageDir: async () => ({ packageDir: enabled.publishedPath }),
          },
          {
            orgId: ORG, requesterUserId: USER, name: 'mine',
            contentDigest: pinned, originRequestId: 'REQ1',
            publishedByUserId: ADMIN,
          },
        ),
        (err) => {
          assert.ok(err instanceof OrgSkillPublishError);
          assert.equal(err.code, 'SKILL_SHARE_DIGEST_MISMATCH');
          // 两个摘要都要带回去，人才能判断是「作者改过」还是「申请时看错了」。
          assert.match(err.message, new RegExp(pinned));
          assert.match(err.message, new RegExp(enabled.contentDigest));
          return true;
        },
      );
      assert.deepEqual(await h.orgSkills.listForOrg({ orgId: ORG }), []);
    } finally {
      await h.cleanup();
    }
  });

  it('作者没有这个已发布版本时拒绝（不能凭一个摘要就发布）', async () => {
    const h = await makeHarness();
    try {
      await assert.rejects(
        () => publishOrgSkillFromPublishedVersion(
          { ...h.deps, resolvePublishedPackageDir: async () => null },
          {
            orgId: ORG, requesterUserId: USER, name: 'mine',
            contentDigest: 'a'.repeat(64), originRequestId: 'REQ1',
            publishedByUserId: ADMIN,
          },
        ),
        (err) => err instanceof OrgSkillPublishError && err.code === 'SKILL_SHARE_SOURCE_MISSING',
      );
    } finally {
      await h.cleanup();
    }
  });
});
