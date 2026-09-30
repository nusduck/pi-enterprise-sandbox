/**
 * 一个 Run 的有效 Skill 清单（`skills/run-skills.ts`，ADR 0015 D1/D7/D8，design §3/§6.1）。
 *
 * 这里钉的是**清单计算结果**：三层怎么求交、优先级怎么取胜者、被排除的写什么诊断。
 * 挂载与发现由后续阶段消费这份结果，所以它是「配置是否代表行为」的判定点。
 *
 * 夹具用真实的发布存储布局（`.v/<digest>/<name>/SKILL.md` + 侧车），因为
 * `readPublishedVersion` 核对的就是这套字节——用假数据会绕过它要守的东西。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveRunSkills } from '../../src/skills/run-skills.js';
import type { SkillPolicy } from '@dsh/contract/skill-policy.js';

const ORG = 'org1';
const USER = 'user1';

function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 按 S1 布局发布一个版本：`.v/<digest>/<name>/SKILL.md` 加侧车。
 * @returns 该版本的摘要
 */
function publish(ownerRoot: string, name: string, body: string): string {
  const contentDigest = digestOf(body);
  const versionDir = join(ownerRoot, name, '.v', contentDigest, name);
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(join(versionDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}`);
  writeFileSync(
    join(ownerRoot, name, '.v', `${contentDigest}.json`),
    JSON.stringify({
      name,
      contentDigest,
      fileCount: 1,
      totalBytes: body.length,
      publishedAt: new Date(0).toISOString(),
    }),
  );
  return contentDigest;
}

interface Harness {
  readonly root: string;
  readonly userBase: string;
  readonly orgBase: string;
  cleanup(): void;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'dsh-run-skills-'));
  return {
    root,
    userBase: join(root, 'published'),
    orgBase: join(root, 'published'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const NO_DIAGNOSTICS: readonly unknown[] = [];

function policy(overrides: Partial<SkillPolicy> = {}): SkillPolicy {
  return {
    system: { mode: 'all', names: [] },
    org: [],
    user: 'allow',
    ...overrides,
  } as SkillPolicy;
}

describe('resolveRunSkills：system 层', () => {
  it('mode: all 展开成整个 release', async () => {
    const h = harness();
    try {
      const result = await resolveRunSkills({
        orgId: ORG,
        userId: USER,
        userPhysicalBase: h.userBase,
        orgPhysicalBase: h.orgBase,
        systemRoot: '/home/sandbox/skill',
        allSystemNames: ['pdf', 'xlsx'],
        policy: policy(),
        deps: { listEnabled: async () => [] },
      });
      assert.deepEqual([...result.systemNames], ['pdf', 'xlsx']);
      assert.deepEqual(result.discoverable[0], {
        kind: 'system',
        root: '/home/sandbox/skill',
        filtered: true,
        names: ['pdf', 'xlsx'],
      });
      assert.deepEqual([...result.diagnostics], []);
    } finally {
      h.cleanup();
    }
  });

  it('mode: none 一个系统包都不带', async () => {
    const h = harness();
    try {
      const result = await resolveRunSkills({
        orgId: ORG,
        userId: USER,
        userPhysicalBase: h.userBase,
        orgPhysicalBase: h.orgBase,
        systemRoot: '/home/sandbox/skill',
        allSystemNames: ['pdf', 'xlsx'],
        policy: policy({ system: { mode: 'none', names: [] } as SkillPolicy['system'] }),
        deps: { listEnabled: async () => [] },
      });
      assert.deepEqual([...result.systemNames], []);
    } finally {
      h.cleanup();
    }
  });

  it('mode: allowlist 只带名单里的包；名单里已不在 release 的名字写诊断', async () => {
    const h = harness();
    try {
      const result = await resolveRunSkills({
        orgId: ORG,
        userId: USER,
        userPhysicalBase: h.userBase,
        orgPhysicalBase: h.orgBase,
        systemRoot: '/home/sandbox/skill',
        allSystemNames: ['pdf', 'xlsx'],
        // `gone` 是保存之后 release 删掉的名字。
        policy: policy({ system: { mode: 'allowlist', names: ['pdf', 'gone'] } as SkillPolicy['system'] }),
        deps: { listEnabled: async () => [] },
      });
      assert.deepEqual([...result.systemNames], ['pdf']);
      assert.deepEqual(
        result.diagnostics.map((d) => [d.code, d.scope, d.name]),
        [['not_in_release', 'system', 'gone']],
      );
    } finally {
      h.cleanup();
    }
  });

  it('省略 skillPolicy（null）等价于 all + allow user，即当前行为', async () => {
    const h = harness();
    try {
      const ownerRoot = join(h.userBase, ORG, USER);
      mkdirSync(ownerRoot, { recursive: true });
      const digest = publish(ownerRoot, 'mine', 'mine body');
      const result = await resolveRunSkills({
        orgId: ORG,
        userId: USER,
        userPhysicalBase: h.userBase,
        orgPhysicalBase: h.orgBase,
        systemRoot: '/home/sandbox/skill',
        allSystemNames: ['pdf'],
        policy: null,
        deps: { listEnabled: async () => [{ name: 'mine', contentDigest: digest }] },
      });
      assert.deepEqual([...result.systemNames], ['pdf']);
      assert.deepEqual(result.published.map((p) => [p.kind, p.name]), [['user', 'mine']]);
    } finally {
      h.cleanup();
    }
  });
});

describe('resolveRunSkills：user 层开关', () => {
  it('user: deny 时用户已启用包不可见', async () => {
    const h = harness();
    try {
      const ownerRoot = join(h.userBase, ORG, USER);
      mkdirSync(ownerRoot, { recursive: true });
      const digest = publish(ownerRoot, 'mine', 'mine body');
      let listed = 0;
      const result = await resolveRunSkills({
        orgId: ORG,
        userId: USER,
        userPhysicalBase: h.userBase,
        orgPhysicalBase: h.orgBase,
        systemRoot: '/home/sandbox/skill',
        allSystemNames: [],
        policy: policy({ user: 'deny' }),
        deps: {
          listEnabled: async () => {
            listed += 1;
            return [{ name: 'mine', contentDigest: digest }];
          },
        },
      });
      assert.deepEqual([...result.published], []);
      // deny 是「不带」，不是「列出来再过滤」——账本根本不该被读。
      assert.equal(listed, 0);
    } finally {
      h.cleanup();
    }
  });

  it('user: allow 时账本里的版本被核对并带上；坏包（缺侧车）只排除该包并写诊断', async () => {
    const h = harness();
    try {
      const ownerRoot = join(h.userBase, ORG, USER);
      mkdirSync(ownerRoot, { recursive: true });
      const good = publish(ownerRoot, 'good', 'good body');
      const bad = digestOf('bad body');
      // 只建版本目录，不写侧车 → 视为未发布完成。
      mkdirSync(join(ownerRoot, 'bad', '.v', bad, 'bad'), { recursive: true });
      const result = await resolveRunSkills({
        orgId: ORG,
        userId: USER,
        userPhysicalBase: h.userBase,
        orgPhysicalBase: h.orgBase,
        systemRoot: '/home/sandbox/skill',
        allSystemNames: [],
        policy: policy(),
        deps: {
          listEnabled: async () => [
            { name: 'good', contentDigest: good },
            { name: 'bad', contentDigest: bad },
          ],
        },
      });
      assert.deepEqual(result.published.map((p) => p.name), ['good']);
      assert.deepEqual(
        result.diagnostics.map((d) => [d.code, d.scope, d.name]),
        [['user_version_unusable', 'user', 'bad']],
      );
    } finally {
      h.cleanup();
    }
  });
});

describe('resolveRunSkills：org 层', () => {
  it('绑定未吊销的 org 版本 → 进清单，kind 为 org', async () => {
    const h = harness();
    try {
      const orgRoot = join(h.orgBase, ORG, '_org');
      mkdirSync(orgRoot, { recursive: true });
      const digest = publish(orgRoot, 'sales-weekly', 'sales body');
      const result = await resolveRunSkills({
        orgId: ORG,
        userId: USER,
        userPhysicalBase: h.userBase,
        orgPhysicalBase: h.orgBase,
        systemRoot: '/home/sandbox/skill',
        allSystemNames: [],
        policy: policy({ org: [{ name: 'sales-weekly', contentDigest: digest }] }),
        deps: {
          listEnabled: async () => [],
          readOrgVersion: async () => ({ status: 'active' }),
        },
      });
      assert.deepEqual(result.published.map((p) => [p.kind, p.name]), [['org', 'sales-weekly']]);
      assert.deepEqual([...result.diagnostics], []);
    } finally {
      h.cleanup();
    }
  });

  it('revoked / 不存在 → 排除并写各自的诊断', async () => {
    const h = harness();
    try {
      const result = await resolveRunSkills({
        orgId: ORG,
        userId: USER,
        userPhysicalBase: h.userBase,
        orgPhysicalBase: h.orgBase,
        systemRoot: '/home/sandbox/skill',
        allSystemNames: [],
        policy: policy({ org: [
          { name: 'gone', contentDigest: 'a'.repeat(64) },
          { name: 'killed', contentDigest: 'b'.repeat(64) },
        ] }),
        deps: {
          listEnabled: async () => [],
          readOrgVersion: async ({ name }) =>
            name === 'killed' ? { status: 'revoked' as const } : undefined,
        },
      });
      assert.deepEqual([...result.published], []);
      assert.deepEqual(
        result.diagnostics.map((d) => [d.code, d.name]).sort(),
        [['missing', 'gone'], ['revoked', 'killed']],
      );
    } finally {
      h.cleanup();
    }
  });

  it('deprecated 的已钉版本照常运行（只挡新绑定）', async () => {
    const h = harness();
    try {
      const orgRoot = join(h.orgBase, ORG, '_org');
      mkdirSync(orgRoot, { recursive: true });
      const digest = publish(orgRoot, 'old-but-ok', 'body');
      const result = await resolveRunSkills({
        orgId: ORG,
        userId: USER,
        userPhysicalBase: h.userBase,
        orgPhysicalBase: h.orgBase,
        systemRoot: '/home/sandbox/skill',
        allSystemNames: [],
        policy: policy({ org: [{ name: 'old-but-ok', contentDigest: digest }] }),
        deps: {
          listEnabled: async () => [],
          readOrgVersion: async () => ({ status: 'deprecated' as const }),
        },
      });
      assert.deepEqual(result.published.map((p) => p.name), ['old-but-ok']);
    } finally {
      h.cleanup();
    }
  });
});

describe('resolveRunSkills：优先级与重名（ADR 0015 D7）', () => {
  it('system 胜过同名 org/user，落败项写 name_conflict', async () => {
    const h = harness();
    try {
      const orgRoot = join(h.orgBase, ORG, '_org');
      mkdirSync(orgRoot, { recursive: true });
      const orgDigest = publish(orgRoot, 'pdf', 'org pdf');
      const result = await resolveRunSkills({
        orgId: ORG,
        userId: USER,
        userPhysicalBase: h.userBase,
        orgPhysicalBase: h.orgBase,
        systemRoot: '/home/sandbox/skill',
        allSystemNames: ['pdf'],
        policy: policy({ org: [{ name: 'pdf', contentDigest: orgDigest }] }),
        deps: {
          listEnabled: async () => [],
          readOrgVersion: async () => ({ status: 'active' }),
        },
      });
      assert.deepEqual([...result.systemNames], ['pdf']);
      assert.deepEqual([...result.published], []);
      assert.deepEqual(
        result.diagnostics.map((d) => [d.code, d.scope, d.name]),
        [['name_conflict', 'org', 'pdf']],
      );
    } finally {
      h.cleanup();
    }
  });

  it('org 胜过同名 user，user 拷贝被排除并写 name_conflict', async () => {
    const h = harness();
    try {
      const orgRoot = join(h.orgBase, ORG, '_org');
      const userRoot = join(h.userBase, ORG, USER);
      mkdirSync(orgRoot, { recursive: true });
      mkdirSync(userRoot, { recursive: true });
      const orgDigest = publish(orgRoot, 'shared', 'org body');
      const userDigest = publish(userRoot, 'shared', 'user body');
      const result = await resolveRunSkills({
        orgId: ORG,
        userId: USER,
        userPhysicalBase: h.userBase,
        orgPhysicalBase: h.orgBase,
        systemRoot: '/home/sandbox/skill',
        allSystemNames: [],
        policy: policy({ org: [{ name: 'shared', contentDigest: orgDigest }] }),
        deps: {
          listEnabled: async () => [{ name: 'shared', contentDigest: userDigest }],
          readOrgVersion: async () => ({ status: 'active' }),
        },
      });
      assert.deepEqual(result.published.map((p) => [p.kind, p.name]), [['org', 'shared']]);
      assert.deepEqual(
        result.diagnostics.map((d) => [d.code, d.scope, d.name]),
        [['name_conflict', 'user', 'shared']],
      );
    } finally {
      h.cleanup();
    }
  });

  it('每个 Run 只出现一次同名包（清单里无重复）', async () => {
    const h = harness();
    try {
      const userRoot = join(h.userBase, ORG, USER);
      mkdirSync(userRoot, { recursive: true });
      const digestA = publish(userRoot, 'a', 'a');
      const digestB = publish(userRoot, 'b', 'b');
      const result = await resolveRunSkills({
        orgId: ORG,
        userId: USER,
        userPhysicalBase: h.userBase,
        orgPhysicalBase: h.orgBase,
        systemRoot: '/home/sandbox/skill',
        allSystemNames: ['s1', 's2'],
        policy: policy(),
        deps: {
          listEnabled: async () => [
            { name: 'a', contentDigest: digestA },
            { name: 'b', contentDigest: digestB },
          ],
        },
      });
      const names = [
        ...result.systemNames,
        ...result.published.map((p) => p.name),
      ];
      assert.deepEqual(names, [...new Set(names)]);
    } finally {
      h.cleanup();
    }
  });
});
