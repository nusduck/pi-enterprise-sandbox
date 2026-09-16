/**
 * `remote-shell` 与 `exec-rpc` 的两条回归（2026-09-16 审查 R2 / R6）。
 *
 * R2：`RemoteShell.run` 把 120000 ms 放进 payload，而 `ExecRpcClient.post`
 * 用一个与之无关的 15000 ms 传输超时——命令超过 15 秒时 Agent 先收到工具
 * 错误，sandbox 那边还在继续跑、继续写文件。现在传输截止 = 执行预算 +
 * 有界回传余量，调用方的 `signal` 也真的会断开连接。
 *
 * R6：后台句柄的 `outputBuf` 无上限追加，只有模型调 `readOutput()` 才清空。
 * 现在缓冲有界、保留尾部、截断置 `lossy`。
 *
 * 全部走注入的 fetch 替身，不连 exec。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { RemoteShell } from '../../src/runtime/providers/remote-shell.js';
import {
  ExecRpcClient,
  EXEC_RPC_MAX_DEADLINE_MS,
  resolveDeadlineMs,
} from '../../src/runtime/providers/exec-rpc.js';

const BASE = {
  baseUrl: 'http://exec',
  keyring: { test: Buffer.from('0'.repeat(32)).toString('base64url') },
  activeKid: 'test',
  orgId: 'org-1',
  userId: 'user-1',
  workspaceId: 'ws-1',
  fenceToken: 1,
  physicalRoots: [] as readonly string[],
};

/**
 * 等 `done`，同时用一个**不 unref** 的心跳定时器把事件循环撑住。
 *
 * `remote-shell` 的监控循环刻意 `unref` 了自己的定时器（不该让一个后台
 * 作业阻止进程退出）。在 `node --test` 里这意味着「只剩监控在跑」时事件
 * 循环会直接排空，测试被判成 `cancelledByParent` 而不是真的跑完。
 */
async function awaitDone(done: Promise<void>, budgetMs = 10_000): Promise<void> {
  const heartbeat = setInterval(() => undefined, 20);
  const guard = setTimeout(() => {
    throw new Error('background job did not settle within budget');
  }, budgetMs);
  try {
    await done;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(guard);
  }
}

function runResult(timeoutMs: number): unknown {
  return {
    ok: true,
    data: {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs,
      stdout: { text: 'ok', truncated: false },
      stderr: { text: '', truncated: false },
      sandbox: { mode: 'workspace-write', denied: false },
    },
  };
}

test('R2: 前台执行的传输截止跟随执行预算，而不是固定 15 秒', async () => {
  // 替身在 abort 时才 reject，并记录等了多久——与审查探针同一手法，
  // 只是断言从"确认缺陷"翻成了"预期行为"。
  const elapsedFor = async (timeoutMs: number): Promise<number> => {
    let elapsed = -1;
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const start = Date.now();
        init.signal?.addEventListener(
          'abort',
          () => {
            elapsed = Date.now() - start;
            reject(new Error('aborted'));
          },
          { once: true },
        );
      })) as unknown as typeof fetch;
    const rpc = new ExecRpcClient({ ...BASE, fetchImpl });
    // 用很小的预算保证测试本身跑得快；关键是截止**跟着预算走**。
    await assert.rejects(
      rpc.post('/internal/v1/shell/run', { command: 'sleep' }, [], { deadlineMs: timeoutMs }),
    );
    return elapsed;
  };

  const short = await elapsedFor(120);
  const long = await elapsedFor(600);
  assert.ok(short >= 100 && short < 400, `short deadline honoured, got ${short}ms`);
  assert.ok(long >= 550, `long deadline honoured, got ${long}ms`);
});

test('R2: 调用方取消立刻断连，不等截止定时器', async () => {
  const caller = new AbortController();
  let sawAbort = false;
  const fetchImpl = (async (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        sawAbort = true;
        reject(new Error('aborted'));
      });
      setTimeout(() => caller.abort(), 20);
    })) as unknown as typeof fetch;
  const rpc = new ExecRpcClient({ ...BASE, fetchImpl });
  const started = Date.now();
  await assert.rejects(
    rpc.post('/internal/v1/shell/run', { command: 'sleep 600' }, [], {
      deadlineMs: 60_000,
      signal: caller.signal,
    }),
  );
  assert.equal(sawAbort, true);
  assert.ok(Date.now() - started < 5_000, 'caller cancellation must not wait for the deadline');
});

test('R2: 截止时间被归一化到有界范围', () => {
  assert.equal(resolveDeadlineMs(undefined, undefined), 15_000);
  assert.equal(resolveDeadlineMs(0, 20_000), 15_000);
  assert.equal(resolveDeadlineMs(Number.NaN, 20_000), 15_000);
  assert.equal(resolveDeadlineMs(undefined, 30_000), 30_000);
  assert.equal(resolveDeadlineMs(45_000, 30_000), 45_000);
  // 断网没被及时感知时，仍有一个最后的有界上限。
  assert.equal(resolveDeadlineMs(Number.MAX_SAFE_INTEGER, undefined), EXEC_RPC_MAX_DEADLINE_MS);
});

test('R2: run 不再把 AbortSignal 序列化成布尔值，且带上执行预算与余量', async () => {
  let sentPayload: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sentPayload = (JSON.parse(String(init.body)) as { payload: Record<string, unknown> }).payload;
    return new Response(JSON.stringify(runResult(30_000)), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const shell = new RemoteShell(new Context() as unknown as Context, { ...BASE, fetchImpl });
  const controller = new AbortController();
  const spec = shell.resolve({ command: 'echo hi', timeoutMs: 30_000, signal: controller.signal });
  const result = await shell.run(spec);
  assert.equal(result.exitCode, 0);
  assert.equal(sentPayload?.['signal'], undefined, 'signal must not be serialized as a boolean');
  assert.equal(sentPayload?.['timeoutMs'], 30_000);
  assert.equal(sentPayload?.['workdir'], '/home/sandbox/workspace');
});

test('R6: 后台输出缓冲有界，保留尾部并置 lossy', async () => {
  const chunk = 'x'.repeat(1_000);
  let statusCalls = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/shell/start')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { payload?: { id?: string } };
      return new Response(JSON.stringify({ ok: true, data: { id: body.payload?.id, status: 'running' } }));
    }
    if (path.endsWith('/jobs/status')) {
      statusCalls += 1;
      // 跑够 60 轮再结算：累计产出 60_000 字符，是 2_000 上限的三十倍。
      const status = statusCalls >= 60 ? 'completed' : 'running';
      return new Response(JSON.stringify({ ok: true, data: { status, exitCode: 0, signal: null } }));
    }
    if (path.endsWith('/jobs/read')) {
      return new Response(JSON.stringify({ ok: true, data: { text: chunk, lossy: false } }));
    }
    return new Response(JSON.stringify({ ok: true, data: {} }));
  }) as unknown as typeof fetch;

  const shell = new RemoteShell(new Context() as unknown as Context, {
    ...BASE,
    fetchImpl,
    monitor: { minDelayMs: 1, maxDelayMs: 2, failureDeadlineMs: 5_000 },
    outputMaxChars: 2_000,
  });
  const proc = shell.start(shell.resolve({ command: 'yes' }));
  await awaitDone(proc.done);

  // 缓冲必须有界——修复前这里会是 60_000 左右。
  const first = proc.readOutput();
  assert.ok(first.delta.length <= 2_000, `buffer must stay bounded, got ${first.delta.length}`);
  assert.equal(first.lossy, true, 'dropping output must be reported as lossy');
  assert.equal(first.delta, 'x'.repeat(first.delta.length), 'retained text must be intact');
  // 读过之后回到基线：没有新数据时增量为空，lossy 也复位。
  const second = proc.readOutput();
  assert.equal(second.delta.length, 0);
  assert.equal(second.lossy, false);
});

test('R6: 输出不超上限时不报 lossy，内容完整', async () => {
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
        JSON.stringify({ ok: true, data: { status: statusCalls >= 2 ? 'completed' : 'running', exitCode: 0 } }),
      );
    }
    if (path.endsWith('/jobs/read')) {
      return new Response(JSON.stringify({ ok: true, data: { text: 'hello', lossy: false } }));
    }
    return new Response(JSON.stringify({ ok: true, data: {} }));
  }) as unknown as typeof fetch;

  const shell = new RemoteShell(new Context() as unknown as Context, {
    ...BASE,
    fetchImpl,
    monitor: { minDelayMs: 1, maxDelayMs: 2, failureDeadlineMs: 5_000 },
    outputMaxChars: 2_000,
  });
  const proc = shell.start(shell.resolve({ command: 'echo hello' }));
  await awaitDone(proc.done);
  const read = proc.readOutput();
  assert.equal(read.lossy, false);
  assert.match(read.delta, /^(hello)+$/);
});
