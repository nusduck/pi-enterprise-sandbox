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
