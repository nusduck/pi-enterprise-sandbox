/**
 * 执行面就绪（design §9.2）：`/ready` 要求数据库、四个数据根与启动期 bwrap 预检都通过，
 * 关停中立即不就绪；`/health` 只看进程。
 *
 * 回归背景：2026-09-15 之前 `/ready` 与 `/health` 是同一个恒返回 ok 的处理器。
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createExecAppFromEnv } from '../src/http/app.js';
import { evaluateExecReadiness, type ExecReadinessInput } from '../src/http/readiness.js';

const KEYRING_JSON = JSON.stringify({ kid: Buffer.from('0'.repeat(32)).toString('base64url') });
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let base: string;
before(async () => {
  base = await mkdtemp(join(await realpath(tmpdir()), 'exec-ready-'));
});
after(async () => {
  await chmod(join(base, 'ro'), 0o700).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

async function roots(tag: string) {
  const out = ['workspaces', 'tmp', 'artifacts', 'control'].map((name) => ({
    name,
    path: join(base, tag, name),
  }));
  for (const r of out) await mkdir(r.path, { recursive: true });
  return out;
}

function input(overrides: Partial<ExecReadinessInput> & Pick<ExecReadinessInput, 'storageRoots'>): ExecReadinessInput {
  return {
    pingDatabase: async () => [[{ 1: 1 }]],
    isolation: () => 'ok',
    shuttingDown: () => false,
    timeoutMs: 100,
    ...overrides,
  };
}

describe('evaluateExecReadiness', () => {
  test('全部通过才就绪', async () => {
    const result = await evaluateExecReadiness(input({ storageRoots: await roots('ok') }));
    assert.equal(result.ready, true);
    assert.deepEqual(result.body, {
      status: 'ready',
      shutting_down: false,
      database: 'ok',
      storage: { workspaces: 'ok', tmp: 'ok', artifacts: 'ok', control: 'ok' },
      isolation: 'ok',
    });
  });

  test('未配数据库（非生产内存模式）不算失败', async () => {
    const result = await evaluateExecReadiness(
      input({ storageRoots: await roots('nodb'), pingDatabase: undefined }),
    );
    assert.equal(result.ready, true);
    assert.equal(result.body['database'], 'not_configured');
  });

  test('数据库抛错或挂起即不就绪，且不回显错误文本', async () => {
    const storageRoots = await roots('db');
    for (const pingDatabase of [
      async () => {
        throw new Error('mysql://exec:secret@db');
      },
      () => new Promise(() => {}),
    ]) {
      const result = await evaluateExecReadiness(input({ storageRoots, pingDatabase }));
      assert.equal(result.ready, false);
      assert.equal(result.body['database'], 'unavailable');
      assert.doesNotMatch(JSON.stringify(result.body), /secret|\/exec-ready-/);
    }
  });

  test('数据根缺失、不是目录或不可写即不就绪，只报项名不报路径', async () => {
    const storageRoots = await roots('storage');
    const missing = [{ name: 'workspaces', path: join(base, 'storage', 'nope') }, ...storageRoots.slice(1)];
    let result = await evaluateExecReadiness(input({ storageRoots: missing }));
    assert.equal(result.ready, false);
    assert.deepEqual(result.body['storage'], { workspaces: 'unavailable', tmp: 'ok', artifacts: 'ok', control: 'ok' });
    assert.doesNotMatch(JSON.stringify(result.body), /exec-ready-/);

    const file = join(base, 'storage', 'file');
    await writeFile(file, 'x');
    result = await evaluateExecReadiness(input({ storageRoots: [{ name: 'tmp', path: file }] }));
    assert.equal(result.ready, false);

    if (!isRoot) {
      const ro = join(base, 'ro');
      await mkdir(ro, { recursive: true });
      await chmod(ro, 0o500);
      result = await evaluateExecReadiness(input({ storageRoots: [{ name: 'control', path: ro }] }));
      assert.equal(result.ready, false);
      assert.deepEqual(result.body['storage'], { control: 'unavailable' });
    }
  });

  test('隔离未预检或不可用即不就绪', async () => {
    const storageRoots = await roots('iso');
    for (const state of ['unchecked', 'unavailable'] as const) {
      const result = await evaluateExecReadiness(input({ storageRoots, isolation: () => state }));
      assert.equal(result.ready, false, state);
      assert.equal(result.body['isolation'], state);
    }
  });

  test('关停中立即不就绪，也不再探测数据库', async () => {
    let pings = 0;
    const result = await evaluateExecReadiness(
      input({
        storageRoots: await roots('down'),
        shuttingDown: () => true,
        pingDatabase: async () => {
          pings += 1;
        },
      }),
    );
    assert.equal(result.ready, false);
    assert.equal(pings, 0);
  });
});

describe('createExecAppFromEnv wires /ready to startup preflight', () => {
  async function runtimeWith(bwrap: string, tag: string) {
    const dir = join(base, tag);
    const env = {
      DEPLOYMENT_ENV: 'development',
      SANDBOX_INTERNAL_HMAC_KEYRING: KEYRING_JSON,
      SANDBOX_INTERNAL_HMAC_ACTIVE_KID: 'kid',
      SANDBOX_API_TOKEN: 'exec-test-service-token-32-bytes-long',
      // 预检负责建出四个根：这里故意不预先创建。
      SANDBOX_WORKSPACES_ROOT: join(dir, 'ws'),
      SANDBOX_TEMP_ROOT: join(dir, 'tmp'),
      SANDBOX_ARTIFACTS_ROOT: join(dir, 'artifacts'),
      SANDBOX_CONTROL_ROOT: join(dir, 'control'),
      SANDBOX_SKILLS_ROOT: join(dir, 'skills'),
      SANDBOX_BWRAP_PATH: bwrap,
    } as NodeJS.ProcessEnv;
    await mkdir(join(dir, 'skills'), { recursive: true });
    return createExecAppFromEnv(env);
  }

  test('预检前 503（isolation unchecked）；假 bwrap 通过后 200；关停后 503', async () => {
    const fakeBwrap = join(base, 'fake-bwrap.sh');
    await writeFile(fakeBwrap, '#!/bin/sh\nexit 0\n');
    await chmod(fakeBwrap, 0o755);
    const runtime = await runtimeWith(fakeBwrap, 'positive');
    try {
      let res = await runtime.app.request('/ready');
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as Record<string, unknown>)['isolation'], 'unchecked');
      assert.equal((await runtime.app.request('/health')).status, 200);

      await runtime.preflight();
      for (const path of ['/ready', '/health/ready']) {
        res = await runtime.app.request(path);
        assert.equal(res.status, 200, path);
      }

      runtime.markShuttingDown();
      res = await runtime.app.request('/ready');
      assert.equal(res.status, 503);
      assert.equal((await runtime.app.request('/health')).status, 200);
    } finally {
      await runtime.dispose();
    }
  });

  test('bwrap 不存在或探针失败：preflight 抛出，/ready 报 isolation unavailable', async () => {
    const failing = join(base, 'failing-bwrap.sh');
    await writeFile(failing, '#!/bin/sh\necho denied >&2\nexit 1\n');
    await chmod(failing, 0o755);
    for (const [tag, bwrap] of [
      ['missing', join(base, 'no-such-bwrap')],
      ['failing', failing],
    ] as const) {
      const runtime = await runtimeWith(bwrap, tag);
      try {
        await assert.rejects(() => runtime.preflight(), { name: 'IsolationUnavailable' }, tag);
        const res = await runtime.app.request('/ready');
        assert.equal(res.status, 503, tag);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body['isolation'], 'unavailable', tag);
        assert.doesNotMatch(JSON.stringify(body), /denied|bwrap/, tag);
      } finally {
        await runtime.dispose();
      }
    }
  });
});
