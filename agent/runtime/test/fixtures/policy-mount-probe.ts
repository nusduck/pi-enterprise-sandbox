/**
 * 真实 boot + 真实 agents.create()，验证 per-Run scope 上确实装了策略。
 *
 * 与 policy-install.test.ts 的区别：那份用 cordis 替身精确驱动四个挂载点；
 * 这份证明"在真的 DSH 上下文里，装配这一步不会被静默跳过"。两者缺一不可——
 * 2026-08-30 之前 policy/ 的纯函数测试全绿，而装配根本不存在。
 */
import { bootEnterpriseRuntime, installEnterprisePolicy, InMemoryApprovalStore } from '../../src/index.js';

process.env['LLMIO_API_KEY'] ??= 'policy-probe-key';
process.env['SANDBOX_INTERNAL_HMAC_KEYRING'] ??=
  '{"k1":"a2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2s"}';
process.env['SANDBOX_INTERNAL_HMAC_ACTIVE_KID'] ??= 'k1';
process.env['SANDBOX_BASE_URL'] ??= 'http://sandbox:8081';

const ctx = await bootEnterpriseRuntime();
const anyCtx = ctx as unknown as {
  agents: { create(o: unknown): Promise<unknown> };
  'system-prompt'?: unknown;
};

let sectionRegistered = false;
let policyInstalled = false;

const handle = (await anyCtx.agents.create({
  sessionId: 'policy-probe-session',
  meta: { cwd: '/home/sandbox/workspace' },
  agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  setup(agentCtx: {
    inject(n: readonly string[], cb: (s: Record<string, { section(x: unknown): () => void }>) => void): () => void;
  }) {
    agentCtx.inject(['systemPrompt'], (scoped) => {
      scoped['systemPrompt']?.section({ name: 'probe-enterprise-contract', order: -50, text: 'probe' });
      sectionRegistered = true;
    });
    installEnterprisePolicy(agentCtx as never, {
      approvalStore: new InMemoryApprovalStore(),
      guards: [() => null],
    });
    policyInstalled = true;
    return { commit() {} };
  },
})) as { agent?: { ctx?: unknown } };

process.stdout.write(`${JSON.stringify({ sectionRegistered, policyInstalled })}\n`);
process.exit(0);
