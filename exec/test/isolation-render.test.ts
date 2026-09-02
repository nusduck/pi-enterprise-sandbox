/**
 * `render()` 是纯函数，不需要 bwrap、不需要真实文件系统——直接手写
 * `IsolationProfile` 字面量断言输出的 argv。这是这次重构最想要的性质：
 * 对隔离层的断言从"字符串匹配一坨 argv"变成"对着一份结构化数据 assert"。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render, nprocWrapperApplied } from '../src/isolation/render.js';
import { IsolationConfigError, type IsolationProfile, type Mount } from '../src/isolation/profile.js';

function baseProfile(overrides: Partial<IsolationProfile> = {}): IsolationProfile {
  return {
    namespace: {
      namespaces: ['user', 'pid', 'ipc', 'uts', 'net'],
      uid: 10001,
      gid: 10001,
      asPid1: false,
      dieWithParent: true,
      newSession: true,
      capDrop: 'ALL',
    },
    mounts: [],
    env: { clearEnv: true, vars: {} },
    launch: { argv: ['bash', '-c', 'pwd'], cwd: '/home/sandbox/workspace', maxProcessCount: 0 },
    ...overrides,
  };
}

function pairs(argv: readonly string[], flag: string): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) {
      const a = argv[i + 1];
      const b = argv[i + 2];
      if (a !== undefined && b !== undefined) out.push([a, b]);
    }
  }
  return out;
}

// ── 协调者明确要求单独写的一条：Bubblewrap 既有安全参数一条不少 ──────────

test('render() emits every Bubblewrap security flag (regression guard)', () => {
  const argv = render(baseProfile());

  // 用户 / PID / IPC / UTS 命名空间隔离。
  assert.ok(argv.includes('--unshare-user'), 'missing --unshare-user');
  assert.ok(argv.includes('--unshare-pid'), 'missing --unshare-pid');
  assert.ok(argv.includes('--unshare-ipc'), 'missing --unshare-ipc');
  assert.ok(argv.includes('--unshare-uts'), 'missing --unshare-uts');
  // netns fail-closed：默认（禁用网络）必须 unshare-net。
  assert.ok(argv.includes('--unshare-net'), 'missing --unshare-net for disabled network mode');
  // 全部能力清空。
  assert.ok(argv.includes('--cap-drop'), 'missing --cap-drop');
  assert.equal(argv[argv.indexOf('--cap-drop') + 1], 'ALL');
  // 新会话、跟随父进程存活。
  assert.ok(argv.includes('--new-session'));
  assert.ok(argv.includes('--die-with-parent'));
  // uid/gid 传给了 bwrap（而不是留给宿主默认值）。
  assert.equal(argv[argv.indexOf('--uid') + 1], '10001');
  assert.equal(argv[argv.indexOf('--gid') + 1], '10001');
});

test('render() uses a private procfs, never binds the outer container /proc', () => {
  const argv = render(
    baseProfile({
      mounts: [{ kind: 'proc', target: '/proc', sessionSpecific: false }],
    }),
  );
  assert.ok(argv.includes('--proc'));
  assert.equal(argv[argv.indexOf('--proc') + 1], '/proc');
  assert.deepEqual(pairs(argv, '--bind').filter(([, dest]) => dest === '/proc'), []);
});

test('in-namespace nproc wrapper: applied when maxProcessCount > 0', () => {
  const argv = render(
    baseProfile({
      launch: { argv: ['bash', '-c', 'printf ok'], cwd: '/home/sandbox/workspace', maxProcessCount: 20 },
    }),
  );
  const command = argv.slice(argv.indexOf('--') + 1);
  assert.deepEqual(command.slice(0, 2), ['/bin/bash', '-c']);
  assert.match(command[2] ?? '', /ulimit -S -u/);
  assert.match(command[2] ?? '', /ulimit -H -u/);
  assert.equal(command[3], '--');
  assert.equal(command[4], '20');
  assert.deepEqual(command.slice(5), ['bash', '-c', 'printf ok']);
});

test('in-namespace nproc wrapper: absent when maxProcessCount is 0', () => {
  const profile = baseProfile({
    launch: { argv: ['bash', '-c', 'printf ok'], cwd: '/home/sandbox/workspace', maxProcessCount: 0 },
  });
  const argv = render(profile);
  assert.deepEqual(argv.slice(argv.indexOf('--') + 1), ['bash', '-c', 'printf ok']);
  assert.equal(nprocWrapperApplied(profile), false);
});

test('nprocWrapperApplied() matches render()s decision without re-parsing argv', () => {
  const withWrapper = baseProfile({
    launch: { argv: ['true'], maxProcessCount: 5 },
  });
  assert.equal(nprocWrapperApplied(withWrapper), true);
});

test('--chdir is emitted only when LaunchPlan.cwd is set (preflight has none)', () => {
  const withCwd = render(baseProfile());
  assert.ok(withCwd.includes('--chdir'));
  assert.equal(withCwd[withCwd.indexOf('--chdir') + 1], '/home/sandbox/workspace');

  const withoutCwd = render(
    baseProfile({ launch: { argv: ['/usr/bin/true'], maxProcessCount: 0 } }),
  );
  assert.ok(!withoutCwd.includes('--chdir'));
  assert.deepEqual(withoutCwd.slice(withoutCwd.indexOf('--') + 1), ['/usr/bin/true']);
});

test('as-pid-1 only appears when NamespacePlan.asPid1 is true', () => {
  assert.ok(!render(baseProfile()).includes('--as-pid-1'));
  assert.ok(
    render(baseProfile({ namespace: { ...baseProfile().namespace, asPid1: true } })).includes(
      '--as-pid-1',
    ),
  );
});

test('die-with-parent is omitted for durable process handles', () => {
  const argv = render(
    baseProfile({ namespace: { ...baseProfile().namespace, dieWithParent: false } }),
  );
  assert.ok(!argv.includes('--die-with-parent'));
  assert.ok(argv.includes('--new-session'));
});

test('network mode disabled unshares net; allowlist/unrestricted do not', () => {
  const disabled = render(baseProfile());
  assert.ok(disabled.includes('--unshare-net'));

  const open = render(
    baseProfile({ namespace: { ...baseProfile().namespace, namespaces: ['user', 'pid', 'ipc', 'uts'] } }),
  );
  assert.ok(!open.includes('--unshare-net'));
});

// ── 挂载渲染：每种 kind × required 组合都要对上正确的 flag ────────────────

test('mount rendering: ro_bind / ro_bind-try / bind / bind-try / dir / proc / dev / tmpfs', () => {
  const mounts: Mount[] = [
    { kind: 'ro_bind', source: '/skills', target: '/home/sandbox/skill', required: true, sessionSpecific: false },
    { kind: 'ro_bind', source: '/usr', target: '/usr', required: false, sessionSpecific: false },
    { kind: 'bind', source: '/ws', target: '/home/sandbox/workspace', required: true, sessionSpecific: true },
    { kind: 'bind', source: '/maybe', target: '/maybe', required: false, sessionSpecific: false },
    { kind: 'dir', target: '/run', sessionSpecific: false },
    { kind: 'proc', target: '/proc', sessionSpecific: false },
    { kind: 'dev', target: '/dev', sessionSpecific: false },
    { kind: 'tmpfs', target: '/scratch', sessionSpecific: false },
  ];
  const argv = render(baseProfile({ mounts }));

  assert.deepEqual(pairs(argv, '--ro-bind'), [['/skills', '/home/sandbox/skill']]);
  assert.deepEqual(pairs(argv, '--ro-bind-try'), [['/usr', '/usr']]);
  assert.deepEqual(pairs(argv, '--bind'), [['/ws', '/home/sandbox/workspace']]);
  assert.deepEqual(pairs(argv, '--bind-try'), [['/maybe', '/maybe']]);
  assert.ok(argv.includes('--dir'));
  assert.equal(argv[argv.indexOf('--dir') + 1], '/run');
  assert.ok(argv.includes('--dev'));
  assert.ok(argv.includes('--tmpfs'));
  assert.equal(argv[argv.indexOf('--tmpfs') + 1], '/scratch');

  // 挂载按 MountPlan 的顺序原样出现在 argv 里。
  const mountFlags = argv.filter((tok) =>
    ['--ro-bind', '--ro-bind-try', '--bind', '--bind-try', '--dir', '--proc', '--dev', '--tmpfs'].includes(
      tok,
    ),
  );
  assert.deepEqual(mountFlags, [
    '--ro-bind',
    '--ro-bind-try',
    '--bind',
    '--bind-try',
    '--dir',
    '--proc',
    '--dev',
    '--tmpfs',
  ]);
});

// ── 环境变量：clearenv + setenv，名字/值校验 ─────────────────────────────

test('env: clearenv then setenv pairs in insertion order', () => {
  const argv = render(
    baseProfile({ env: { clearEnv: true, vars: { HOME: '/home/sandbox', VISIBLE: 'yes' } } }),
  );
  assert.ok(argv.includes('--clearenv'));
  assert.deepEqual(pairs(argv, '--setenv'), [
    ['HOME', '/home/sandbox'],
    ['VISIBLE', 'yes'],
  ]);
  // --clearenv 必须先于 --setenv。
  assert.ok(argv.indexOf('--clearenv') < argv.indexOf('--setenv'));
});

test('env: inherited mode validates but does not put values in bwrap argv', () => {
  const marker = 'sensitive-value-not-in-argv';
  const argv = render(
    baseProfile({ env: { clearEnv: true, vars: { DB_DSN: marker } } }),
    { envMode: 'inherited' },
  );
  assert.ok(!argv.includes('--clearenv'));
  assert.ok(!argv.includes('--setenv'));
  assert.ok(!argv.includes(marker));
});

test('env: rejects invalid variable names', () => {
  assert.throws(
    () => render(baseProfile({ env: { clearEnv: true, vars: { '1BAD': 'x' } } })),
    IsolationConfigError,
  );
});

test('env: rejects embedded NUL bytes in values', () => {
  assert.throws(
    () => render(baseProfile({ env: { clearEnv: true, vars: { OK_NAME: 'a\x00b' } } })),
    IsolationConfigError,
  );
});

test('host secrets never leak in merely by being in process.env: render() never reads process.env', () => {
  const previous = process.env['PI_ISOLATION_TEST_SECRET'];
  process.env['PI_ISOLATION_TEST_SECRET'] = 'host-secret-that-must-not-cross';
  try {
    const argv = render(baseProfile());
    assert.ok(!argv.join(' ').includes('host-secret-that-must-not-cross'));
  } finally {
    if (previous === undefined) delete process.env['PI_ISOLATION_TEST_SECRET'];
    else process.env['PI_ISOLATION_TEST_SECRET'] = previous;
  }
});
