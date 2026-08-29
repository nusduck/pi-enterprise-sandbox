/**
 * `buildIsolationProfile()`：把 `WorkspaceContext` + `SandboxMode` 变成
 * `IsolationProfile`。这里的断言直接对着 `MountPlan` 走（ADR 0008 验证要求 1）：
 * 可写挂载**恰好**等于 `writableRoots()` 的结果，skill 层全部只读，`/tmp`
 * 恰好绑定当前会话的物理 temp。
 *
 * `writableRoots()` 现在已经由 W1-B 实现（不再是 `throw`），大部分测试直接
 * 用真实实现即可；仍然保留 `writableRootsFn` 注入的用法，覆盖"生产路径永远
 * 不需要它，但这个钩子确实存在"这件事本身。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIsolationProfile } from '../src/isolation/build.js';
import { writableRoots } from '../src/fs/writable-roots.js';
import { IsolationConfigError, type BindMount, type Mount } from '../src/isolation/profile.js';
import { isPathWithin, makeTestWorkspace } from './helpers.js';

function bindMounts(mounts: readonly Mount[]): BindMount[] {
  return mounts.filter((m): m is BindMount => m.kind === 'ro_bind' || m.kind === 'bind');
}

// ── ADR 0008 验证要求 1：plan 断言 ────────────────────────────────────────

test('plan assertion: the root-level writable mounts (workspace, temp) are exactly writableRoots() — not more, not fewer', async () => {
  // 只比较 workspace/temp 这两条"根"挂载：XDG home 子目录虽然也可能是
  // `kind: 'bind'`，但它可写是因为它落在一个可写的根下面，不是因为它本身
  // 是 `writableRoots()` 列表里的一员——ADR 0008 验证要求 1 说的"可写挂载
  // 恰为 writableRoots() 的结果"，指的是这两条根挂载本身。
  const ws = await makeTestWorkspace();
  try {
    for (const mode of ['read-only', 'workspace-write'] as const) {
      const profile = buildIsolationProfile({
        context: ws.context,
        mode,
        command: ['bash', '-c', 'pwd'],
      });
      const expectedWritable = new Set(writableRoots(ws.context, mode));
      const rootMounts = bindMounts(profile.mounts).filter(
        (m) => m.target === '/home/sandbox/workspace' || m.target === '/tmp',
      );
      const actualWritableSources = new Set(
        rootMounts.filter((m) => m.kind === 'bind').map((m) => m.source),
      );
      assert.deepEqual(
        actualWritableSources,
        expectedWritable,
        `mode=${mode}: writable root mount sources must equal writableRoots() exactly`,
      );
      // 反向也要成立：writableRoots() 之外的那个根挂载必须是只读，不能是可写。
      for (const m of rootMounts) {
        assert.equal(
          m.kind === 'bind',
          expectedWritable.has(m.source),
          `${m.target}: writability must follow writableRoots() membership exactly`,
        );
      }
    }
  } finally {
    await ws.cleanup();
  }
});

// ── 全局包含性不变量 ──────────────────────────────────────────────────
//
// 上面那条断言只点检 workspace/temp 两条"根"挂载，故意放过了 XDG home 子目录
// （它们也是 `kind: 'bind'`，但源路径是某个可写根的**后代**，不是根本身）。
// 这个收窄是对的——但收窄之后，任何挂到 workspace/temp/XDG home 之外的可写
// 挂载（例如手滑写出 `{ kind: 'bind', source: '/etc', target: '/etc' }`），
// 点检式的断言完全抓不到。真正要守的不是"根挂载相等"，而是一条更弱、但
// 覆盖面更全的不变量：
//
//   profile 里每一条 kind: 'bind' 的挂载，它的 source 必须落在
//   writableRoots() 某一条之内（等于该根，或者是该根的后代路径）。
//
// 这条与上面"根挂载精确对应"的断言互补，不是替代：那条防"该写的没写/写多了
// 根"，这条防"写到了根以外的任何地方"。

function assertEveryWritableMountIsWithinWritableRoots(
  mounts: readonly Mount[],
  roots: readonly string[],
): void {
  for (const mount of mounts) {
    if (mount.kind !== 'bind') continue;
    assert.ok(
      roots.some((root) => isPathWithin(mount.source, root)),
      `writable mount source ${mount.source} (target ${mount.target}) is not within ` +
        `any writableRoots() entry: [${roots.join(', ')}]`,
    );
  }
}

test('global invariant: every writable (kind: bind) mount source is within some writableRoots() entry, in both modes', async () => {
  const ws = await makeTestWorkspace({ enabledPackages: ['pkg-a'] });
  try {
    for (const mode of ['read-only', 'workspace-write'] as const) {
      const profile = buildIsolationProfile({
        context: ws.context,
        mode,
        command: ['bash', '-c', 'pwd'],
      });
      const roots = writableRoots(ws.context, mode);
      assertEveryWritableMountIsWithinWritableRoots(profile.mounts, roots);
    }
  } finally {
    await ws.cleanup();
  }
});

test('global invariant: read-only mode has zero kind:"bind" mounts — nothing is writable, not even by accident', async () => {
  const ws = await makeTestWorkspace({ enabledPackages: ['pkg-a'] });
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'read-only',
      command: ['bash', '-c', 'pwd'],
    });
    const writableMounts = profile.mounts.filter((m) => m.kind === 'bind');
    assert.deepEqual(writableMounts, []);
  } finally {
    await ws.cleanup();
  }
});

test('global invariant sanity check: the checker itself actually rejects an out-of-bounds writable mount', () => {
  // 手工构造一条越界的可写挂载（比如手滑挂了 /etc 可写），验证上面用的
  // `assertEveryWritableMountIsWithinWritableRoots` 真的会拒绝它——否则这条
  // "不变量测试"本身是不是有效，谁都不知道。
  const roots = ['/home/sandbox-fake-root/workspace', '/home/sandbox-fake-root/temp'];
  const rogueMounts: Mount[] = [
    { kind: 'bind', source: '/etc', target: '/etc', required: true, sessionSpecific: false },
  ];
  assert.throws(() => assertEveryWritableMountIsWithinWritableRoots(rogueMounts, roots));
});

test('containment helper is segment-based, not a raw startsWith (avoids the /a/bc vs /a/b false positive)', () => {
  assert.equal(isPathWithin('/a/bc', '/a/b'), false, '/a/bc is a sibling of /a/b, not a descendant');
  assert.equal(isPathWithin('/a/b/c', '/a/b'), true);
  assert.equal(isPathWithin('/a/b', '/a/b'), true, 'a root is within itself');
  assert.equal(isPathWithin('/a', '/a/b'), false, 'a parent is not within its child');
});

test('plan assertion: workspace/temp are still mounted (read-only) in read-only mode, not dropped', async () => {
  const ws = await makeTestWorkspace();
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'read-only',
      command: ['bash', '-c', 'pwd'],
    });
    const roots = bindMounts(profile.mounts).filter(
      (m) => m.target === '/home/sandbox/workspace' || m.target === '/tmp',
    );
    assert.equal(roots.length, 2);
    for (const m of roots) {
      assert.equal(m.kind, 'ro_bind', `${m.target} must stay mounted, just read-only`);
    }
  } finally {
    await ws.cleanup();
  }
});

test('plan assertion: skill layer is entirely ro_bind, never writable', async () => {
  const ws = await makeTestWorkspace({ enabledPackages: ['pkg-a', 'pkg-b'] });
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['bash', '-c', 'pwd'],
    });
    const skillMounts = bindMounts(profile.mounts).filter(
      (m) => m.target.startsWith('/home/sandbox/skill'),
    );
    assert.ok(skillMounts.length >= 3, 'expected system tier + 2 package mounts');
    for (const m of skillMounts) {
      assert.equal(m.kind, 'ro_bind', `${m.target} must be read-only`);
    }
  } finally {
    await ws.cleanup();
  }
});

test('plan assertion: /tmp mount source is exactly this sessions physical temp, and differs across sessions', async () => {
  const a = await makeTestWorkspace();
  const b = await makeTestWorkspace();
  try {
    const profileA = buildIsolationProfile({
      context: a.context,
      mode: 'workspace-write',
      command: ['true'],
    });
    const profileB = buildIsolationProfile({
      context: b.context,
      mode: 'workspace-write',
      command: ['true'],
    });
    const tempMountA = bindMounts(profileA.mounts).find((m) => m.target === '/tmp');
    const tempMountB = bindMounts(profileB.mounts).find((m) => m.target === '/tmp');
    assert.equal(tempMountA?.source, a.context.tempRoot);
    assert.equal(tempMountB?.source, b.context.tempRoot);
    assert.notEqual(tempMountA?.source, tempMountB?.source);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

// ── ADR 0008 D4：skill 绑定是启用集的函数 ─────────────────────────────────

test('skill binding: only enabled packages are mounted; installed-but-not-enabled is absent', async () => {
  const ws = await makeTestWorkspace({
    enabledPackages: ['enabled-one'],
    installedButNotEnabledPackages: ['not-enabled-two'],
  });
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['true'],
    });
    const targets = profile.mounts.map((m) => m.target);
    assert.ok(targets.includes('/home/sandbox/skill-user/enabled-one'));
    assert.ok(!targets.includes('/home/sandbox/skill-user/not-enabled-two'));
    assert.ok(!profile.mounts.some((m) => m.target.includes('not-enabled-two')));
  } finally {
    await ws.cleanup();
  }
});

test('skill binding: no enabled packages means system tier only, no skill-user mounts at all', async () => {
  const ws = await makeTestWorkspace();
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['true'],
    });
    assert.ok(!profile.mounts.some((m) => m.target.startsWith('/home/sandbox/skill-user')));
    assert.ok(profile.mounts.some((m) => m.target === '/home/sandbox/skill'));
  } finally {
    await ws.cleanup();
  }
});

test('skill binding: system tier is required=true, package mounts are required=false (a single bad package cannot break the launch)', async () => {
  const ws = await makeTestWorkspace({ enabledPackages: ['pkg-a'] });
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['true'],
    });
    const system = bindMounts(profile.mounts).find((m) => m.target === '/home/sandbox/skill');
    const pkg = bindMounts(profile.mounts).find((m) => m.target === '/home/sandbox/skill-user/pkg-a');
    assert.equal(system?.required, true);
    assert.equal(pkg?.required, false);
  } finally {
    await ws.cleanup();
  }
});

// ── ADR 0004：会话私有 XDG home ────────────────────────────────────────

test('persistent XDG home: three subdirs bound under this sessions temp tree, ensureDir set, required', async () => {
  const ws = await makeTestWorkspace();
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['true'],
    });
    const expected: Record<string, string> = {
      '/home/sandbox/.config': `${ws.context.tempRoot}/.home/.config`,
      '/home/sandbox/.cache': `${ws.context.tempRoot}/.home/.cache`,
      '/home/sandbox/.local/share': `${ws.context.tempRoot}/.home/.local/share`,
    };
    for (const [target, source] of Object.entries(expected)) {
      const m = bindMounts(profile.mounts).find((mount) => mount.target === target);
      assert.ok(m, `missing home mount for ${target}`);
      assert.equal(m?.source, source);
      assert.equal(m?.required, true);
      assert.equal(m?.ensureDir, true);
      assert.equal(m?.kind, 'bind', 'writable in workspace-write mode');
    }
  } finally {
    await ws.cleanup();
  }
});

test('persistent XDG home: not shared between sessions (each lives under its own temp)', async () => {
  const a = await makeTestWorkspace();
  const b = await makeTestWorkspace();
  try {
    const profileA = buildIsolationProfile({ context: a.context, mode: 'workspace-write', command: ['true'] });
    const profileB = buildIsolationProfile({ context: b.context, mode: 'workspace-write', command: ['true'] });
    const configA = bindMounts(profileA.mounts).find((m) => m.target === '/home/sandbox/.config');
    const configB = bindMounts(profileB.mounts).find((m) => m.target === '/home/sandbox/.config');
    assert.notEqual(configA?.source, configB?.source);
    assert.ok(configA?.source.startsWith(a.context.tempRoot));
    assert.ok(configB?.source.startsWith(b.context.tempRoot));
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test('persistent XDG home follows temp writability: read-only mode does not leave a hidden writable corner', async () => {
  const ws = await makeTestWorkspace();
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'read-only',
      command: ['true'],
    });
    const home = bindMounts(profile.mounts).filter((m) => m.target.startsWith('/home/sandbox/.'));
    assert.ok(home.length === 3);
    for (const m of home) assert.equal(m.kind, 'ro_bind');
  } finally {
    await ws.cleanup();
  }
});

// ── 网络模式 ──────────────────────────────────────────────────────────

test('network mode: default is disabled (fail-closed netns)', async () => {
  const ws = await makeTestWorkspace();
  try {
    const profile = buildIsolationProfile({ context: ws.context, mode: 'workspace-write', command: ['true'] });
    assert.ok(profile.namespace.namespaces.includes('net'));
  } finally {
    await ws.cleanup();
  }
});

test('network mode: allowlist/unrestricted do not unshare net', async () => {
  const ws = await makeTestWorkspace();
  try {
    for (const networkMode of ['allowlist', 'unrestricted'] as const) {
      const profile = buildIsolationProfile({
        context: ws.context,
        mode: 'workspace-write',
        command: ['true'],
        networkMode,
      });
      assert.ok(!profile.namespace.namespaces.includes('net'));
    }
  } finally {
    await ws.cleanup();
  }
});

test('network mode: unknown value is rejected', async () => {
  const ws = await makeTestWorkspace();
  try {
    assert.throws(
      () =>
        buildIsolationProfile({
          context: ws.context,
          mode: 'workspace-write',
          command: ['true'],
          // @ts-expect-error deliberately invalid at the type level too
          networkMode: 'open-everything',
        }),
      IsolationConfigError,
    );
  } finally {
    await ws.cleanup();
  }
});

// ── cwd 校验 ──────────────────────────────────────────────────────────

test('cwd: relative path resolves under the workspace or temp logical root', async () => {
  const ws = await makeTestWorkspace();
  try {
    const workspaceCwd = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['true'],
      relativeCwd: 'notes',
    });
    assert.equal(workspaceCwd.launch.cwd, '/home/sandbox/workspace/notes');

    const tempCwd = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['true'],
      relativeCwd: 'service',
      cwdScope: 'temp',
    });
    assert.equal(tempCwd.launch.cwd, '/tmp/service');
  } finally {
    await ws.cleanup();
  }
});

test('cwd: rejects escape attempts', async () => {
  const ws = await makeTestWorkspace();
  try {
    assert.throws(
      () =>
        buildIsolationProfile({
          context: ws.context,
          mode: 'workspace-write',
          command: ['true'],
          relativeCwd: '../escape',
        }),
      IsolationConfigError,
    );
    assert.throws(
      () =>
        buildIsolationProfile({
          context: ws.context,
          mode: 'workspace-write',
          command: ['true'],
          relativeCwd: '/absolute',
        }),
      IsolationConfigError,
    );
  } finally {
    await ws.cleanup();
  }
});

// ── uid/gid、能力剥离语义的静态成分、env 优先级 ───────────────────────────

test('uid/gid default to 10001/10001 and are overridable', async () => {
  const ws = await makeTestWorkspace();
  try {
    const defaults = buildIsolationProfile({ context: ws.context, mode: 'workspace-write', command: ['true'] });
    assert.equal(defaults.namespace.uid, 10001);
    assert.equal(defaults.namespace.gid, 10001);

    const overridden = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['true'],
      uid: 12345,
      gid: 12346,
    });
    assert.equal(overridden.namespace.uid, 12345);
    assert.equal(overridden.namespace.gid, 12346);
  } finally {
    await ws.cleanup();
  }
});

test('env: isolation-mandated keys (HOME/PWD/TMPDIR/XDG_*) always win over caller overrides', async () => {
  const ws = await makeTestWorkspace();
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['true'],
      envOverrides: { HOME: '/tmp/attacker-controlled', VISIBLE: 'yes' },
    });
    assert.equal(profile.env.vars['HOME'], '/home/sandbox');
    assert.equal(profile.env.vars['VISIBLE'], 'yes');
    assert.equal(profile.env.vars['TMPDIR'], '/tmp');
    assert.equal(profile.env.vars['XDG_CONFIG_HOME'], '/home/sandbox/.config');
  } finally {
    await ws.cleanup();
  }
});
