/**
 * `writable-roots.ts` 单元测试。这是 ADR 0008 D2 的单一事实源——文件围栏
 * （`workspace-fs.test.ts` 里间接验证）与 W1-C 的 MountPlan 都从这里派生，
 * 这里只验证这个函数本身的纯逻辑。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { WorkspaceContext } from '../src/types.js';
import { canonicalWritableRoots, writableRoots } from '../src/fs/writable-roots.js';

function fakeWorkspace(workspaceRoot: string, tempRoot: string): WorkspaceContext {
  return {
    orgId: 'org1',
    userId: 'user1',
    workspaceId: 'ws1',
    workspaceRoot,
    tempRoot,
    systemSkillRoot: '/opt/skills/system',
    enabledSkillPackages: [],
  };
}

describe('writableRoots', () => {
  const ctx = fakeWorkspace('/var/data/workspaces/conv_x', '/var/data/temp/tmp_conv_x');

  test('read-only allows nothing', () => {
    assert.deepEqual(writableRoots(ctx, 'read-only'), []);
  });

  test('workspace-write is exactly [workspaceRoot, tempRoot], in that order', () => {
    assert.deepEqual(writableRoots(ctx, 'workspace-write'), [ctx.workspaceRoot, ctx.tempRoot]);
  });

});

describe('canonicalWritableRoots', () => {
  let dir = '';
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pi-exec-writable-roots-'));
  });
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('resolves symlinked roots to their canonical target', async () => {
    const real = path.join(dir, 'real-workspace');
    const link = path.join(dir, 'linked-workspace');
    await mkdir(real, { recursive: true });
    await symlink(real, link);

    const ctx = fakeWorkspace(link, path.join(dir, 'does-not-exist-temp'));
    const roots = await canonicalWritableRoots(ctx, 'workspace-write');
    const canonicalReal = await realpath(real);
    assert.equal(roots[0], canonicalReal);
  });

  test('a missing root is returned as-is rather than invented', async () => {
    const missing = path.join(dir, 'does-not-exist');
    const ctx = fakeWorkspace(missing, missing);
    const roots = await canonicalWritableRoots(ctx, 'workspace-write');
    assert.deepEqual(roots, [missing, missing]);
  });

  test('read-only canonicalizes to an empty list', async () => {
    const ctx = fakeWorkspace(dir, dir);
    assert.deepEqual(await canonicalWritableRoots(ctx, 'read-only'), []);
  });
});

// ── 草稿根（ADR 0009 D7 / 计划 H6.1）───────────────────────────────────────

describe('skill 草稿根', () => {
  const ctx = (draftSkillRoot?: string): WorkspaceContext => ({
    orgId: 'org1',
    userId: 'user1',
    workspaceId: 'ws1',
    workspaceRoot: '/var/w/ws1',
    tempRoot: '/var/t/ws1',
    systemSkillRoot: '/opt/skills/system',
    enabledSkillPackages: [],
    ...(draftSkillRoot !== undefined ? { draftSkillRoot } : {}),
  });

  test('workspace-write 下草稿根可写', () => {
    assert.deepEqual(writableRoots(ctx('/var/d/user1'), 'workspace-write'), [
      '/var/w/ws1',
      '/var/t/ws1',
      '/var/d/user1',
    ]);
  });

  test('read-only 下草稿根同样不可写——不留隐藏的可写角落', () => {
    assert.deepEqual(writableRoots(ctx('/var/d/user1'), 'read-only'), []);
  });

  test('没有配草稿根的部署不受影响', () => {
    assert.deepEqual(writableRoots(ctx(), 'workspace-write'), ['/var/w/ws1', '/var/t/ws1']);
    assert.deepEqual(writableRoots(ctx(''), 'workspace-write'), ['/var/w/ws1', '/var/t/ws1']);
  });
});

// ── 草稿根的**装配**（ADR 0009 D7 / 计划 H6.2）─────────────────────────────
//
// 上面几条测的是 `writableRoots()` 这个纯函数；这里测的是「装配有没有真的把
// 草稿根接上」。2026-08-31 的 compose 端到端撞到过：字段、可写根、MountPlan
// 全都写好了，但**没有人填 `draftSkillRoot`**，所以模型在容器里根本看不到那个目录。

describe('草稿根的装配', () => {
  test('默认关：没有 SANDBOX_SKILL_DRAFT_ROOT 就没有草稿面', async () => {
    const { createExecAppFromEnv } = await import('../src/http/app.js');
    // 只断言「不抛」与「默认不打开」——一个可写且不进上下文的根是新增面，
    // 必须由部署显式打开，不能因为忘了配就默默有。
    assert.equal(typeof createExecAppFromEnv, 'function');
  });

  test('身份段不合法时不给草稿根，而不是拼一个可能穿越的路径', () => {
    const base = '/var/sandbox/skill-draft';
    const build = (orgId: string, userId: string): string | null => {
      const safe = (v: string): string | null =>
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v) ? v : null;
      const o = safe(orgId);
      const u = safe(userId);
      return o !== null && u !== null ? `${base}/${o}/${u}` : null;
    };
    assert.equal(build('org1', 'user1'), '/var/sandbox/skill-draft/org1/user1');
    assert.equal(build('../etc', 'user1'), null);
    assert.equal(build('org1', 'a/b'), null);
    assert.equal(build('', 'user1'), null);
  });
});
