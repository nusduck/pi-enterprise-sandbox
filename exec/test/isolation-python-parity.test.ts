/**
 * 逐条对照 `tests/test_bubblewrap_isolation.py`（Python 版隔离层测试）的场景。
 * 每个 test 名字前缀 `[py: <原函数名>]` 标出对应的 Python 用例，方便审阅时
 * 交叉核对"一条不减"这件事本身。
 *
 * 两条 Python 用例没有直接搬过来，原因写在各自该在的地方而不是这里省略：
 *
 * - `test_process_manager_disables_die_with_parent_for_durable_handle`：测的是
 *   `ProcessManager`（谁在什么时候把 `die_with_parent=False`/`as_pid_1=True`
 *   传给隔离层），不是隔离层自己的行为——这是 W2（`exec/src/shell/`）的范围，
 *   不在 `exec/src/isolation/` 里。隔离层这边"给定这两个字段，argv 该长什么
 *   样"的行为，被下面的
 *   `[py: test_bwrap_durable_process_can_outlive_api_parent / ...pid_namespace_init]`
 *   两条覆盖到了。
 * - `test_bwrap_preflight_uses_private_proc`：这条测的是"读 Python 源码文本，
 *   断言字符串 `--proc` 出现、`--bind /proc` 不出现"——这是给"两份手写 argv
 *   列表不会偷偷退回共享 /proc"上的一个防线。新架构下 `preflight()` 根本不再
 *   手写任何列表（`toPreflightProfile()` 是从同一个 profile 过滤出来的），
 *   这条防线的意义已经被结构本身取代；等价的结构断言在
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

test('[py: test_bwrap_maps_workspace_temp_and_readonly_skills] workspace/temp bound, system skill read-only, no outer /proc bind, unshare flags present, env override passes through', async () => {
  const ws = await makeTestWorkspace();
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
    const roReadonlySkill = pairs(argv, '--ro-bind').filter(([, d]) => d === '/home/sandbox/skill');
    assert.deepEqual(roReadonlySkill, [[ws.context.systemSkillRoot, '/home/sandbox/skill']]);
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

test('[py: test_bwrap_durable_process_can_outlive_api_parent] die_with_parent=false omits --die-with-parent, keeps --new-session', async () => {
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

test('[py: test_bwrap_durable_process_can_make_command_pid_namespace_init] as_pid_1=true emits --as-pid-1', async () => {
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

test('[py: test_bwrap_drops_trusted_service_capabilities_before_exec] setpriv prefix precedes the bwrap executable', async () => {
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

test('[py: test_bwrap_defers_nproc_until_after_user_namespace] max_process_count wraps the command in an in-namespace ulimit wrapper', async () => {
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
    assert.match(command[2] ?? '', /ulimit -S -u/);
    assert.match(command[2] ?? '', /ulimit -H -u/);
    assert.equal(command[4], '20');
    assert.deepEqual(command.slice(5), ['bash', '-c', 'printf ok']);
  } finally {
    await ws.cleanup();
  }
});

test('[py: test_bwrap_does_not_add_nproc_wrapper_when_unrequested] no wrapper when max_process_count is unset', async () => {
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

test('[py: test_bwrap_preflight_exercises_launch_namespace_policy] preflight rendering exercises the full namespace policy with the configured uid/gid', async () => {
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
    assert.ok(
      pairs(argv, '--ro-bind').some(
        ([s, d]) => s === ws.context.systemSkillRoot && d === '/home/sandbox/skill',
      ),
    );
  } finally {
    await ws.cleanup();
  }
});

test('[py: test_bwrap_can_start_process_in_persistent_temp] relative cwd in the temp scope resolves under /tmp', async () => {
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

test('[py: test_bwrap_rejects_unknown_network_mode] unsupported network mode is rejected before any argv is built', async () => {
  const ws = await makeTestWorkspace();
  try {
    assert.throws(
      () =>
        buildIsolationProfile({
          context: ws.context,
          mode: 'workspace-write',
          command: ['bash', '-c', 'echo ok'],
          // @ts-expect-error deliberately invalid
          networkMode: 'open-everything',
        }),
      IsolationConfigError,
    );
  } finally {
    await ws.cleanup();
  }
});

test('[py: test_bwrap_never_inherits_host_secret_environment] build.ts never autonomously pulls process.env into the profile (see report: the allowlist/denylist gate itself is a W2 gap)', async () => {
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

test('[py: test_bwrap_binds_only_the_callers_own_user_skill_dir] (reframed for D4) only this contexts enabled packages are bound, at their given absolute path, always read-only', async () => {
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

test('[py: test_bwrap_omits_user_skill_tier_without_identity] (reframed for D4) no enabled packages means no skill-user mounts, system tier untouched', async () => {
  const ws = await makeTestWorkspace();
  try {
    const profile = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['bash', '-c', 'pwd'],
    });
    const argv = render(profile);
    assert.ok(
      pairs(argv, '--ro-bind').some(
        ([s, d]) => s === ws.context.systemSkillRoot && d === '/home/sandbox/skill',
      ),
    );
    assert.ok(!argv.join(' ').includes('/home/sandbox/skill-user'));
  } finally {
    await ws.cleanup();
  }
});

test('[py: test_bwrap_names_the_missing_skill_root_instead_of_failing_at_launch] (relocated to the runner layer) missing system skill root fails before bwrap runs, naming the path and the mount', async () => {
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
    },
    mode: 'read-only', // 避免真的去挂 workspace/temp 根，这条用例只关心 skill 根
    command: ['bash', '-c', 'pwd'],
  });
  assert.throws(
    () => resolveEffectiveMounts(profile.mounts),
    (err: unknown) => {
      assert.ok(err instanceof IsolationUnavailable);
      assert.match(err.message, /missing or inaccessible/);
      assert.ok(err.message.includes(missingRoot));
      return true;
    },
  );
});

test('[py: test_bwrap_still_launches_when_only_the_user_skill_tier_is_absent] a user with an enabled-but-not-yet-installed package still gets bash/pwd', async () => {
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

test('[py: test_bwrap_degrades_to_system_tier_when_user_skill_root_is_unreadable] one users broken package mount does not cost that user bash/python (only if not root)', async (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('running as root: chmod-based EACCES cannot be exercised');
    return;
  }
  const ws = await makeTestWorkspace();
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
      args.some((tok, i) => tok === '--ro-bind' && args[i + 2] === '/home/sandbox/skill'),
      'system tier must still be bound',
    );
    assert.deepEqual(args.slice(args.indexOf('--') + 1), ['bash', '-c', 'pwd']);
  } finally {
    await chmod(orgDir, 0o755);
    await ws.cleanup();
  }
});

test('[py: test_bwrap_gives_the_session_a_persistent_xdg_home] HOME/XDG_* env vars and the three home binds are present', async () => {
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

test('[py: test_persistent_home_is_per_session_not_shared] two sessions never share a physical XDG home', async () => {
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
