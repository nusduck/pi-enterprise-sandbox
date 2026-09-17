/**
 * `ExecRpcClient` 的「结果未知」分类（2026-09-17，STATUS G2）。
 *
 * 真实 DSH gate 场景 4：命令执行中重启 sandbox，Agent 只拿到 `fetch failed`，
 * 工具记 FAILED，模型把它当普通失败继续——可命令可能已经部分执行。现在对**有副作用**
 * 的路由，请求可能已送达却没拿到响应时，标记当前工具调用结果未知并给出明确提示；
 * 请求根本没送达、调用方主动取消、只读路由仍是普通失败。
 *
 * 全部走注入的 fetch 替身，不连 exec。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecRpcClient } from '../../src/runtime/providers/exec-rpc.js';
import {
  runWithToolExecutionContext,
  toolOutcomeUnknownReason,
  type ToolExecutionContext,
} from '../../src/runtime/providers/tool-execution-context.js';

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

function transportError(code: string): Error {
  // undici 的形状：TypeError('fetch failed') + cause.code。
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

async function callInTool(
  htu: string,
  fetchImpl: typeof fetch,
  opts: { deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<{ error: Error | null; reason: string | undefined }> {
  const client = new ExecRpcClient({ ...BASE, fetchImpl });
  const context: ToolExecutionContext = { callId: 'call-1', toolName: 'bash', args: {} };
  let error: Error | null = null;
  await runWithToolExecutionContext(context, async () => {
    try {
      await client.post(htu, { command: 'x' }, [], opts);
    } catch (err) {
      error = err as Error;
    }
  });
  return { error, reason: toolOutcomeUnknownReason(context) };
}

test('有副作用的路由：连接在请求送达后被重置 → 结果未知，并明确告诉模型别盲目重试', async () => {
  for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']) {
    const { error, reason } = await callInTool(
      '/internal/v1/shell/run',
      (async () => {
        throw transportError(code);
      }) as unknown as typeof fetch,
    );
    assert.ok(error, `${code}: must still throw`);
    assert.equal(reason, code);
    assert.match(error.message, /may or may not have taken effect/);
    assert.match(error.message, /before retrying/);
  }
});

test('每条有副作用的路由都按未知分类', async () => {
  for (const htu of [
    '/internal/v1/shell/run',
    '/internal/v1/shell/start',
    '/internal/v1/fs/write-text',
    '/internal/v1/fs/edit-text',
    '/internal/v1/artifacts/submit',
  ]) {
    const { reason } = await callInTool(htu, (async () => {
      throw transportError('ECONNRESET');
    }) as unknown as typeof fetch);
    assert.equal(reason, 'ECONNRESET', htu);
  }
});

test('传输截止到期（非调用方取消）→ 结果未知', async () => {
  const { error, reason } = await callInTool(
    '/internal/v1/shell/run',
    ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch,
    { deadlineMs: 30 },
  );
  assert.ok(error);
  assert.equal(reason, 'deadline');
});

test('对照：请求没送达（连不上）是普通失败', async () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
    const { error, reason } = await callInTool(
      '/internal/v1/shell/run',
      (async () => {
        throw transportError(code);
      }) as unknown as typeof fetch,
    );
    assert.ok(error, code);
    assert.equal(reason, undefined, code);
  }
});

test('对照：调用方主动取消不算结果未知（取消语义另有断连停止保证）', async () => {
  const caller = new AbortController();
  const pending = callInTool(
    '/internal/v1/shell/run',
    ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch,
    { deadlineMs: 5_000, signal: caller.signal },
  );
  setTimeout(() => caller.abort(), 10);
  const { error, reason } = await pending;
  assert.ok(error);
  assert.equal(reason, undefined);
});

test('对照：只读路由断连是普通失败，重试无副作用', async () => {
  for (const htu of ['/internal/v1/fs/read-text', '/internal/v1/fs/grep', '/internal/v1/jobs/status']) {
    const { error, reason } = await callInTool(htu, (async () => {
      throw transportError('ECONNRESET');
    }) as unknown as typeof fetch);
    assert.ok(error, htu);
    assert.equal(reason, undefined, htu);
  }
});

test('对照：执行面给出了明确的错误响应就不是未知', async () => {
  const { error, reason } = await callInTool(
    '/internal/v1/shell/run',
    (async () =>
      new Response(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
  );
  assert.ok(error);
  assert.equal(reason, undefined);
});

test('不在工具调用内时照常抛错，不崩', async () => {
  const client = new ExecRpcClient({
    ...BASE,
    fetchImpl: (async () => {
      throw transportError('ECONNRESET');
    }) as unknown as typeof fetch,
  });
  await assert.rejects(() => client.post('/internal/v1/shell/run', {}, []));
});
