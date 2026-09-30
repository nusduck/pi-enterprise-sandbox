/**
 * design §3.3 S1：一个 Run 的 Skill = 系统根 + 账本逐条核对通过的已发布版本。
 * 用户层不扫目录；核对不过的包被排除并告警；身份不合法只给系统根。
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { resolveRunSkillPaths } from '../../src/bootstrap/container-env.js';
import { publishDraftVersion } from '../../src/skills/enablement.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';

test('system root plus ledger-verified versions; broken rows are excluded with a warning', async () => {
  const base = await fsp.mkdtemp(path.join(await fsp.realpath(tmpdir()), 'run-skill-paths-'));
  try {
    const systemRoot = path.join(base, 'system');
    const userBase = path.join(base, 'user');
    const draft = path.join(base, 'draft', 'good');
    await fsp.mkdir(systemRoot, { recursive: true });
    await fsp.mkdir(draft, { recursive: true });
    await fsp.writeFile(path.join(draft, 'SKILL.md'), '---\nname: good\ndescription: d\n---\nbody\n');
    // An unlisted package sitting in the owner root must never be picked up.
    await fsp.mkdir(path.join(userBase, ORG, USER, 'stray'), { recursive: true });
    await fsp.writeFile(path.join(userBase, ORG, USER, 'stray', 'SKILL.md'), '---\nname: stray\ndescription: d\n---\n');
    const published = await publishDraftVersion({
      draftPackageDir: draft,
      publishedRoot: path.join(userBase, ORG, USER),
      expectedName: 'good',
    });

    const warnings: string[] = [];
    const result = await resolveRunSkillPaths(
      { SKILLS_ROOT: systemRoot, SKILLS_USER_ROOT: userBase },
      { orgId: ORG, userId: USER },
      {
        listEnabled: async () => [
          { name: 'good', contentDigest: published.contentDigest },
          { name: 'gone', contentDigest: 'c'.repeat(64) },
        ],
        logger: { warn: (message: unknown) => warnings.push(String(message)) },
      },
    );

    // ADR 0015 D1：系统层带**名单**（发现与挂载同构），用户层带 kind。
    assert.deepEqual(result[0], {
      kind: 'system',
      root: systemRoot,
      filtered: true,
      // 没注入系统目录 → 展开为空。宁可少挂，不可静默多挂。
      names: [],
    });
    assert.equal(result.length, 2);
    assert.deepEqual(result[1], {
      kind: 'user',
      name: 'good',
      contentDigest: published.contentDigest,
      versionRoot: path.dirname(published.publishedPath),
      packageDir: published.publishedPath,
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /"gone" is missing/);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('a malformed identity degrades to the system root with the release names spelled out', async () => {
  let listed = false;
  const result = await resolveRunSkillPaths(
    { SKILLS_ROOT: '/opt/system', SKILLS_USER_ROOT: '/opt/user' },
    { orgId: '../etc', userId: USER },
    {
      // 不读用户账本，也不假装知道 release——名字由注入的目录给出。
      systemSkillNames: ['pdf'],
      listEnabled: async () => {
        listed = true;
        return [];
      },
    },
  );
  // 身份不合法时仍然只给系统层，但系统名单**显式列出**：「不给名单」在 exec 那边
  // 是兼容期旧 Agent 的整树挂载（design §8），新 Agent 不产出它。
  assert.deepEqual(result, [{
    kind: 'system',
    root: '/opt/system',
    filtered: true,
    names: ['pdf'],
  }]);
  assert.equal(listed, false);
});
