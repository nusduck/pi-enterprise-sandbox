/**
 * ADR 0009 D3 / 计划 H3：并发 Run 的租户隔离。
 *
 * ADR D3 的原文约束：
 *
 * > 并发 Run **不得**靠「`rebind` 根 ctx 上的同一份 provider」——那会串台。
 *
 * 2026-08-31 起栈复核发现**代码里已经是那个写法**：`runtime-factory.ts` 的
 * `ensureCtx` 是全进程 `bootOnce`，`createRemoteProviders()` 在 provider 已挂载时
 * 返回**同一份实例**，然后每个 Run 对它调 `rebind(rpc)`。所以这不是「补断言」，
 * 是修缺陷。
 *
 * ## 缺陷的实际范围（别写宽了）
 *
 * 租户身份（`orgId`/`userId`/`workspaceId`/`fenceToken`）**是安全的**：
 * `ExecRpcClient.envelope()` 走 `currentExecRpc()`，ALS 优先于构造值。
 *
 * 真正被 `rebind` 改坏的是 **`physicalRoots`**：它不走 ALS，是 provider 上的字段，
 * 而它是**每 Run 不同的**（`buildExecRpcConfig` 取 `input.physicalRoots ?? [input.cwd]`，
 * cwd 就是该租户的工作区）。这份根用于**路径脱敏**——后一个 Run 的 rebind 会把前一个
 * Run 的脱敏根换掉，于是 A 的物理路径按 B 的根脱敏 = A 的真实路径泄漏出去。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { RemoteFileSystem } from '../../src/runtime/providers/remote-fs.js';
import { runWithExecRpc } from '../../src/runtime/providers/exec-rpc.js';
import type { ExecRpcConfig } from '../../src/runtime/providers/exec-rpc.js';

const KEYRING = '{"k1":"a2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2s"}';

function cfgFor(tenant: string, root: string): ExecRpcConfig {
  return {
    baseUrl: 'http://exec',
    keyring: KEYRING,
    activeKid: 'k1',
    orgId: `org-${tenant}`,
    userId: `user-${tenant}`,
    workspaceId: `ws-${tenant}`,
    fenceToken: 1,
    physicalRoots: [root],
  } as ExecRpcConfig;
}

/**
 * 一个把每次请求的 envelope 记下来的假 exec。
 *
 * `throwPath` 让它抛一个**未分类**错误（网络层的形状），消息里带物理路径——
 * 这正是 `ExecRpcClient.post()` 里唯一会用 `physicalRoots` 做脱敏的那条分支：
 * 从线上回来的 `FsError` / `ContractError` 原样透传（脱敏是 exec 侧的责任），
 * 只有网络 / 超时 / 非 JSON 这类才在 agent 侧按 `physicalRoots` 抹。
 */
function recorder(throwPath?: string) {
  const seen: Array<{ envelope: Record<string, unknown>; body: string }> = [];
  const fetchImpl = (async (_url: string, init: any) => {
    const body = String(init?.body ?? '');
    seen.push({ envelope: JSON.parse(body).envelope, body });
    if (throwPath !== undefined) {
      throw new Error(`connect ECONNREFUSED while reading ${throwPath}`);
    }
    return new Response(
      JSON.stringify({ ok: false, error: { code: 'FS_NOT_FOUND', message: 'missing' } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

test('H3.0 并发两个租户的 Run 共用一份 provider 时，各自的租户身份不串台', async () => {
  const ctx = new Context();
  const rec = recorder();
  // 生产里 provider 是**共享单例**（bootOnce 的根 ctx），这里照样只建一份。
  const fs = new RemoteFileSystem(ctx, { ...cfgFor('a', '/var/w/a'), fetchImpl: rec.fetchImpl });

  await Promise.all([
    runWithExecRpc({ ...cfgFor('a', '/var/w/a'), fetchImpl: rec.fetchImpl }, async () => {
      await fs.resolve('x.txt').catch(() => undefined);
    }),
    runWithExecRpc({ ...cfgFor('b', '/var/w/b'), fetchImpl: rec.fetchImpl }, async () => {
      await fs.resolve('y.txt').catch(() => undefined);
    }),
  ]);

  assert.equal(rec.seen.length, 2);
  const byOrg = new Map(rec.seen.map((s) => [String(s.envelope['orgId']), s.envelope]));
  assert.equal(byOrg.size, 2, '两个 Run 必须发出两个不同租户的信封，不能都是同一个');
  assert.equal(byOrg.get('org-a')?.['userId'], 'user-a');
  assert.equal(byOrg.get('org-a')?.['workspaceId'], 'ws-a');
  assert.equal(byOrg.get('org-b')?.['userId'], 'user-b');
  assert.equal(byOrg.get('org-b')?.['workspaceId'], 'ws-b');
});

test('H3.0 脱敏根按 Run 取，不被另一个 Run 的 rebind 换掉', async () => {
  const ctx = new Context();
  const rec = recorder('/var/w/a/secret.txt');
  // 复现 runtime-factory.ts 的生产序列：根 ctx 是全进程 bootOnce，
  // provider 是共享单例，每个 Run 进来都对它 rebind 一次。
  const fs = new RemoteFileSystem(ctx, { ...cfgFor('a', '/var/w/a'), fetchImpl: rec.fetchImpl });

  const runA = { ...cfgFor('a', '/var/w/a'), fetchImpl: rec.fetchImpl };
  const runB = { ...cfgFor('b', '/var/w/b'), fetchImpl: rec.fetchImpl };

  fs.rebind(runA); // Run A 开始
  fs.rebind(runB); // Run B 并发进来，把同一份实例改成了 B 的根

  // A 仍在自己的 ALS 作用域里跑，读自己工作区的文件时 exec 回一个带物理路径的错误。
  let aMessage = '';
  await runWithExecRpc(runA, async () => {
    try {
      await fs.readText({ displayPath: '/var/w/a/secret.txt' } as never);
    } catch (err) {
      aMessage = String((err as Error).message);
    }
  });

  assert.equal(
    aMessage.includes('/var/w/a'),
    false,
    'A 的物理根必须被脱敏掉。B 的 rebind 把脱敏根换成了 /var/w/b 之后，' +
      'A 的真实路径就原样漏出去了——这正是 ADR 0009 D3 禁止 rebind 共享 provider 的原因。',
  );
});

test('H3.2 生产装配路径上不再对共享 provider 调 rebind', async () => {
  // 断言的是**源码事实**：租户上下文只经 ALS 传递，没有第二条可变通路。
  // 用例而不是 code review 来守这条，是因为它无声：加回一行 rebind 不会让任何
  // 别的用例变红，但会让并发 Run 的脱敏根互相覆盖。
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const raw = readFileSync(
    fileURLToPath(new URL('../../src/infrastructure/dsh/runtime-factory.ts', import.meta.url)),
    'utf8',
  );
  // 剥掉注释：那段解释「以前为什么错」的文字本身会提到 rebind，不该把它算成调用。
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal(
    /\brebind\s*\(/.test(src),
    false,
    'runtime-factory 不得对共享 provider 调 rebind（ADR 0009 D3）：' +
      'ensureCtx 是全进程 bootOnce，那份 provider 是所有 Run 共用的。',
  );
});
