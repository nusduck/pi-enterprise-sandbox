/**
 * W4-A 远程 provider 冒烟——macOS 无 exec 内存替身，不依赖真实 MySQL/bwrap。
 *
 * 覆盖：
 * - 本机零文件/进程操作（fetch 被替身拦截，本地 fs 未动）
 * - 错误经 contract/errors 无条件脱敏（物理根必传）
 * - AsyncIterable 二次包（streamText 迭代时才抛的错误也能脱敏）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { RemoteFileSystem } from '../src/providers/remote-fs.js';
import { RemoteShell } from '../src/providers/remote-shell.js';
import { RemoteJobs } from '../src/providers/remote-jobs.js';
import { guardIterable, fromWireError, runWithExecRpc } from '../src/providers/exec-rpc.js';
import type { ExecRpcConfig } from '../src/providers/exec-rpc.js';
import { FsError } from '@deepseek-ai/dsh-fs';
import { toWireError } from '@pi/contract/errors.js';

function fakeFetchForFs(calls: string[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const bodyText = typeof init?.body === 'string' ? (init?.body as string) : '';
    let payload: unknown = null;
    try {
      payload = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>)['payload'] : null;
    } catch {
      payload = null;
    }

    calls.push(u);
    if (u.includes('/internal/v1/fs/resolve')) {
      const p = payload as Record<string, unknown>;
      const pathVal = String(p['path'] ?? '');
      // 模拟一个含物理路径的错误，验证脱敏
      if (pathVal.includes('__leak__')) {
        const errText = `/var/sandbox/workspaces/secret/${pathVal}`;
        const wire = toWireError(new FsError(errText, 'FS_SANDBOX_DENIED'), { physicalRoots: ['/var/sandbox/workspaces/secret'] });
        return new Response(JSON.stringify({ ok: false, error: wire }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      const target = { targetKey: `key:${pathVal}` as unknown as string, displayPath: pathVal };
      return new Response(JSON.stringify({ ok: true, data: target }), { headers: { 'content-type': ' application/json' } });
    }

    if (u.includes('/internal/v1/fs/read-text')) {
      return new Response(JSON.stringify({ ok: true, data: { text: 'hello' } }), { headers: { 'content-type': 'application/json' } });
    }

    if (u.includes('/internal/v1/shell/run')) {
      const result = {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 120000,
        stdout: { text: '', truncated: false },
        stderr: { text: '', truncated: false },
        sandbox: { mode: 'workspace-write', denied: false },
      };
      return new Response(JSON.stringify({ ok: true, data: result }), { headers: { 'content-type': 'application/json' } });
    }

    if (u.includes('/internal/v1/shell/start')) {
      return new Response(JSON.stringify({ ok: true, data: { id: 'shell-1', status: 'running' } }), { headers: { 'content-type': 'application/json' } });
    }

    if (u.includes('/internal/v1/jobs/status') || u.includes('/internal/v1/jobs/read') || u.includes('/internal/v1/jobs/kill')) {
      return new Response(JSON.stringify({ ok: true, data: { id: 'bash-1', kind: 'bash', label: 'echo', status: 'running', startedAt: Date.now(), reported: false } }), { headers: { 'content-type': 'application/json' } });
    }

    return new Response(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'unknown' } }), { status: 404 });
  }) as unknown as typeof fetch;
}

test('remote-fs: 本机零文件操作，resolve 转发且错误无条件脱敏', async () => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'rt-')));
  const probe = join(tmp, 'probe.txt');
  await writeFile(probe, 'local', 'utf8');

  const ctx = new Context();
  const calls: string[] = [];
  const fs = new RemoteFileSystem(ctx as unknown as Context, {
    baseUrl: 'http://exec',
    keyring: { test: Buffer.from('0'.repeat(32)).toString('base64url') },
    activeKid: 'test',
    orgId: 'org-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    fenceToken: 1,
    physicalRoots: ['/var/sandbox/workspaces/secret'],
    fetchImpl: fakeFetchForFs(calls),
  });

  // 正常路径：不再落本地文件，返回远端 target
  const target = await fs.resolve('/workspace/hello.txt');
  assert.equal(target.displayPath, '/workspace/hello.txt');
  assert.equal(calls.some((u) => u.includes('/internal/v1/fs/resolve')), true);
  assert.equal(calls.every((u) => u.startsWith('http://exec/internal/v1/')), true);
  // 本地探针文件应原样存在，未被远程代理误删或改写
  const local = await readFile(probe, 'utf8');
  assert.equal(local, 'local');

  // 触发含物理路径的后端错误，验证脱敏（不再含 /var/sandbox/workspaces/secret）
  await assert.rejects(
    () => fs.resolve('/workspace/__leak__.txt'),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.equal(msg.includes('/var/sandbox/workspaces/secret'), false);
      assert.equal(msg.includes('<workspace>'), true);
      return true;
    },
  );
});

test('remote-fs: streamText 的 AsyncIterable 错误也经 guardIterable 脱敏', async () => {
  const physicalRoots: readonly string[] = ['/var/sandbox/workspaces/secret'];
  const leaky: AsyncIterable<string> = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        async next(): Promise<IteratorResult<string>> {
          throw new Error('boom /var/sandbox/workspaces/secret/inner.txt');
        },
      };
    },
  };

  const guarded = guardIterable(leaky, physicalRoots);
  await assert.rejects(
    async () => {
      for await (const _ of guarded) {
        // unreachable
      }
    },
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.equal(msg.includes('/var/sandbox/workspaces/secret'), false);
      assert.equal(msg.includes('<workspace>'), true);
      // 应被翻成 FsError(INTERNAL_ERROR 经 toWireError) 或保持 FsError
      assert.equal(err instanceof FsError || msg.includes('<workspace>'), true);
      return true;
    },
  );
});

test('remote-fs: fromWireError 按 code 翻回 FsError/ContractError', () => {
  const e1 = fromWireError({ code: 'FS_NOT_FOUND', message: 'nope' });
  assert.equal(e1 instanceof FsError, true);
  const e2 = fromWireError({ code: 'AUTH_FAILED', message: 'deny' });
  assert.equal(e2.message, 'deny');
});

test('remote-shell: run/start 本机零子进程，转发 exec', async () => {
  const ctx = new Context();
  const shell = new RemoteShell(ctx as unknown as Context, {
    baseUrl: 'http://exec',
    keyring: { test: Buffer.from('0'.repeat(32)).toString('base64url') },
    activeKid: 'test',
    orgId: 'org-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    fenceToken: 1,
    physicalRoots: [],
    fetchImpl: fakeFetchForFs(),
  });

  const spec = shell.resolve({ command: 'echo hi' });
  const result = await shell.run(spec);
  assert.equal(result.exitCode, 0);

  const proc = shell.start(spec);
  assert.equal(typeof proc.readOutput, 'function');
  assert.equal(typeof proc.kill, 'function');
  // start 立即返回，不会因本机 spawn 阻塞
  assert.equal(proc.status, 'running');
});

test('remote-jobs: start/list/get/read/kill 均转发 exec 且不抛未脱敏错误', async () => {
  const ctx = new Context();
  const jobs = new RemoteJobs(ctx as unknown as Context, {
    baseUrl: 'http://exec',
    keyring: { test: Buffer.from('0'.repeat(32)).toString('base64url') },
    activeKid: 'test',
    orgId: 'org-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    fenceToken: 1,
    physicalRoots: [],
    fetchImpl: fakeFetchForFs(),
  });

  const id = jobs.start({
    kind: 'bash',
    label: 'echo hi',
    run() {
      return { cancel() {}, done: Promise.resolve({ status: 'completed' as const }) };
    },
  });
  assert.equal(typeof id, 'string');

  const list = jobs.list();
  assert.equal(Array.isArray(list), true);

  const snap = jobs.get(id);
  assert.equal(snap.id, id);

  const read = jobs.read(id);
  assert.equal(typeof read.text, 'string');

  const killRes = jobs.kill(id);
  assert.equal(killRes === 'requested' || killRes === 'already-finished', true);
});

test('remote providers register as ctx.fs/shell/jobs (Cordis plugin contract)', () => {
  const ctx = new Context();
  const cfg: ExecRpcConfig = {
    baseUrl: 'http://exec',
    keyring: { test: Buffer.from('0'.repeat(32)).toString('base64url') },
    activeKid: 'test',
    orgId: 'placeholder',
    userId: 'placeholder',
    workspaceId: 'placeholder',
    fenceToken: 0,
    physicalRoots: ['/var/sandbox/workspaces/secret'],
    fetchImpl: fakeFetchForFs(),
  };
  new RemoteFileSystem(ctx as unknown as Context, cfg);
  new RemoteShell(ctx as unknown as Context, cfg);
  new RemoteJobs(ctx as unknown as Context, cfg);
  assert.equal(typeof ctx.get('fs')?.resolve, 'function');
  assert.equal(typeof ctx.get('shell')?.run, 'function');
  assert.equal(typeof ctx.get('jobs')?.start, 'function');
});

test('runWithExecRpc overlays tenant onto HMAC envelope', async () => {
  const ctx = new Context();
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    const target = { targetKey: 'k', displayPath: '/workspace/a.txt' };
    return new Response(JSON.stringify({ ok: true, data: target }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const fs = new RemoteFileSystem(ctx as unknown as Context, {
    baseUrl: 'http://exec',
    keyring: { test: Buffer.from('0'.repeat(32)).toString('base64url') },
    activeKid: 'test',
    orgId: 'placeholder-org',
    userId: 'placeholder-user',
    workspaceId: 'placeholder-ws',
    fenceToken: 0,
    physicalRoots: ['/var/sandbox/workspaces/secret'],
    fetchImpl,
  });
  await runWithExecRpc(
    {
      baseUrl: 'http://exec',
      keyring: { test: Buffer.from('0'.repeat(32)).toString('base64url') },
      activeKid: 'test',
      orgId: 'org-live',
      userId: 'user-live',
      workspaceId: 'ws-live',
      fenceToken: 9,
      physicalRoots: ['/var/sandbox/workspaces/secret'],
      fetchImpl,
    },
    () => fs.resolve('/workspace/a.txt'),
  );
  assert.equal(bodies.length, 1);
  assert.match(bodies[0]!, /"orgId":"org-live"/);
  assert.match(bodies[0]!, /"workspaceId":"ws-live"/);
  assert.match(bodies[0]!, /"fenceToken":9/);
  assert.equal(bodies[0]!.includes('placeholder-org'), false);
});

test('rebind updates HMAC envelope without ALS', async () => {
  const ctx = new Context();
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    const result = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 120000,
      stdout: { text: 'ok\n', truncated: false },
      stderr: { text: '', truncated: false },
      sandbox: { mode: 'workspace-write', denied: false },
    };
    return new Response(JSON.stringify({ ok: true, data: result }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const shell = new RemoteShell(ctx as unknown as Context, {
    baseUrl: 'http://exec',
    keyring: { test: Buffer.from('0'.repeat(32)).toString('base64url') },
    activeKid: 'test',
    orgId: 'placeholder-org',
    userId: 'placeholder-user',
    workspaceId: 'placeholder-ws',
    fenceToken: 0,
    physicalRoots: ['/var/sandbox/workspaces/secret'],
    fetchImpl,
  });
  shell.rebind({
    baseUrl: 'http://exec',
    keyring: { test: Buffer.from('0'.repeat(32)).toString('base64url') },
    activeKid: 'test',
    orgId: 'org-live',
    userId: 'user-live',
    workspaceId: 'ws-live',
    fenceToken: 4,
    physicalRoots: ['/var/sandbox/workspaces/secret'],
    fetchImpl,
  });
  await shell.run(shell.resolve({ command: 'ls' }));
  assert.equal(bodies.length, 1);
  assert.match(bodies[0]!, /"workspaceId":"ws-live"/);
  assert.match(bodies[0]!, /"orgId":"org-live"/);
  assert.equal(bodies[0]!.includes('placeholder-ws'), false);
});
