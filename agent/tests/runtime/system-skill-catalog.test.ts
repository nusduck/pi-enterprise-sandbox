/**
 * 系统层 Skill 目录（`skills/system-catalog.ts`）。
 *
 * 这是 `skillPolicy.system` 的「什么名字存在」权威：配置面保存时的
 * `SKILL_SYSTEM_UNKNOWN`、Run 解析时的求交与诊断都读它。所以这里钉的是
 * 「目录里有什么」与「读失败时怎么办」，而不是任何展示格式。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { SystemSkillCatalog } from '../../src/skills/system-catalog.js';

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-system-skills-'));
}

function writeSkill(root: string, dir: string, frontmatter: string, body = 'body\n'): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}`);
}

describe('SystemSkillCatalog', () => {
  it('系统根不存在 → 空目录，不抛（开发机没挂载系统根是正常状态）', async () => {
    const root = join(fixture(), 'does-not-exist');
    const catalog = new SystemSkillCatalog({ root });
    assert.deepEqual(await catalog.list(), []);
    assert.deepEqual(await catalog.names(), []);
  });

  it('列出包名与描述，按名字排序，忽略隐藏目录与非目录条目', async () => {
    const root = fixture();
    try {
      writeSkill(root, 'xlsx', 'name: xlsx\ndescription: 表格处理');
      writeSkill(root, 'pdf', 'name: pdf\ndescription: PDF 处理');
      mkdirSync(join(root, '.v'), { recursive: true });
      writeFileSync(join(root, 'README.md'), 'not a package');
      const catalog = new SystemSkillCatalog({ root });
      assert.deepEqual(await catalog.list(), [
        { name: 'pdf', description: 'PDF 处理' },
        { name: 'xlsx', description: '表格处理' },
      ]);
      assert.deepEqual(await catalog.names(), ['pdf', 'xlsx']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('坏包降级为「只有目录名」而不是让整份目录报错', async () => {
    const root = fixture();
    try {
      writeSkill(root, 'good', 'name: good\ndescription: ok');
      // 没有 SKILL.md：不进目录（它不是一个包）。
      mkdirSync(join(root, 'empty-dir'), { recursive: true });
      // frontmatter 坏掉：仍在目录里（release 里确实有这个目录），描述为空。
      writeSkill(root, 'broken', 'name: [unclosed', 'body');
      const catalog = new SystemSkillCatalog({ root });
      const names = await catalog.names();
      assert.deepEqual([...names], ['broken', 'good']);
      const broken = (await catalog.list()).find((entry) => entry.name === 'broken');
      assert.equal(broken?.description, '');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('缓存：TTL 内不重扫，invalidate() 之后立刻重扫', async () => {
    const root = fixture();
    try {
      writeSkill(root, 'pdf', 'name: pdf\ndescription: first');
      const catalog = new SystemSkillCatalog({ root, cacheMs: 10_000 });
      assert.equal((await catalog.list(1_000))[0]?.description, 'first');

      writeSkill(root, 'pdf', 'name: pdf\ndescription: second');
      // TTL 内：仍是旧值（这就是缓存的意义）。
      assert.equal((await catalog.list(2_000))[0]?.description, 'first');
      // TTL 之后重扫。
      assert.equal((await catalog.list(20_000))[0]?.description, 'second');

      writeSkill(root, 'pdf', 'name: pdf\ndescription: third');
      catalog.invalidate();
      assert.equal((await catalog.list(20_001))[0]?.description, 'third');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
