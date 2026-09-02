/**
 * The runner: `resolveEffectiveMounts()` / `capabilityDropPrefix()` /
 * `resolveInvocation()` are real-I/O but bwrap-free — testable everywhere.
 * `preflightCheck()`/`spawnLaunch()` actually spawning `bwrap` are gated on
 * the binary being present and skipped otherwise (macOS dev machines, most
 * CI containers).
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  IsolationUnavailable,
  OUTER_PROCESS_ENV,
  capabilityDropPrefix,
  preflightCheck,
  resolveEffectiveMounts,
  resolveInvocation,
  spawnLaunch,
} from '../src/isolation/bubblewrap.js';
import type { BindMount, Mount } from '../src/isolation/profile.js';
import type { IsolationProfile } from '../src/isolation/profile.js';
import { neverExists } from './helpers.js';

const bwrapPath = spawnSync('which', ['bwrap'], { encoding: 'utf-8' }).stdout?.trim();
const bwrapAvailable = Boolean(bwrapPath) && existsSync(bwrapPath ?? '');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

async function scratchDir(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const resolved = await realpath(tmpdir());
  const root = await mkdtemp(join(resolved, 'pi-isolation-bwrap-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// ── capabilityDropPrefix ─────────────────────────────────────────────

test('capabilityDropPrefix(): empty when the process has no inherited capabilities (true on this dev machine)', () => {
  assert.deepEqual(capabilityDropPrefix(), []);
});

test('capabilityDropPrefix(): builds the setpriv prefix when capabilities are present and setpriv is found', () => {
  const prefix = capabilityDropPrefix({
    hasCapabilities: () => true,
    which: () => '/usr/bin/setpriv',
  });
  assert.deepEqual(prefix, ['/usr/bin/setpriv', '--inh-caps=-all', '--ambient-caps=-all', '--']);
});

test('capabilityDropPrefix(): fails closed when capabilities are present but setpriv is missing', () => {
  assert.throws(
    () => capabilityDropPrefix({ hasCapabilities: () => true, which: () => undefined }),
    IsolationUnavailable,
  );
});

// ── resolveEffectiveMounts ────────────────────────────────────────────

test('resolveEffectiveMounts: required=false + ENOENT source is dropped silently (no warning)', async () => {
  const missing: Mount = {
    kind: 'ro_bind',
    source: neverExists('optional'),
    target: '/home/sandbox/skill-user/pkg',
    required: false,
    sessionSpecific: true,
  };
  let degradedCalls = 0;
  const resolved = resolveEffectiveMounts([missing], { onDegraded: () => (degradedCalls += 1) });
  assert.deepEqual(resolved, []);
  assert.equal(degradedCalls, 0, 'ENOENT is the normal "nothing installed yet" case, not a warning');
});

test('resolveEffectiveMounts: required=false + present-but-inaccessible source is dropped WITH a warning (bwraps -try only forgives ENOENT)', async (t) => {
  if (isRoot) {
    t.skip('running as root: permission bits do not deny access, cannot exercise EACCES here');
    return;
  }
  const { root, cleanup } = await scratchDir();
  try {
    const org = join(root, 'skills-user', 'org1');
    const pkg = join(org, 'user1', 'pkg-a');
    await mkdir(pkg, { recursive: true });
    // Exactly the state a 0700-owned install by another uid leaves behind:
    // the ancestor is not traversable, so stat() on the bind source raises EACCES.
    const fs = await import('node:fs/promises');
    await fs.chmod(org, 0o600);
    try {
      const mount: BindMount = {
        kind: 'ro_bind',
        source: pkg,
        target: '/home/sandbox/skill-user/pkg-a',
        required: false,
        sessionSpecific: true,
      };
      let degraded: [BindMount, unknown] | undefined;
      const resolved = resolveEffectiveMounts([mount], {
        onDegraded: (m, err) => (degraded = [m, err]),
      });
      assert.deepEqual(resolved, [], 'the unreadable mount must be dropped, not passed to bwrap');
      assert.ok(degraded, 'onDegraded must fire for a non-ENOENT stat failure');
      assert.equal(degraded?.[0].target, '/home/sandbox/skill-user/pkg-a');
    } finally {
      await fs.chmod(org, 0o755);
    }
  } finally {
    await cleanup();
  }
});

test('resolveEffectiveMounts: required=false + accessible source is kept unchanged', async () => {
  const { root, cleanup } = await scratchDir();
  try {
    const mount: BindMount = {
      kind: 'ro_bind',
      source: root,
      target: '/usr',
      required: false,
      sessionSpecific: false,
    };
    const resolved = resolveEffectiveMounts([mount]);
    assert.deepEqual(resolved, [mount]);
  } finally {
    await cleanup();
  }
});

test('resolveEffectiveMounts: required=true + missing source throws IsolationUnavailable with a human-readable message (not bwraps cryptic one)', () => {
  const missingSource = neverExists('system-skill-root');
  const missing: BindMount = {
    kind: 'ro_bind',
    source: missingSource,
    target: '/home/sandbox/skill',
    required: true,
    sessionSpecific: false,
  };
  assert.throws(
    () => resolveEffectiveMounts([missing]),
    (err: unknown) => {
      assert.ok(err instanceof IsolationUnavailable);
      assert.match(err.message, /missing or inaccessible/);
      assert.ok(err.message.includes(missingSource));
      return true;
    },
  );
});

test('resolveEffectiveMounts: required=true + ensureDir creates the source directory before spawn', async () => {
  const { root, cleanup } = await scratchDir();
  try {
    const homeConfig = join(root, '.home', '.config');
    assert.ok(!existsSync(homeConfig));
    const mount: BindMount = {
      kind: 'bind',
      source: homeConfig,
      target: '/home/sandbox/.config',
      required: true,
      ensureDir: true,
      sessionSpecific: true,
    };
    const resolved = resolveEffectiveMounts([mount]);
    assert.deepEqual(resolved, [mount]);
    assert.ok(existsSync(homeConfig), 'ensureDir must create the missing source directory');
  } finally {
    await cleanup();
  }
});

test('resolveEffectiveMounts: structural mounts (dir/proc/dev/tmpfs) pass through untouched, order preserved', () => {
  const mounts: Mount[] = [
    { kind: 'proc', target: '/proc', sessionSpecific: false },
    { kind: 'ro_bind', source: neverExists('a'), target: '/a', required: false, sessionSpecific: false },
    { kind: 'dev', target: '/dev', sessionSpecific: false },
    { kind: 'dir', target: '/run', sessionSpecific: false },
  ];
  const resolved = resolveEffectiveMounts(mounts);
  assert.deepEqual(resolved, [
    { kind: 'proc', target: '/proc', sessionSpecific: false },
    { kind: 'dev', target: '/dev', sessionSpecific: false },
    { kind: 'dir', target: '/run', sessionSpecific: false },
  ]);
});

// ── resolveInvocation ─────────────────────────────────────────────────

function minimalProfile(mounts: Mount[] = []): IsolationProfile {
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
    mounts,
    env: { clearEnv: true, vars: {} },
    launch: { argv: ['/usr/bin/true'], maxProcessCount: 0 },
  };
}

test('resolveInvocation(): without inherited capabilities, command is bwrap itself', () => {
  const { command, args } = resolveInvocation('/usr/bin/bwrap', minimalProfile());
  assert.equal(command, '/usr/bin/bwrap');
  assert.ok(args.includes('--unshare-user'));
  assert.ok(args.includes('/usr/bin/true'));
});

test('resolveInvocation(): with inherited capabilities, setpriv wraps bwrap as argv[0]', () => {
  const { command, args } = resolveInvocation(
    '/usr/bin/bwrap',
    minimalProfile(),
    undefined,
    { hasCapabilities: () => true, which: () => '/usr/bin/setpriv' },
  );
  assert.equal(command, '/usr/bin/setpriv');
  assert.deepEqual(args.slice(0, 4), ['--inh-caps=-all', '--ambient-caps=-all', '--', '/usr/bin/bwrap']);
});

test('resolveInvocation(): drops an inaccessible optional mount before rendering, so it never reaches bwrap argv', async () => {
  const missing: Mount = {
    kind: 'ro_bind',
    source: neverExists('gone'),
    target: '/home/sandbox/skill-user/gone',
    required: false,
    sessionSpecific: true,
  };
  const { args } = resolveInvocation('/usr/bin/bwrap', minimalProfile([missing]));
  assert.ok(!args.join(' ').includes('/home/sandbox/skill-user/gone'));
});

test('OUTER_PROCESS_ENV is a minimal, fixed env for the bwrap process itself (not the sandboxed environment)', () => {
  assert.deepEqual(OUTER_PROCESS_ENV, { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
});

test('resolveInvocation(): inherited environment mode keeps values out of bwrap argv', () => {
  const secretMarker = 'db-dsn-must-not-be-in-argv';
  const profile = {
    ...minimalProfile(),
    env: { clearEnv: true, vars: { DB_DSN: secretMarker } },
  };
  const { args } = resolveInvocation('/usr/bin/bwrap', profile, undefined, undefined, {
    envMode: 'inherited',
  });
  assert.equal(args.includes(secretMarker), false);
  assert.equal(args.includes('--setenv'), false);
  assert.equal(args.includes('--clearenv'), false);
});

test('spawnLaunch(): inherited environment reaches the child without entering argv', async () => {
  const { root, cleanup } = await scratchDir();
  try {
    const script = join(root, 'env-probe.sh');
    await writeFile(script, '#!/bin/sh\nprintf "%s" "$DB_DSN"\n', 'utf8');
    await chmod(script, 0o755);
    const marker = 'db-dsn-transferred-without-argv';
    const child = spawnLaunch(script, {
      ...minimalProfile(),
      env: { clearEnv: true, vars: { DB_DSN: marker } },
    }, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { output += chunk; });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
    assert.equal(output, marker);
  } finally {
    await cleanup();
  }
});

// ── preflightCheck: the "missing executable" branch needs no real bwrap ──

test('preflightCheck(): throws IsolationUnavailable when the executable does not exist', () => {
  assert.throws(() => preflightCheck(neverExists('bwrap-binary'), minimalProfile()), IsolationUnavailable);
});

// ── Real spawn: only when bwrap is actually installed ───────────────────

test('preflightCheck(): a real bwrap accepts the preflight profile', { skip: !bwrapAvailable }, () => {
  preflightCheck(bwrapPath as string, minimalProfile());
});
