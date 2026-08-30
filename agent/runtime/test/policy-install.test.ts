/**
 * 策略装配的**组合断言**。
 *
 * `policy.test.ts` 测的是纯函数，从 Wave 5 起一直是绿的——而那段时间里
 * `installEnterprisePolicy` 还不存在，四个挂载点一个都没接，审批/guard/预算/
 * 脱敏在运行时全部不生效。所以本文件断言的不是"函数行为对不对"，而是
 * **装上去之后监听器真的被调用、拒绝真的拦得住**。
 *
 * 这里用一个最小的 cordis 替身而不是完整 boot：完整 boot 在
 * `boot.test.ts` 的组合断言里已经覆盖（那条跑子进程），这里要的是能精确
 * 驱动四个挂载点的能力。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { installEnterprisePolicy } from '../src/policy/install.js';
import { InMemoryApprovalStore } from '../src/policy/pre-execute.js';
import type { GuardListener } from '../src/policy/guards.js';

type Listener = (...args: unknown[]) => unknown;

/** 够用的 cordis 替身：记录注册，并能按挂载点驱动一次调用。 */
class FakeCtx {
  readonly listeners = new Map<string, Listener[]>();
  readonly guards: Array<(exec: unknown) => string | undefined> = [];
  readonly tools = {
    guard: (g: (exec: unknown) => string | undefined): (() => void) => {
      this.guards.push(g);
      return () => {
        const i = this.guards.indexOf(g);
        if (i >= 0) this.guards.splice(i, 1);
      };
    },
  };

  /**
   * cordis 的 `inject(names, apply)`：apply 拿到一个已注入服务的作用域。
   * 替身必须提供它——真实 ctx 上直接取 `.tools` 会抛 "cannot get property
   * without inject"，替身如果允许直接取，就测不出这个契约。
   */
  inject(_names: readonly string[], apply: (scoped: FakeCtx) => void): () => void {
    apply(this);
    return () => {
      this.guards.length = 0;
    };
  }

  on(event: string, listener: Listener): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return () => {
      const l = this.listeners.get(event) ?? [];
      const i = l.indexOf(listener);
      if (i >= 0) l.splice(i, 1);
    };
  }

  count(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }

  /** 驱动一次 pre-execute，`next` 默认放行。 */
  async pre(exec: object, next = async (): Promise<unknown> => ({ kind: 'allow' })): Promise<unknown> {
    const fn = (this.listeners.get('tools/pre-execute') ?? [])[0];
    assert.ok(fn, 'tools/pre-execute 未注册');
    return await (fn(exec, next) as Promise<unknown>);
  }

  async execute(exec: object, body: () => Promise<unknown>): Promise<unknown> {
    const fn = (this.listeners.get('tools/execute') ?? [])[0];
    assert.ok(fn, 'tools/execute 未注册');
    return await (fn(exec, body) as Promise<unknown>);
  }

  async post(exec: object, result: unknown, next: () => Promise<unknown>): Promise<unknown> {
    const fn = (this.listeners.get('tools/post-execute') ?? [])[0];
    assert.ok(fn, 'tools/post-execute 未注册');
    return await (fn(exec, result, next) as Promise<unknown>);
  }
}

function installOn(ctx: FakeCtx, extra: Partial<Parameters<typeof installEnterprisePolicy>[1]> = {}) {
  return installEnterprisePolicy(ctx as never, {
    approvalStore: new InMemoryApprovalStore(),
    ...extra,
  });
}

test('四个挂载点全部注册——这正是 Wave 5 到 2026-08-30 之间缺的那一步', () => {
  const ctx = new FakeCtx();
  const guards: GuardListener[] = [() => null];
  installOn(ctx, { guards });

  assert.equal(ctx.count('tools/pre-execute'), 1, 'pre-execute 必须注册');
  assert.equal(ctx.count('tools/execute'), 1, 'execute 环绕必须注册');
  assert.equal(ctx.count('tools/post-execute'), 1, 'post-execute 必须注册');
  assert.equal(ctx.guards.length, 1, 'ctx.tools.guard() 必须注册');
});

test('低风险工具放行，且把决定权交回瀑布（不抢别人的拒绝权）', async () => {
  const ctx = new FakeCtx();
  installOn(ctx);
  let nextCalled = false;
  const decision = await ctx.pre({ name: 'read', arguments: { path: 'a.txt' }, id: 'c1' }, async () => {
    nextCalled = true;
    return { kind: 'allow' };
  });
  assert.equal(nextCalled, true, 'allow 时必须 await next()');
  assert.deepEqual(decision, { kind: 'allow' });
});

test('高风险工具停在 ask，并落一条持久 PENDING 审批', async () => {
  const ctx = new FakeCtx();
  const store = new InMemoryApprovalStore();
  installEnterprisePolicy(ctx as never, { approvalStore: store });

  // 按真实风险表选工具：`bash` 是 local_low → allow；`require_approval` 的是
  // `skill_install`（override 到 high）与所有 `mcp__*`（external_high）。
  let nextCalled = false;
  const decision = (await ctx.pre(
    { name: 'skill_install', arguments: { source: 'x.zip' }, id: 'c2' },
    async () => {
      nextCalled = true;
      return { kind: 'allow' };
    },
  )) as { kind: string };

  assert.equal(nextCalled, false, '需要审批时不能把决定权交回瀑布');
  assert.equal(decision.kind, 'ask');

  // 审批必须**落库**，不是只返回一个决定——WAITING_APPROVAL 之后要能恢复。
  assert.equal(store.records.size, 1);
  const [approval] = [...store.records.values()];
  assert.equal(approval?.toolName, 'skill_install');
  assert.equal(approval?.status, 'PENDING');
  assert.equal(approval?.runStatusHint, 'WAITING_APPROVAL');
  // source_digest 必须入账：恢复重放时靠它发现参数被换过。
  assert.match(String(approval?.sourceDigest), /^[0-9a-f]{16,}$/);
});

test('外部 MCP 工具同样需要审批（external_high）', async () => {
  const ctx = new FakeCtx();
  const store = new InMemoryApprovalStore();
  installEnterprisePolicy(ctx as never, { approvalStore: store });
  const decision = (await ctx.pre({ name: 'mcp__db__query', arguments: {}, id: 'c5' })) as {
    kind: string;
  };
  assert.equal(decision.kind, 'ask');
});

test('未知工具 fail-closed 拒绝，不是放行', async () => {
  const ctx = new FakeCtx();
  installOn(ctx);
  const decision = (await ctx.pre({ name: 'totally_unknown_tool', arguments: {}, id: 'c6' })) as {
    kind: string;
  };
  assert.equal(decision.kind, 'deny');
});

test('guard 是单调的：拒绝之后放行的 listener 翻不了案', () => {
  const ctx = new FakeCtx();
  const guards: GuardListener[] = [
    () => ({
      decision: 'deny',
      reason: 'cross-tenant workspace',
      reasonCode: 'TENANT_MISMATCH',
      policyId: 'test',
      riskLevel: 'high',
    }),
    // 后面这个想放行，必须无效。
    () => ({
      decision: 'allow',
      reason: 'looks fine',
      reasonCode: 'OK',
      policyId: 'test',
      riskLevel: 'low',
    }),
  ] as unknown as GuardListener[];
  installOn(ctx, { guards });

  const reason = ctx.guards[0]?.({ name: 'read', arguments: {} });
  assert.equal(typeof reason, 'string', 'guard 必须返回拒绝理由');
  assert.match(String(reason), /cross-tenant/);
});

test('预算在调用工具体之前判定——第 N+1 次调用根本不执行', async () => {
  const ctx = new FakeCtx();
  installOn(ctx, { env: { AGENT_RUN_MAX_TOOL_CALLS: '2' } as NodeJS.ProcessEnv });

  let bodyRuns = 0;
  const body = async (): Promise<string> => {
    bodyRuns += 1;
    return 'ok';
  };
  await ctx.execute({ name: 'read' }, body);
  await ctx.execute({ name: 'read' }, body);
  await assert.rejects(() => ctx.execute({ name: 'read' }, body) as Promise<unknown>, /budget/i);
  assert.equal(bodyRuns, 2, '超预算的那次工具体不该被执行');
});

test('失败结果经脱敏后回给模型，物理根不外泄，并记一条账本', async () => {
  const ctx = new FakeCtx();
  const ledger: unknown[] = [];
  installOn(ctx, {
    physicalRoots: ['/var/sandbox/workspaces/ws_secret'],
    ledger: (e) => ledger.push(e),
  });

  const result = (await ctx.post(
    { name: 'read', id: 'c3' },
    { isError: true, error: new Error('ENOENT: /var/sandbox/workspaces/ws_secret/a.txt') },
    async () => ({ kind: 'accept' }),
  )) as { kind: string; feedback?: { text?: string }[] };

  assert.equal(result.kind, 'block');
  const text = String(result.feedback?.[0]?.text ?? '');
  assert.ok(!text.includes('/var/sandbox/workspaces/ws_secret'), `物理根泄漏了: ${text}`);
  assert.equal(ledger.length, 1);
});

test('成功结果原样通过，账本仍记一条', async () => {
  const ctx = new FakeCtx();
  const ledger: unknown[] = [];
  installOn(ctx, { ledger: (e) => ledger.push(e) });

  const passed = { kind: 'accept', content: [{ type: 'text', text: 'hello' }] };
  const result = await ctx.post({ name: 'read', id: 'c4' }, { isError: false }, async () => passed);
  assert.deepEqual(result, passed);
  assert.equal(ledger.length, 1);
});

test('dispose() 卸载全部监听器与 guard', () => {
  const ctx = new FakeCtx();
  const installed = installOn(ctx, { guards: [() => null] });
  installed.dispose();
  assert.equal(ctx.count('tools/pre-execute'), 0);
  assert.equal(ctx.count('tools/execute'), 0);
  assert.equal(ctx.count('tools/post-execute'), 0);
  assert.equal(ctx.guards.length, 0);
});

test('真实 boot + agents.create()：策略与提示词确实装到 per-Run scope 上', () => {
  // 与上面的替身测试互补：替身证明"四个挂载点的行为对"，这条证明"在真的
  // DSH 上下文里，装配这一步不会被静默跳过"。
  //
  // 它抓到过两个真 bug：服务名是 `systemPrompt`（不是 'system-prompt'），
  // 且必须经 `ctx.inject([...], cb)` 取——直接取属性会抛
  // "cannot get property without inject"，不是静默跳过。
  const probe = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/policy-mount-probe.ts');
  const out = execFileSync('npx', ['tsx', probe], {
    encoding: 'utf8',
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
  });
  const result = JSON.parse(out.trim().split('\n').pop() as string) as {
    sectionRegistered: boolean;
    policyInstalled: boolean;
  };
  assert.equal(result.sectionRegistered, true, '企业提示词段必须注册成功');
  assert.equal(result.policyInstalled, true, '策略必须装配成功');
});
