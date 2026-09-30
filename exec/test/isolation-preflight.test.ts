/**
 * ADR 0008 验证要求 2："preflight 同源"：断言 `preflight` 与 `prepare`
 * 渲染自同一个 profile。今天 Python 版 `preflight()` 手抄了 `prepare()` 的
 * 一个子集，两份列表已经分叉——具体缺了什么见 `preflight.ts` 顶部注释。
 *
 * 这里的核心断言方式：拿同一次 `buildIsolationProfile()` 调用的结果（等价于
 * "prepare 会用的 profile"），喂给 `toPreflightProfile()`，断言后者的静态
 * 挂载/命名空间策略是前者的**字面子集**（`Array.prototype.filter` 的结果，
 * 不是重新拼出来的另一份列表）——只有这样才能保证"分叉在构造层面不可能发生"。
 */
import { AGENT_PYTHON_VENV } from '../src/isolation/profile.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIsolationProfile } from '../src/isolation/build.js';
import { buildPreflightProfile, toPreflightProfile } from '../src/isolation/preflight.js';
import type { BindMount, IsolationProfile, Mount } from '../src/isolation/profile.js';
import { makeTestWorkspace } from './helpers.js';

function bindMounts(mounts: readonly Mount[]): BindMount[] {
  return mounts.filter((m): m is BindMount => m.kind === 'ro_bind' || m.kind === 'bind');
}

test('preflight profile mounts are exactly the non-session-specific subset of the real profile (same source, not a second list)', async () => {
  const ws = await makeTestWorkspace({ enabledPackages: ['pkg-a', 'pkg-b'] });
  try {
    const real = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['bash', '-c', 'pwd'],
    });
    const preflight = toPreflightProfile(real);

    const expected = real.mounts.filter((m) => !m.sessionSpecific);
    assert.deepEqual(preflight.mounts, expected);
    assert.ok(expected.length > 0, 'sanity: there should be static mounts to compare');
  } finally {
    await ws.cleanup();
  }
});

test('preflight profile drops exactly the session-specific mounts: workspace, temp, 3 home dirs, per-package skill binds', async () => {
  const ws = await makeTestWorkspace({ enabledPackages: ['pkg-a', 'pkg-b'] });
  try {
    const real = buildIsolationProfile({
      context: ws.context,
      mode: 'workspace-write',
      command: ['true'],
    });
    const preflight = toPreflightProfile(real);
    const droppedTargets = new Set(
      real.mounts.filter((m) => m.sessionSpecific).map((m) => m.target),
    );
    const keptTargets = new Set(preflight.mounts.map((m) => m.target));

    // 逐包 skill 挂载（含系统层）都是 sessionSpecific，因此都不进探针——
    // 探针不带任何清单（design §6.4）。
    for (const target of [
      '/home/sandbox/workspace',
      '/tmp',
      '/home/sandbox/.config',
      '/home/sandbox/.cache',
      '/home/sandbox/.local/share',
      '/home/sandbox/skill-user/pkg-a',
      '/home/sandbox/skill-user/pkg-b',
    ]) {
      assert.ok(droppedTargets.has(target), `${target} must be session-specific`);
      assert.ok(!keptTargets.has(target), `${target} must not survive into the preflight profile`);
    }
  } finally {
    await ws.cleanup();
  }
});

test('preflight profile keeps every static mount build.ts produces — including ones prepare() has but Pythons preflight() historically dropped', async () => {
  const ws = await makeTestWorkspace();
  try {
    const real = buildIsolationProfile({ context: ws.context, mode: 'workspace-write', command: ['true'] });
    const preflight = toPreflightProfile(real);
    const targets = new Set(preflight.mounts.map((m) => m.target));

    // 七条 --dir：今天 Python 版 preflight 只有 /home /home/sandbox 两条。
    for (const dir of ['/run', '/home', '/home/sandbox', '/var', '/var/tmp', '/etc', '/app']) {
      assert.ok(targets.has(dir), `missing structural dir mount: ${dir}`);
    }
    // 六条静态 runtime 路径：今天 Python 版 preflight 缺 /sbin。
    for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/usr/local']) {
      assert.ok(targets.has(path), `missing static runtime mount: ${path}`);
    }
    // Python venv 与 /etc 白名单：今天 Python 版 preflight 完全没有。
    // 引用常量而不是再抄一遍字符串——两处各写一份正是 2026-08-30 那个
    // "挂载与 PATH 同时指向已不存在的 /app/.venv" 的成因。
    assert.ok(targets.has(AGENT_PYTHON_VENV), `missing venv mount: ${AGENT_PYTHON_VENV}`);
    for (const path of [
      '/etc/passwd',
      '/etc/group',
      '/etc/nsswitch.conf',
      '/etc/hosts',
      '/etc/resolv.conf',
      '/etc/ssl',
      '/etc/ca-certificates',
      '/etc/ld.so.cache',
      '/etc/localtime',
      '/etc/fonts',
      '/etc/pki/tls/certs',
      '/etc/pki/tls/cert.pem',
      '/etc/pki/tls/openssl.cnf',
      '/etc/pki/ca-trust/extracted',
      '/etc/libreoffice/registry',
      '/etc/libreoffice/psprint.conf',
    ]) {
      assert.ok(targets.has(path), `missing static /etc file mount: ${path}`);
    }
    // 系统 skill 层**不在探针里**：它现在是逐包的、sessionSpecific 的挂载
    // （design §6.4「探针不变」——它本就不带清单），整树挂载的静态条目已删除。
    assert.ok(!targets.has('/home/sandbox/skill'));
  } finally {
    await ws.cleanup();
  }
});

test('preflight profile forces fail-safe launch policy regardless of what the source profile had', () => {
  const durableHandleProfile: IsolationProfile = {
    namespace: {
      namespaces: ['user', 'pid', 'ipc', 'uts'], // allowlist network in the source
      uid: 10001,
      gid: 10001,
      asPid1: true, // durable process handle
      dieWithParent: false, // durable process handle
      newSession: true,
      capDrop: 'ALL',
    },
    mounts: [{ kind: 'proc', target: '/proc', sessionSpecific: false }],
    env: { clearEnv: true, vars: { HOME: '/home/sandbox' } },
    launch: { argv: ['bash', '-c', 'sleep 120'], cwd: '/home/sandbox/workspace', maxProcessCount: 0 },
  };

  const preflight = toPreflightProfile(durableHandleProfile);
  assert.equal(preflight.namespace.dieWithParent, true, 'preflight must not inherit die-with-parent=false');
  assert.equal(preflight.namespace.asPid1, false, 'preflight must not inherit as-pid-1=true');
  assert.ok(preflight.namespace.namespaces.includes('net'), 'preflight always fail-closes the network, regardless of source');
  assert.deepEqual(preflight.launch.argv, ['/usr/bin/true']);
  assert.equal(preflight.launch.cwd, undefined, 'no session cwd exists for a probe');
  assert.deepEqual(preflight.env.vars, { PATH: '/usr/bin:/bin', HOME: '/home/sandbox' });
});

test('buildPreflightProfile(): synthesizes a probe profile without needing a real session on disk', () => {
  const preflight = buildPreflightProfile({ systemSkillRoot: '/opt/skills' });
  // 探针不带系统名单：整个系统根作为非会话的硬绑定进 profile，启动时就能发现
  // 「系统 Skill 根缺失或绑不上」（design §6.4 / §8）。逐包的用户/org 层不在探针里。
  const systemSkill = preflight.mounts.find((m) => m.target === '/home/sandbox/skill');
  assert.ok(systemSkill && systemSkill.kind === 'ro_bind' && systemSkill.required === true);
  assert.ok(!preflight.mounts.some((m) => m.target.startsWith('/home/sandbox/skill-')));
  assert.ok(!preflight.mounts.some((m) => m.sessionSpecific));
  assert.deepEqual(preflight.launch.argv, ['/usr/bin/true']);
  assert.ok(preflight.namespace.namespaces.includes('net'));
});

test('buildPreflightProfile(): uid/gid pass through, and the injected writableRootsFn is irrelevant to the result', () => {
  const withDefault = buildPreflightProfile({ systemSkillRoot: '/opt/skills', uid: 555, gid: 777 });
  const withStub = buildPreflightProfile({
    systemSkillRoot: '/opt/skills',
    uid: 555,
    gid: 777,
    writableRootsFn: () => [], // 反正 preflight 会把引用它的挂载全部过滤掉
  });
  assert.equal(withDefault.namespace.uid, 555);
  assert.equal(withDefault.namespace.gid, 777);
  assert.deepEqual(withStub, withDefault, 'result must not depend on what writableRoots() returns');
});
