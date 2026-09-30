/**
 * 逐包 Skill 逻辑根的 fs 围栏（ADR 0015 D5）：`skill-user` 与 `skill-org`。
 *
 * 两条纪律在这里合成一条可观察的事实：
 * 1. **逐包**：根自身（`/home/sandbox/skill-org`）不可寻址——否则模型能 `ls` 出
 *    所有 org 包的名字，绕过 Agent 侧按名字的发现过滤；
 * 2. **未绑定的包不存在**：逐包挂载之后，没进清单的包在沙箱里根本没有目录，
 *    围栏必须报 `FS_SANDBOX_DENIED` 而不是「文件没找到」。
 *
 * 两层必须各查各的集合：把 org 名拿去 `skill-user` 下找，或反过来，都要被拒。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { FsError } from '@deepseek-ai/dsh-fs';

import type { WorkspaceContext } from '../src/types.js';
import { WorkspaceFileSystem } from '../src/fs/workspace-fs.js';
import { parseSandboxPath, toDisplayPath } from '../src/fs/path-policy.js';

interface Fixture {
  readonly root: string;
  readonly workspace: WorkspaceContext;
  readonly fs: WorkspaceFileSystem;
}

async function makeFixture(): Promise<Fixture> {
  const rawRoot = await mkdtemp(path.join(tmpdir(), 'dsh-exec-skill-tiers-'));
  const root = await realpath(rawRoot);
  const workspaceRoot = path.join(root, 'workspace');
  const tempRoot = path.join(root, 'temp');
  const systemSkillRoot = path.join(root, 'skill');
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  await mkdir(systemSkillRoot, { recursive: true });

  const writePackage = async (base: string, name: string) => {
    const dir = path.join(base, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
    return dir;
  };
  const mine = await writePackage(path.join(root, 'user-skills'), 'mine');
  const shared = await writePackage(path.join(root, 'org-skills'), 'shared');
  // 磁盘上存在、但**不在**清单里：逐包挂载下它不该可达。
  await writePackage(path.join(root, 'org-skills'), 'unselected');

  const workspace: WorkspaceContext = {
    orgId: 'org1',
    userId: 'user1',
    workspaceId: 'ws1',
    workspaceRoot,
    tempRoot,
    systemSkillRoot,
    enabledSkillPackages: [{ name: 'mine', sourcePath: mine }],
    orgSkillPackages: [{ name: 'shared', sourcePath: shared, kind: 'org' }],
    // 这条用例只关心 org/user 两层分根，系统层给空名单（一个都不挂）。
    systemSkillPackages: [],
  };
  const ctx = new Context();
  return { root, workspace, fs: new WorkspaceFileSystem(ctx, workspace) };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as FsError).code;
  }
}

describe('skill-org / skill-user 逐包围栏', () => {
  let fixture: Fixture;

  before(async () => {
    fixture = await makeFixture();
  });
  after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
  });

  test('两层各自可达自己绑定的包', async () => {
    const org = await fixture.fs.readText(
      await fixture.fs.resolve('/home/sandbox/skill-org/shared/SKILL.md'),
    );
    assert.match(org, /name: shared/);
    const user = await fixture.fs.readText(
      await fixture.fs.resolve('/home/sandbox/skill-user/mine/SKILL.md'),
    );
    assert.match(user, /name: mine/);
  });

  test('根自身不可寻址（否则能 ls 出全部包名，绕过按名发现）', async () => {
    assert.equal(await codeOf(() => fixture.fs.resolve('/home/sandbox/skill-org')), 'FS_SANDBOX_DENIED');
    assert.equal(await codeOf(() => fixture.fs.resolve('/home/sandbox/skill-user')), 'FS_SANDBOX_DENIED');
  });

  test('未绑定的包一律 FS_SANDBOX_DENIED，且不跨层串台', async () => {
    // 磁盘上有、清单里没有。
    assert.equal(
      await codeOf(() => fixture.fs.resolve('/home/sandbox/skill-org/unselected/SKILL.md')),
      'FS_SANDBOX_DENIED',
    );
    // org 名拿到 user 层、user 名拿到 org 层：都不存在。
    assert.equal(
      await codeOf(() => fixture.fs.resolve('/home/sandbox/skill-user/shared/SKILL.md')),
      'FS_SANDBOX_DENIED',
    );
    assert.equal(
      await codeOf(() => fixture.fs.resolve('/home/sandbox/skill-org/mine/SKILL.md')),
      'FS_SANDBOX_DENIED',
    );
  });

  test('逻辑路径往返显示形式不变（脱敏与审计依赖它）', () => {
    const parsed = parseSandboxPath('/home/sandbox/skill-org/shared/SKILL.md');
    assert.deepEqual(parsed, { scope: 'skill-org', relative: 'shared/SKILL.md' });
    assert.equal(toDisplayPath(parsed), '/home/sandbox/skill-org/shared/SKILL.md');
    // 三层前缀不能互相误判：`skill-org` 也以 `skill` 开头。
    assert.equal(parseSandboxPath('/home/sandbox/skill/pdf/SKILL.md').scope, 'skill');
  });
});

/**
 * 系统层的 fs 围栏（ADR 0015 D4）。
 *
 * bwrap 那一侧早已逐包挂载，但模型的 `read` / `glob` / `grep` 走的是 fs RPC，
 * 不经过 bwrap。2026-09-30 复审在运行栈上复现：只绑定 `xlsx` 的 Agent 用 `read`
 * 读到了 `/home/sandbox/skill/pdf/SKILL.md`，`glob` 列出了全部系统包——发现与挂载不同构。
 */
describe('skill（系统层）逐包围栏', () => {
  let root: string;
  let systemSkillRoot: string;

  const fsWith = (systemSkillPackages: WorkspaceContext['systemSkillPackages']) => {
    const workspace: WorkspaceContext = {
      orgId: 'org1',
      userId: 'user1',
      workspaceId: 'ws1',
      workspaceRoot: path.join(root, 'workspace'),
      tempRoot: path.join(root, 'temp'),
      systemSkillRoot,
      enabledSkillPackages: [],
      ...(systemSkillPackages === undefined ? {} : { systemSkillPackages }),
    };
    return new WorkspaceFileSystem(new Context(), workspace);
  };

  before(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'dsh-exec-system-tier-')));
    systemSkillRoot = path.join(root, 'skill');
    await mkdir(path.join(root, 'workspace'), { recursive: true });
    await mkdir(path.join(root, 'temp'), { recursive: true });
    for (const name of ['pdf', 'xlsx']) {
      await mkdir(path.join(systemSkillRoot, name), { recursive: true });
      await writeFile(path.join(systemSkillRoot, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
    }
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('带名单：绑定的系统包可读，未绑定的一律 FS_SANDBOX_DENIED', async () => {
    const fs = fsWith([{ name: 'xlsx', sourcePath: path.join(systemSkillRoot, 'xlsx'), kind: 'system' }]);
    assert.match(await fs.readText(await fs.resolve('/home/sandbox/skill/xlsx/SKILL.md')), /name: xlsx/);
    assert.equal(
      await codeOf(() => fs.resolve('/home/sandbox/skill/pdf/SKILL.md')),
      'FS_SANDBOX_DENIED',
    );
  });

  test('带名单：系统根自身不可寻址（否则 glob/ls 能列出全部系统包）', async () => {
    const fs = fsWith([{ name: 'xlsx', sourcePath: path.join(systemSkillRoot, 'xlsx'), kind: 'system' }]);
    assert.equal(await codeOf(() => fs.resolve('/home/sandbox/skill')), 'FS_SANDBOX_DENIED');
  });

  test('空名单（mode: none）：任何系统包都不可达', async () => {
    const fs = fsWith([]);
    assert.equal(
      await codeOf(() => fs.resolve('/home/sandbox/skill/xlsx/SKILL.md')),
      'FS_SANDBOX_DENIED',
    );
  });

  test('缺省名单（滚动升级兼容期的旧 Agent）：维持整树可读', async () => {
    const fs = fsWith(undefined);
    assert.match(await fs.readText(await fs.resolve('/home/sandbox/skill/pdf/SKILL.md')), /name: pdf/);
  });
});
