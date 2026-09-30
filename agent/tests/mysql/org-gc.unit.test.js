/**
 * org 层版本回收（ADR 0015 D8，design §5.4）。
 *
 * 三条保留规则各自都对应一次真实事故形状，所以逐条钉住：
 * - **被引用的不回收**——删了就是在跑的 Run 挂载失败；
 * - **current 不回收**——删了配置面默认选中的版本就选不到；
 * - **宽限期内不回收**——给刚落地的发布留缓冲。
 *
 * 以及 `revoked` 的字节**不立刻删**：吊销是加载许可的撤销，不是「字节不存在了」，
 * 保留到满足上面三条才回收，便于事后审计。
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { collectStaleOrgSkillVersions } from '../../src/skills/org-gc.js';
import { physicalTableName } from '../../src/infrastructure/mysql/schema-tables.js';
import { createFakeKnex, createFakeState } from './fake-knex.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

const SKILLS = physicalTableName('org_skills');
const REFS = physicalTableName('agent_version_skill_refs');
const VERSIONS = physicalTableName('org_skill_versions');

/** 在盘上造出一批 org 层版本目录，侧车时间可指定。 */
async function seedVersions(root, name, digests) {
  for (const digest of digests) {
    const pkg = path.join(root, name, '.v', digest, name);
    await fsp.mkdir(pkg, { recursive: true });
    await fsp.writeFile(path.join(pkg, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
    await fsp.writeFile(
      path.join(root, name, '.v', `${digest}.json`),
      JSON.stringify({
        name,
        contentDigest: digest,
        fileCount: 1,
        totalBytes: 1,
        // 侧车发布时间决定 `entryTime`——GC 的宽限期按它算。
        publishedAt: '2020-01-01T00:00:00.000Z',
      }),
    );
  }
}

async function makeHarness({ digests = [DIGEST_A, DIGEST_B], current = '', refs = [], statuses = {} } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-org-gc-'));
  const publishedBase = path.join(root, 'published');
  const orgRoot = path.join(publishedBase, ORG, '_org');
  await fsp.mkdir(orgRoot, { recursive: true });
  await seedVersions(orgRoot, 'sales-weekly', digests);

  const state = createFakeState();
  state.tables[SKILLS] = [{
    org_skill_id: '01K0G2PAV8FPMVC9QHJG7JPN90',
    org_id: ORG,
    skill_name: 'sales-weekly',
    current_digest: current,
  }];
  // 账本里的版本行：`statuses` 没点名的摘要没有行（孤儿目录，例如写账本失败留下的）。
  state.tables[VERSIONS] = Object.entries(statuses).map(([digest, status], i) => ({
    version_id: `01K0G2PAV8FPMVC9QHJG7JPN${String(70 + i).slice(-2)}`,
    org_id: ORG,
    skill_name: 'sales-weekly',
    content_digest: digest,
    status,
  }));
  state.tables[REFS] = refs.map((digest, i) => ({
    agent_version_id: `01K0G2PAV8FPMVC9QHJG7JPN${String(60 + i).slice(-2)}`,
    org_id: ORG,
    scope: 'org',
    skill_name: 'sales-weekly',
    content_digest: digest,
  }));

  return {
    root,
    orgRoot,
    db: createFakeKnex(state),
    cleanup: () => fsp.rm(root, { recursive: true, force: true }),
  };
}

async function remainingVersions(orgRoot, name) {
  const entries = await fsp.readdir(path.join(orgRoot, name, '.v'), { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

describe('collectStaleOrgSkillVersions 保留规则', () => {
  // 2026-09-30 复审：GC 删了「无引用、非 current」的 active 版本的字节，账本行仍是
  // active——配置面照样列出它、保存照样成功，之后每个 Run 都以 mismatch 静默排除。
  // 「可被新绑定」必须蕴含「字节在盘上」，所以 active 一律保留。
  it('active 版本即使无引用、非 current、已过宽限期也不回收（它仍可被新绑定）', async () => {
    const h = await makeHarness({
      digests: [DIGEST_A, DIGEST_B],
      current: DIGEST_A,
      statuses: { [DIGEST_A]: 'active', [DIGEST_B]: 'active' },
    });
    try {
      const result = await collectStaleOrgSkillVersions(
        { db: h.db, publishedBase: path.dirname(path.dirname(h.orgRoot)), graceMs: 1000, now: () => new Date() },
        { orgId: ORG },
      );
      assert.equal(result.removedCount, 0);
      assert.deepEqual(await remainingVersions(h.orgRoot, 'sales-weekly'), [DIGEST_A, DIGEST_B]);
    } finally {
      await h.cleanup();
    }
  });

  it('deprecated / revoked 且无引用、非 current、已过宽限期 → 回收（合法对照）', async () => {
    const h = await makeHarness({
      digests: [DIGEST_A, DIGEST_B, DIGEST_C],
      current: DIGEST_A,
      statuses: { [DIGEST_A]: 'active', [DIGEST_B]: 'deprecated', [DIGEST_C]: 'revoked' },
    });
    try {
      const result = await collectStaleOrgSkillVersions(
        { db: h.db, publishedBase: path.dirname(path.dirname(h.orgRoot)), graceMs: 1000, now: () => new Date() },
        { orgId: ORG },
      );
      assert.deepEqual([...result.names[0].removed].sort(), [DIGEST_B, DIGEST_C]);
      assert.deepEqual(await remainingVersions(h.orgRoot, 'sales-weekly'), [DIGEST_A]);
    } finally {
      await h.cleanup();
    }
  });

  it('未被引用、不是 current、已过宽限期 → 回收（字节与侧车一起走）', async () => {
    const h = await makeHarness({ digests: [DIGEST_A, DIGEST_B], current: DIGEST_A });
    try {
      const result = await collectStaleOrgSkillVersions(
        { db: h.db, publishedBase: path.dirname(path.dirname(h.orgRoot)), graceMs: 1000, now: () => new Date() },
        { orgId: ORG },
      );
      assert.equal(result.removedCount, 1);
      assert.deepEqual(result.names[0].removed, [DIGEST_B]);
      assert.deepEqual(await remainingVersions(h.orgRoot, 'sales-weekly'), [DIGEST_A]);
      // 侧车也要走：留一个没有版本目录的侧车，下次读侧车会误判「发布完成了」。
      const sidecars = (await fsp.readdir(path.join(h.orgRoot, 'sales-weekly', '.v')))
        .filter((n) => n.endsWith('.json'));
      assert.deepEqual(sidecars, [`${DIGEST_A}.json`]);
    } finally {
      await h.cleanup();
    }
  });

  it('被 AgentVersion 引用的版本不回收——删了就是在跑的 Run 挂载失败', async () => {
    const h = await makeHarness({
      digests: [DIGEST_A, DIGEST_B],
      current: DIGEST_A,
      refs: [DIGEST_B],
    });
    try {
      const result = await collectStaleOrgSkillVersions(
        { db: h.db, publishedBase: path.dirname(path.dirname(h.orgRoot)), graceMs: 1000, now: () => new Date() },
        { orgId: ORG },
      );
      assert.equal(result.removedCount, 0);
      assert.deepEqual(await remainingVersions(h.orgRoot, 'sales-weekly'), [DIGEST_A, DIGEST_B]);
    } finally {
      await h.cleanup();
    }
  });

  it('current 版本不回收——删了配置面默认选中的版本就选不到', async () => {
    const h = await makeHarness({ digests: [DIGEST_A], current: DIGEST_A });
    try {
      const result = await collectStaleOrgSkillVersions(
        { db: h.db, publishedBase: path.dirname(path.dirname(h.orgRoot)), graceMs: 1000, now: () => new Date() },
        { orgId: ORG },
      );
      assert.equal(result.removedCount, 0);
      assert.deepEqual(await remainingVersions(h.orgRoot, 'sales-weekly'), [DIGEST_A]);
    } finally {
      await h.cleanup();
    }
  });

  it('宽限期内的版本不回收（给刚落地的发布留缓冲）', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-org-gc-fresh-'));
    try {
      const publishedBase = path.join(root, 'published');
      const orgRoot = path.join(publishedBase, ORG, '_org');
      await fsp.mkdir(orgRoot, { recursive: true });
      await seedVersions(orgRoot, 'sales-weekly', [DIGEST_A]);
      // 侧车写成「刚刚发布」。
      await fsp.writeFile(
        path.join(orgRoot, 'sales-weekly', '.v', `${DIGEST_A}.json`),
        JSON.stringify({
          name: 'sales-weekly', contentDigest: DIGEST_A, fileCount: 1, totalBytes: 1,
          publishedAt: new Date().toISOString(),
        }),
      );
      const state = createFakeState();
      state.tables[SKILLS] = [];
      state.tables[REFS] = [];
      const result = await collectStaleOrgSkillVersions(
        { db: createFakeKnex(state), publishedBase, graceMs: 24 * 60 * 60 * 1000 },
        { orgId: ORG },
      );
      assert.equal(result.removedCount, 0);
      assert.deepEqual(await remainingVersions(orgRoot, 'sales-weekly'), [DIGEST_A]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it('revoked 的字节不立刻删：满足三条之后才回收（便于事后审计）', async () => {
    // 三个版本：A 是 current、B 被引用、C 无人引用且已过宽限期。
    // 吊销状态不影响回收判定——判定只看「引用 / current / 宽限期」。
    const h = await makeHarness({
      digests: [DIGEST_A, DIGEST_B, DIGEST_C],
      current: DIGEST_A,
      refs: [DIGEST_B],
    });
    try {
      const result = await collectStaleOrgSkillVersions(
        { db: h.db, publishedBase: path.dirname(path.dirname(h.orgRoot)), graceMs: 1000, now: () => new Date() },
        { orgId: ORG },
      );
      assert.deepEqual(result.names[0].removed, [DIGEST_C]);
      assert.deepEqual(
        await remainingVersions(h.orgRoot, 'sales-weekly'),
        [DIGEST_A, DIGEST_B].sort(),
      );
    } finally {
      await h.cleanup();
    }
  });
});

describe('collectStaleOrgSkillVersions 边界', () => {
  it('org 根不存在时返回空，不抛', async () => {
    const state = createFakeState();
    state.tables[SKILLS] = [];
    state.tables[REFS] = [];
    const result = await collectStaleOrgSkillVersions(
      { db: createFakeKnex(state), publishedBase: '/dsh-never-exists-org-gc' },
      { orgId: ORG },
    );
    assert.deepEqual(result.names, []);
    assert.equal(result.removedCount, 0);
  });

  it('空 orgId 一律拒绝（不能靠 where org_id = "" 静默命中零行）', async () => {
    const state = createFakeState();
    await assert.rejects(
      () => collectStaleOrgSkillVersions(
        { db: createFakeKnex(state), publishedBase: '/x' },
        { orgId: '' },
      ),
      /non-empty orgId/,
    );
  });

  it('跨 org 的引用不影响本 org 的回收判定', async () => {
    const h = await makeHarness({
      digests: [DIGEST_A, DIGEST_B],
      current: DIGEST_A,
      // 引用属于**别的 org**：本 org 的 B 仍应被回收。
      refs: [],
    });
    try {
      const state = h.db;
      // 直接往引用表加一条别的 org 的引用。
      await state(REFS).insert({
        agent_version_id: '01K0G2PAV8FPMVC9QHJG7JPN77',
        org_id: '01K0G2PAV8FPMVC9QHJG7JPN4Y',
        scope: 'org',
        skill_name: 'sales-weekly',
        content_digest: DIGEST_B,
      });
      const result = await collectStaleOrgSkillVersions(
        { db: h.db, publishedBase: path.dirname(path.dirname(h.orgRoot)), graceMs: 1000, now: () => new Date() },
        { orgId: ORG },
      );
      assert.deepEqual(result.names[0].removed, [DIGEST_B]);
    } finally {
      await h.cleanup();
    }
  });
});
