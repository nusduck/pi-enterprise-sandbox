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
import { RemoteFileSystem } from '../../src/runtime/providers/remote-fs.js';
import { RemoteShell } from '../../src/runtime/providers/remote-shell.js';
import { RemoteJobs } from '../../src/runtime/providers/remote-jobs.js';
import { guardIterable, fromWireError, runWithExecRpc } from '../../src/runtime/providers/exec-rpc.js';
import type { ExecRpcConfig } from '../../src/runtime/providers/exec-rpc.js';
import { FsError } from '@deepseek-ai/dsh-fs';
import { toWireError } from '@pi/contract/errors.js';
import { verifyInternalToken, internalBindingForHtu } from '@pi/contract/hmac.js';

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
      const p = payload as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, data: { id: p['id'], status: 'running' } }), { headers: { 'content-type': 'application/json' } });
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

  const proc = shell.start(spec) as ReturnType<RemoteShell['start']> & { id?: string };
  assert.equal(typeof proc.readOutput, 'function');
  assert.equal(typeof proc.kill, 'function');
  // start 立即返回，不会因本机 spawn 阻塞
  assert.equal(proc.status, 'running');
  assert.match(String(proc.id), /^bash-[a-f0-9]{32}$/);
});

test('remote-shell: 后台句柄轮询 exec 结算并保留增量输出', async () => {
  const ctx = new Context();
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/shell/start')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { payload?: { id?: string } };
      return new Response(JSON.stringify({ ok: true, data: { id: body.payload?.id, status: 'running' } }));
    }
    if (path.endsWith('/jobs/read')) {
      return new Response(JSON.stringify({
        ok: true,
        data: { text: 'JOB_OK\n', lossy: false, nextCursor: '1-1' },
      }));
    }
    if (path.endsWith('/jobs/status')) {
      return new Response(JSON.stringify({
        ok: true,
        data: { status: 'completed', exitCode: 0, signal: null },
      }));
    }
    return new Response(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'unexpected' } }), { status: 500 });
  }) as unknown as typeof fetch;
  const shell = new RemoteShell(ctx as unknown as Context, {
    baseUrl: 'http://exec',
    keyring: { test: Buffer.from('0'.repeat(32)).toString('base64url') },
    activeKid: 'test',
    orgId: 'org-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    fenceToken: 1,
    physicalRoots: [],
    fetchImpl,
  });
  const proc = shell.start(shell.resolve({ command: 'echo JOB_OK' }));
  await proc.done;
  assert.equal(proc.status, 'completed');
  assert.equal(proc.exitCode, 0);
  assert.equal(proc.readOutput().delta, 'JOB_OK\n');
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
  assert.match(String(id), /^bash-[a-f0-9]{32}$/);

  const list = jobs.list();
  assert.equal(Array.isArray(list), true);
  assert.equal(list.some((item) => item.id === id), true);

  const snap = jobs.get(id);
  assert.equal(snap.id, id);

  const read = jobs.read(id);
  assert.equal(typeof read.text, 'string');

  const killRes = jobs.kill(id);
  assert.equal(killRes === 'requested' || killRes === 'already-finished', true);
});

test('remote-jobs: 本地 registry 兑现 wait/read 与完成状态', async () => {
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
  let finish!: (outcome: { status: 'completed'; output: string }) => void;
  const done = new Promise<{ status: 'completed'; output: string }>((resolve) => {
    finish = resolve;
  });
  const id = jobs.start({
    kind: 'bash',
    label: 'buffered job',
    run() {
      return { cancel() {}, done };
    },
  });
  assert.equal(jobs.get(id).status, 'running');
  finish({ status: 'completed', output: 'final output' });
  const snap = await jobs.wait(id, 100);
  assert.equal(snap.status, 'completed');
  assert.equal(jobs.read(id).text, 'final output');
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

/** 有界等待：修复前这些循环永不结束，用它把"挂死"变成一条可断言的失败。 */
async function settledWithin(proc: { done: Promise<void> }, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([proc.done.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function shellWith(fetchImpl: typeof fetch, monitor: Record<string, number> = {}) {
  return new RemoteShell(new Context() as unknown as Context, {
    baseUrl: 'http://exec',
    keyring: { test: Buffer.from('0'.repeat(32)).toString('base64url') },
    activeKid: 'test',
    orgId: 'org-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    fenceToken: 1,
    physicalRoots: [],
    fetchImpl,
    monitor,
  });
}

test('remote-shell: exec 说作业不存在时立刻结算，不再空转轮询', async () => {
  // 回归：monitor 的 catch 把一切错误都当成"网络抖动，下一轮继续"，于是一个
  // 查不到的作业会让 Worker 以 5 次/秒的频率永远轮询下去，`done` 永不 resolve。
  let statusCalls = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/shell/start')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { payload?: { id?: string } };
      return new Response(JSON.stringify({ ok: true, data: { id: body.payload?.id, status: 'running' } }));
    }
    if (path.endsWith('/jobs/status')) {
      statusCalls += 1;
      return new Response(
        JSON.stringify({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND', message: 'job not found' } }),
        { status: 404 },
      );
    }
    return new Response(JSON.stringify({ ok: true, data: { text: '', lossy: false } }));
  }) as unknown as typeof fetch;

  const proc = shellWith(fetchImpl).start({ command: 'sleep 1' } as never);
  assert.equal(await settledWithin(proc, 3_000), true, 'a vanished job must settle, not poll forever');
  assert.equal(proc.status, 'killed');
  assert.ok(statusCalls <= 2, `expected to stop polling immediately, got ${statusCalls} status calls`);
});

test('remote-shell: 传输持续失败时退避并在截止时间后结算为终态', async () => {
  // 回归：没有截止时间的话，exec 长时间不可用会让这个 while 循环永远转下去。
  let statusCalls = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/shell/start')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { payload?: { id?: string } };
      return new Response(JSON.stringify({ ok: true, data: { id: body.payload?.id, status: 'running' } }));
    }
    if (path.endsWith('/jobs/status')) {
      statusCalls += 1;
      return new Response(
        JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'exec is down' } }),
        { status: 500 },
      );
    }
    return new Response(JSON.stringify({ ok: true, data: { text: '', lossy: false } }));
  }) as unknown as typeof fetch;

  const shell = shellWith(fetchImpl, { minDelayMs: 5, maxDelayMs: 20, failureDeadlineMs: 120 });
  const proc = shell.start({ command: 'sleep 1' } as never);
  assert.equal(await settledWithin(proc, 3_000), true, 'persistent transport failure must reach a terminal state');
  assert.equal(proc.status, 'killed');
  // 退避生效：120ms 的截止窗口里不该出现几十次调用。
  assert.ok(statusCalls < 20, `expected backoff to throttle polling, got ${statusCalls} calls`);
});

test('exec-rpc: getStream 在响应头之后卡住也会超时，而不是永远挂着', async () => {
  // 回归：连接超时的定时器在 `finally` 里被清掉，之后逐 chunk 读流没有任何
  // 截止；exec 在传输途中挂起，这个异步生成器就永远不会再被唤醒。
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first chunk'));
      // 之后再不产出，也不 close —— 模拟传输中途挂起。
    },
  });
  const fetchImpl = (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/fs/stream-text')) {
      return new Response(stalled, { headers: { 'content-type': 'text/plain' } });
    }
    return new Response(JSON.stringify({ ok: true, data: {} }));
  }) as unknown as typeof fetch;

  const fs = new RemoteFileSystem(new Context() as unknown as Context, {
    baseUrl: 'http://exec',
    keyring: { test: Buffer.from('0'.repeat(32)).toString('base64url') },
    activeKid: 'test',
    orgId: 'org-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    fenceToken: 1,
    physicalRoots: [],
    fetchImpl,
    timeoutMs: 150,
  } as unknown as Partial<ExecRpcConfig>);

  const started = Date.now();
  const chunks: string[] = [];
  await assert.rejects(async () => {
    for await (const chunk of await fs.streamText('notes.txt')) chunks.push(chunk);
  }, /stalled|abort/i);
  assert.deepEqual(chunks, ['first chunk'], 'the chunk that did arrive is still delivered');
  assert.ok(Date.now() - started < 3_000, 'must give up soon after the stall deadline');
});

test('exec-rpc: 令牌的 htm/scope/tool_name 与真实请求逐字一致', async () => {
  // 回归：`issueToken` 拿到 method 参数之后，`post()` 与 `getStream()` 两处调用
  // 一度签反了——POST 请求带着 htm=GET 的令牌，exec 全线 401 `htm mismatch`。
  // 单测里的假 fetch 不校验 HMAC，所以这类错误只有解开令牌才看得见。
  const seen: { method: string; path: string; claims: Record<string, unknown> }[] = [];
  const keyring = { test: Buffer.from('0'.repeat(32)).toString('base64url') };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const auth = new Headers(init?.headers as HeadersInit).get('authorization') ?? '';
    const claims = verifyInternalToken(auth.replace(/^Bearer /, ''), { keyring });
    seen.push({ method: init?.method ?? 'GET', path: u.pathname, claims: claims as never });
    if (u.pathname.endsWith('/fs/stream-text')) {
      return new Response(new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode('body')); c.close(); },
      }));
    }
    return new Response(JSON.stringify({ ok: true, data: { targetKey: 'k', displayPath: 'p' } }));
  }) as unknown as typeof fetch;

  const cfg = {
    baseUrl: 'http://exec', keyring, activeKid: 'test',
    orgId: 'org-1', userId: 'user-1', workspaceId: 'ws-1',
    fenceToken: 1, physicalRoots: [], fetchImpl,
  };
  const fs = new RemoteFileSystem(new Context() as unknown as Context, cfg as unknown as Partial<ExecRpcConfig>);
  await fs.resolve('notes.txt');
  for await (const _chunk of await fs.streamText('notes.txt')) { /* drain */ }

  assert.ok(seen.length >= 2, `expected two calls, got ${seen.length}`);
  for (const call of seen) {
    assert.equal(call.claims['htm'], call.method,
      `${call.path}: token htm ${String(call.claims['htm'])} != request method ${call.method}`);
    assert.equal(call.claims['htu'], call.path);
    const binding = internalBindingForHtu(call.path);
    assert.ok(binding, `${call.path} must have a scope binding`);
    assert.deepEqual(call.claims['scope'], [binding!.scope]);
    assert.equal(call.claims['tool_name'], binding!.toolName);
  }
});
