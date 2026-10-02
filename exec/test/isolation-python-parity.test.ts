/**
 * 隔离层行为测试——钉住当前 TS 实现（`exec/src/isolation/`）的 argv 渲染与挂载策略。
 *
 * 覆盖：profile 构建（工作区/temp 绑定、skill 分层只读挂载、命名空间 flag、
 * 环境变量隔离、XDG home、cwd 作用域、ulimit 包装、die-with-parent/as-pid-1）、
 * preflight 探针渲染、runner 层挂载探测与降级（缺失/不可读挂载的摘除与报错、
 * setpriv 剥离）。
 *
 * 用例名前的 `[isolation/<area>]` 标的是当前行为所在的层次（profile /
 * preflight / runner），不是外部引用。
 *
 * 两条历史用例没有单独成条，原因写在这里而不是省略：
 *
 * - "谁在什么时候把 `dieWithParent=false`/`asPid1=true` 传给隔离层"测的是
 *   调用方（`exec/src/shell/`），不是隔离层自己的行为；隔离层"给定这两个
 *   字段，argv 该长什么样"由下面的 durable/as-pid-1 两条覆盖到了。
 * - "两份手写 argv 列表不会偷偷退回共享 /proc"这条防线：新架构下
 *   `preflight()` 根本不再手写任何列表（`toPreflightProfile()` 是从同一个
 *   profile 过滤出来的），意义已被结构本身取代；等价的结构断言在
 *   `isolation-preflight.test.ts` 的
 *   "keeps every static mount build.ts produces" 里，用 `proc` 这个 mount kind
 *   本身来断言，而不是找字符串。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildIsolationProfile } from '../src/isolation/build.js';
import { buildPreflightProfile } from '../src/isolation/preflight.js';
import { render } from '../src/isolation/render.js';
import {
  IsolationUnavailable,
  resolveEffectiveMounts,
  resolveInvocation,
} from '../src/isolation/bubblewrap.js';
import { IsolationConfigError, type BindMount, type Mount } from '../src/isolation/profile.js';
import { makeTestWorkspace, neverExists } from './helpers.js';

function bindMounts(mounts: readonly Mount[]): BindMount[] {
  return mounts.filter((m): m is BindMount => m.kind === 'ro_bind' || m.kind === 'bind');
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

test('[isolation/profile] workspace/temp bound, system skill read-only, no outer /proc bind, unshare flags present, env override passes through', async () => {
  const ws = await makeTestWorkspace({ systemSkillNames: ['pdf'] });
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['bash', '-c', 'pwd'],
      envOverrides: { VISIBLE: 'yes' },
    });
    const argv = render(profile);

    assert.ok(pairs(argv, '--bind').some(([s, d]) => s === ws.context.workspaceRoot && d === '/home/sandbox/workspace'));
    assert.ok(pairs(argv, '--bind').some(([s, d]) => s === ws.context.tempRoot && d === '/tmp'));
    // 系统层**逐包**只读绑定（ADR 0015 D4）：系统根本身不再进 argv，否则名单外的
    // 包依然能被 `ls`/`read` 到。
    assert.deepEqual(
      pairs(argv, '--ro-bind').filter(([, d]) => d.startsWith('/home/sandbox/skill')),
      [[`${ws.context.systemSkillRoot}/pdf`, '/home/sandbox/skill/pdf']],
    );
    assert.ok(!pairs(argv, '--ro-bind').some(([, d]) => d === '/home/sandbox/skill'));
    assert.ok(!pairs(argv, '--bind').some(([, d]) => d === '/home/sandbox/skill'));

    for (const flag of [
      '--die-with-parent',
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-net',
      '--clearenv',
    ]) {
      assert.ok(argv.includes(flag), `missing ${flag}`);
    }
    assert.ok(argv.includes('--proc'));
    assert.equal(argv[argv.indexOf('--proc') + 1], '/proc');
    assert.ok(!pairs(argv, '--bind').some(([s, d]) => s === '/proc' && d === '/proc'));
    assert.ok(argv.includes('VISIBLE'));
  } finally {
    await ws.cleanup();
  }
});

test('[isolation/profile] die_with_parent=false omits --die-with-parent, keeps --new-session', async () => {
  const ws = await makeTestWorkspace();
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['bash', '-c', 'sleep 120'],
      dieWithParent: false,
    });
    const argv = render(profile);
    assert.ok(!argv.includes('--die-with-parent'));
    assert.ok(argv.includes('--new-session'));
  } finally {
    await ws.cleanup();
  }
});

test('[isolation/profile] as_pid_1=true emits --as-pid-1', async () => {
  const ws = await makeTestWorkspace();
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['bash', '-c', 'sleep 120'],
      dieWithParent: false,
      asPid1: true,
    });
    assert.ok(render(profile).includes('--as-pid-1'));
  } finally {
    await ws.cleanup();
  }
});

test('[isolation/runner] setpriv prefix precedes the bwrap executable', async () => {
  const ws = await makeTestWorkspace();
  try {
    const profile = buildIsolationProfile({ context: ws.context, mode: 'workspace-write', command: ['true'] });
    const { command, args } = resolveInvocation('/usr/bin/bwrap', profile, undefined, {
      hasCapabilities: () => true,
      which: () => '/usr/bin/setpriv',
    });
    assert.equal(command, '/usr/bin/setpriv');
    assert.deepEqual(args.slice(0, 4), [
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--',
      '/usr/bin/bwrap',
    ]);
  } finally {
    await ws.cleanup();
  }
});

test('[isolation/profile] max_process_count wraps the command in an in-namespace ulimit wrapper', async () => {
  const ws = await makeTestWorkspace();
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['bash', '-c', 'printf ok'],
      maxProcessCount: 20,
    });
    const argv = render(profile);
    const command = argv.slice(argv.indexOf('--') + 1);
    assert.deepEqual(command.slice(0, 2), ['/bin/bash', '-c']);
    assert.match(command[2] ?? '', /ulimit -S "\$f" "\$v"/);
    assert.match(command[2] ?? '', /ulimit -H "\$f" "\$v"/);
    assert.deepEqual(command.slice(3), ['--', '-u', '20', '--', 'bash', '-c', 'printf ok']);
  } finally {
    await ws.cleanup();
  }
});

test('[isolation/profile] no wrapper when max_process_count is unset', async () => {
  const ws = await makeTestWorkspace();
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['bash', '-c', 'printf ok'],
    });
    const argv = render(profile);
    assert.deepEqual(argv.slice(argv.indexOf('--') + 1), ['bash', '-c', 'printf ok']);
  } finally {
    await ws.cleanup();
  }
});

test('[isolation/preflight] preflight rendering exercises the full namespace policy with the configured uid/gid', async () => {
  const ws = await makeTestWorkspace();
  try {
    const preflight = buildPreflightProfile({
      systemSkillRoot: ws.context.systemSkillRoot,
      uid: 12345,
      gid: 12346,
    });
    const argv = render(preflight);
    for (const flag of [
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-net',
      '--cap-drop',
      '--proc',
      '--clearenv',
    ]) {
      assert.ok(argv.includes(flag), `missing ${flag}`);
    }
    assert.equal(argv[argv.indexOf('--uid') + 1], '12345');
    assert.equal(argv[argv.indexOf('--gid') + 1], '12346');
    assert.equal(argv[argv.indexOf('--cap-drop') + 1], 'ALL');
    // 探针不带系统名单：系统根整树只读绑定（design §6.4 / §8）。
    assert.ok(
      pairs(argv, '--ro-bind').some(
        ([s, d]) => s === ws.context.systemSkillRoot && d === '/home/sandbox/skill',
      ),
    );
  } finally {
    await ws.cleanup();
  }
});

test('[isolation/profile] relative cwd in the temp scope resolves under /tmp', async () => {
  const ws = await makeTestWorkspace();
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['bash', '-c', 'pwd'],
      relativeCwd: 'service',
      cwdScope: 'temp',
    });
    const argv = render(profile);
    assert.equal(argv[argv.indexOf('--chdir') + 1], '/tmp/service');
  } finally {
    await ws.cleanup();
  }
});

test('[isolation/profile] build.ts never autonomously pulls process.env into the profile (see report: the allowlist/denylist gate itself is a W2 gap)', async () => {
  const ws = await makeTestWorkspace();
  const previous = process.env['SANDBOX_API_TOKEN'];
  process.env['SANDBOX_API_TOKEN'] = 'host-secret-that-must-not-cross';
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['bash', '-c', 'echo ok'],
    });
    const argv = render(profile);
    assert.ok(!argv.includes('host-secret-that-must-not-cross'));
    assert.ok(!argv.includes('SANDBOX_API_TOKEN'));
  } finally {
    if (previous === undefined) delete process.env['SANDBOX_API_TOKEN'];
    else process.env['SANDBOX_API_TOKEN'] = previous;
    await ws.cleanup();
  }
});

test('[isolation/profile] (reframed for D4) only this contexts enabled packages are bound, at their given absolute path, always read-only', async () => {
  const ws = await makeTestWorkspace({ enabledPackages: ['pkg-mine'] });
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['bash', '-c', 'pwd'],
    });
    const argv = render(profile);
    const myPackage = ws.context.enabledSkillPackages[0];
    assert.ok(myPackage);
    assert.ok(
      pairs(argv, '--ro-bind-try').some(
        ([s, d]) => s === myPackage.sourcePath && d === '/home/sandbox/skill-user/pkg-mine',
      ),
    );
    assert.ok(!pairs(argv, '--bind').some(([, d]) => d === '/home/sandbox/skill-user/pkg-mine'));
    assert.ok(!pairs(argv, '--bind-try').some(([, d]) => d === '/home/sandbox/skill-user/pkg-mine'));
  } finally {
    await ws.cleanup();
  }
});

test('[isolation/profile] (reframed for D4) no enabled packages means no skill-user mounts; the named system package is still bound', async () => {
  const ws = await makeTestWorkspace({ systemSkillNames: ['pdf'] });
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['bash', '-c', 'pwd'],
    });
    const argv = render(profile);
    assert.ok(
      pairs(argv, '--ro-bind').some(
        ([s, d]) => s === `${ws.context.systemSkillRoot}/pdf` && d === '/home/sandbox/skill/pdf',
      ),
    );
    assert.ok(!argv.join(' ').includes('/home/sandbox/skill-user'));
  } finally {
    await ws.cleanup();
  }
});

test('[isolation/runner] (relocated to the runner layer) a missing system package fails before bwrap runs, naming the path and the mount', async () => {
  const missingRoot = neverExists('skills-that-were-never-mounted');
  const profile = buildIsolationProfile({
    context: {
      orgId: 'org',
      userId: 'user',
      workspaceId: 'ws',
      workspaceRoot: '/does-not-matter-for-this-test',
      tempRoot: '/does-not-matter-for-this-test',
      systemSkillRoot: missingRoot,
      enabledSkillPackages: [],
      // 点了一个名字出来、源却不存在：系统层是硬绑定（design §6.4），
      // 这是部署故障，必须在 spawn 之前说清楚，而不是让模型拿到残缺能力集。
      systemSkillPackages: [{ name: 'pdf', sourcePath: `${missingRoot}/pdf`, kind: 'system' }],
    },
    mode: 'read-only', // 避免真的去挂 workspace/temp 根，这条用例只关心 skill 根
    command: ['bash', '-c', 'pwd'],
  });
  assert.throws(
    () => resolveEffectiveMounts(profile.mounts),
    (err: unknown) => {
      assert.ok(err instanceof IsolationUnavailable);
      assert.match(err.message, /missing or inaccessible/);
      assert.ok(err.message.includes(`${missingRoot}/pdf`));
      return true;
    },
  );
});

test('[isolation/runner] a user with an enabled-but-not-yet-installed package still gets bash/pwd', async () => {
  const ws = await makeTestWorkspace();
  const missingPackageSource = join(ws.root, 'user-skills', 'not-installed-yet');
  const profile = buildIsolationProfile({
    context: { ...ws.context, enabledSkillPackages: [{ name: 'not-installed-yet', sourcePath: missingPackageSource }] },
    mode: 'workspace-write',
    command: ['bash', '-c', 'pwd'],
  });
  try {
    const { args } = resolveInvocation('/usr/bin/bwrap', profile);
    // required=false 且 ENOENT：这条挂载被摘掉，但其余启动照常，命令本身完好。
    assert.ok(!args.join(' ').includes('not-installed-yet'));
    assert.deepEqual(args.slice(args.indexOf('--') + 1), ['bash', '-c', 'pwd']);
  } finally {
    await ws.cleanup();
  }
});

test('[isolation/runner] one users broken package mount does not cost that user bash/python (only if not root)', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: chmod-based EACCES cannot be exercised');
    return;
  }
  const ws = await makeTestWorkspace({ systemSkillNames: ['pdf'] });
  const orgDir = join(ws.root, 'user-skills-broken');
  const pkgDir = join(orgDir, 'pkg-broken');
  await mkdir(pkgDir, { recursive: true });
  await chmod(orgDir, 0o600); // ancestor not traversable -> EACCES on stat(pkgDir)
  try {
    const profile = buildIsolationProfile({
      context: { ...ws.context, enabledSkillPackages: [{ name: 'pkg-broken', sourcePath: pkgDir }] },
      mode: 'workspace-write',
      command: ['bash', '-c', 'pwd'],
    });
    let degradedCount = 0;
    const { args } = resolveInvocation('/usr/bin/bwrap', profile, {
      onDegraded: () => (degradedCount += 1),
    });
    assert.equal(degradedCount, 1);
    assert.ok(!args.join(' ').includes('pkg-broken'));
    assert.ok(
      args.some((tok, i) => tok === '--ro-bind' && args[i + 2] === '/home/sandbox/skill/pdf'),
      'the bound system package must still be mounted',
    );
    assert.deepEqual(args.slice(args.indexOf('--') + 1), ['bash', '-c', 'pwd']);
  } finally {
    await chmod(orgDir, 0o755);
    await ws.cleanup();
  }
});

test('[isolation/profile] HOME/XDG_* env vars and the three home binds are present', async () => {
  const ws = await makeTestWorkspace();
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['bash', '-c', 'pwd'],
    });
    const argv = render(profile);
    const binds = new Map(pairs(argv, '--bind'));
    const home = join(ws.context.tempRoot, '.home');

    assert.equal(binds.get(join(home, '.config')), '/home/sandbox/.config');
    assert.equal(binds.get(join(home, '.cache')), '/home/sandbox/.cache');
    assert.equal(binds.get(join(home, '.local/share')), '/home/sandbox/.local/share');

    const env = new Map(pairs(argv, '--setenv'));
    assert.equal(env.get('HOME'), '/home/sandbox');
    assert.equal(env.get('XDG_CONFIG_HOME'), '/home/sandbox/.config');
    assert.equal(env.get('XDG_CACHE_HOME'), '/home/sandbox/.cache');
    assert.equal(env.get('XDG_DATA_HOME'), '/home/sandbox/.local/share');

    assert.equal(binds.get(ws.context.workspaceRoot), '/home/sandbox/workspace');
    assert.equal(binds.get(ws.context.tempRoot), '/tmp');
  } finally {
    await ws.cleanup();
  }
});

test('[isolation/profile] two sessions never share a physical XDG home', async () => {
  const a = await makeTestWorkspace();
  const b = await makeTestWorkspace();
  try {
    const argvA = render(buildIsolationProfile({ context: a.context, mode: 'workspace-write', command: ['true'] }));
    const argvB = render(buildIsolationProfile({ context: b.context, mode: 'workspace-write', command: ['true'] }));
    const sourceA = new Map(pairs(argvA, '--bind').map(([s, d]) => [d, s])).get('/home/sandbox/.config');
    const sourceB = new Map(pairs(argvB, '--bind').map(([s, d]) => [d, s])).get('/home/sandbox/.config');
    assert.notEqual(sourceA, sourceB);
    assert.ok(sourceA?.startsWith(a.context.tempRoot));
    assert.ok(sourceB?.startsWith(b.context.tempRoot));
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});
