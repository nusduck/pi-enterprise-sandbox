/**
 * H0.3 取证：answerer 返回非 allow 之后，DSH 的 turn 会怎样？
 *
 * ADR 0009 D5 假设的形状是「返回非 allow → 该次工具调用不落地 → **turn 正常结束**
 * → Run 转 WAITING_APPROVAL → 释放 Worker」。本探针用真实插件树 + 确定性假 LLM
 * 把这个假设跑一遍，数 LLM 请求次数：
 *   1 次 → turn 在工具被拒后就结束了（ADR 假设成立）
 *   2 次 → 模型收到错误结果后**继续说话**（ADR 假设不成立，H4 要换形状）
 *
 * 场景 B 试的是替代形状：`tools/execute` around-wrapper 返回一个带
 * `concludesTurn: true` 的**成功**结果（`ToolExecutionSuccess.concludesTurn`，
 * `ToolExecutionFailure` 上是 `never`）。
 */
import { bootEnterpriseRuntime } from '../src/runtime/boot.js';
import { startFakeOpenAIProvider } from '../tests/support/fake-openai-provider.js';

const TOOL = 'probe_tool';

async function scenario(
  label: string,
  install: (ctx: any, late: Array<(agent: any) => void>) => void,
  concludeFromBody = false,
): Promise<{ llmCalls: number; events: string[]; note: string }> {
  const fake: any = await startFakeOpenAIProvider({
    responder: ({ requestIndex }: any) =>
      requestIndex === 0
        ? { toolCalls: [{ id: 'call_probe_1', name: TOOL, arguments: {} }] }
        : 'second-turn-text',
  });
  process.env['LLMIO_BASE_URL'] = fake.baseUrl;
  process.env['LLMIO_API_KEY'] = 'fake';

  const ctx: any = await bootEnterpriseRuntime();
  let bodyRan = 0;
  const off = ctx.tools.register({
    name: TOOL,
    description: 'probe',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: (_a: unknown, v: any) => [{ type: 'text', text: `probe ok=${v?.ok}` }],
    },
    async execute(_args: unknown, exec: any) {
      bodyRan += 1;
      if (concludeFromBody) exec.concludeTurn();
      return { ok: true };
    },
  });
  const late: Array<(a: any) => void> = [];
  install(ctx, late);

  const events: string[] = [];
  const handle: any = await ctx.agents.create({
    sessionId: `probe-${label}-${Date.now()}`,
    meta: { cwd: '/tmp' },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  });
  const agent: any = handle?.agent ?? handle;
  for (const fn of late) fn(agent);
  agent.ctx?.on?.('session/event', (e: any) => events.push(String(e?.type ?? e?.kind ?? '?')));

  process.stderr.write(`[${label}] followup=${typeof agent.followup} whenIdle=${typeof agent.whenIdle}\n`);
  ctx.on('agent/error', (e: any) => process.stderr.write(`[${label}] agent/error: ${String(e?.error?.stack ?? e?.error?.message ?? e?.error).slice(0, 800)}\n`));
  agent.followup({
    id: `probe-msg-${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text: 'call the probe tool' }],
    source: { kind: 'user' },
  });
  if (typeof agent.whenIdle === 'function') await agent.whenIdle();
  else await new Promise((r) => setTimeout(r, 3000));

  const chat = fake.requests.filter((r: any) => String(r.path).includes('chat/completions'));
  const llmCalls = chat.filter((r: any) => Array.isArray(r?.body?.tools) && r.body.tools.length > 0).length;
  process.stderr.write(`[${label}] chat=${chat.length} loop(with tools)=${llmCalls}\n`);
  off();
  await fake.close();
  await ctx.stop?.();
  return { llmCalls, events, note: `tool body ran ${bodyRan}x` };
}

// —— 场景 A：pre-execute 判 ask，answerer 返回 rejected（ADR D5 第 1 步的原样） ——
const a = await scenario('reject', (ctx: any) => {
  ctx.on('tools/pre-execute', async (exec: any, next: any) =>
    exec.name === TOOL ? { kind: 'ask', reason: 'enterprise policy: needs approval' } : next());
  ctx.on('approval/request', async () => 'rejected');
});
console.log(`\n[A] pre-execute=ask + answerer=rejected → LLM 请求 ${a.llmCalls} 次（${a.note}）`);
console.log(`    ${a.llmCalls >= 2 ? '❌ turn 没有结束：模型收到错误结果后继续了 —— ADR D5 第 1 步不成立' : '✅ turn 在被拒后结束'}`);

// —— 场景 B：tools/execute wrapper 返回带 concludesTurn 的成功结果 ——
const b = await scenario('conclude', (ctx: any) => {
  ctx.on('tools/execute', async (exec: any, next: any) => {
    if (exec.name !== TOOL) return next();
    return {
      isError: false,
      value: 'parked',
      content: [{ type: 'text', text: 'Waiting for approval; this run is parked.' }],
      concludesTurn: true,
    };
  });
});
console.log(`\n[B] tools/execute wrapper 返回 success+concludesTurn → LLM 请求 ${b.llmCalls} 次（${b.note}）`);
console.log(`    ${b.llmCalls === 1 ? '✅ 循环停了 —— 这是可用的停泊原语' : '❌ 循环没停'}`);
// —— 场景 C：工具体内调 exec.concludeTurn()（d.ts 记载的正规原语） ——
const c = await scenario('conclude-body', () => {}, true);
console.log(`\n[C] 工具体内 exec.concludeTurn() → 循环 LLM 请求 ${c.llmCalls} 次（${c.note}）`);
console.log(`    ${c.llmCalls === 1 ? '✅ 循环停了 —— 这是可用的停泊原语' : '❌ 循环没停'}`);
// —— 场景 D：answerer 写 PENDING 后由外部 agent.cancel() 中止 turn ——
const d = await scenario('cancel', (ctx: any, late) => {
  let target: any = null;
  late.push((a) => { target = a; });
  ctx.on('tools/pre-execute', async (exec: any, next: any) =>
    exec.name === TOOL ? { kind: 'ask', reason: 'enterprise policy: needs approval' } : next());
  ctx.on('approval/request', async () => {
    // 真实实现在这里写 durable PENDING；探针只负责中止。
    target?.cancel?.({ kind: 'hook', reason: 'WAITING_APPROVAL' });
    return 'rejected';
  });
});
console.log(`\n[D] answerer 返回 rejected + 外部 agent.cancel({kind:'hook'}) → 循环 LLM 请求 ${d.llmCalls} 次（${d.note}）`);
console.log(`    ${d.llmCalls === 1 ? '✅ turn 被中止，Worker 可释放' : '❌ 循环仍继续'}`);
process.exit(0);
