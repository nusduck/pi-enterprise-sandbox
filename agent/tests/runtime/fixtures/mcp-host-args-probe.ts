/**
 * 宿主参数端到端探针（docs/design/mcp-per-agent-arguments.md §8）。
 *
 * 真实插件树 + 真实 stdio MCP Server（`mcp-host-args-server.mjs`），经
 * `createDshRuntimeFactory` 建 Run——影子定义由产品代码按 AgentVersion 的
 * `toolArguments` 与 `MCP_SERVERS_JSON[].hostArguments` 装配，探针只负责驱动与观测：
 * - 模型最终请求（`llm/stream` 截获）里的工具 schema；
 * - 经 `tools.execute`（与 DSH 调度同一条 scope 解析）调用后 Server 回显的参数；
 * - 工具账本 `started` 收到的参数。
 */
import { bootEnterpriseRuntime, InMemoryApprovalStore } from '../../../src/runtime/index.js';
import * as runtime from '../../../src/runtime/index.js';
import { createDshRuntimeFactory } from '../../../src/infrastructure/dsh/runtime-factory.js';

const ASK = 'mcp__qa__ask';
const PING = 'mcp__qa__ping';
const ctx: any = await bootEnterpriseRuntime();
const root: any = ctx.get('tools');

/** Approves on persist and keeps what the approver would have been shown. */
class AutoApprove extends InMemoryApprovalStore {
  readonly shown: Array<{ toolName: string; args: unknown }> = [];
  override async persistPending(record: any) {
    this.shown.push({ toolName: record.toolName, args: JSON.parse(record.argsCanonical) });
    await super.persistPending({ ...record, status: 'APPROVED' });
  }
}

const wire: unknown[] = [];
ctx.on('llm/stream', async function* (options: any) {
  if (options.purpose == null) {
    const schemaOf = (name: string) => {
      const tool = (options.tools ?? []).find((t: any) => t.name === name);
      return tool ? Object.keys((tool.parameters ?? tool.inputSchema ?? {}).properties ?? {}) : null;
    };
    wire.push({ ask: schemaOf(ASK), ping: schemaOf(PING) });
  }
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: 'ok' };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } };
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
  yield { type: 'finish', reason: 'stop' };
});

const created: any[] = [];
const factory = createDshRuntimeFactory({
  bootRuntime: async () => ctx,
  loadRuntime: async () => ({
    ...runtime,
    mountSessionPersistence: () => ({
      bindOwner: () => () => undefined,
      has: async () => false,
      runAsOwner: (_owner: unknown, fn: () => unknown) => fn(),
    }),
  }),
  async createAgent(agentCtx: any, options: any) {
    const handle = await agentCtx.agents.create(options);
    created.push(handle.agent);
    return handle;
  },
});

async function run(
  id: string,
  toolArguments: Record<string, unknown> | undefined,
  decision: 'allow' | 'require_approval' = 'allow',
) {
  const ledger: Array<{ toolName: string; args: unknown }> = [];
  const approvals = new AutoApprove();
  const handle = await factory.create({
    model: { id: 'deepseek-v4-flash', provider: 'deepseek-official' },
    agentVersion: {
      agentVersionId: `host-args-${id}`,
      configJson: {
        schemaVersion: 1,
        mcpServers: [{
          serverId: 'qa',
          enabledTools: ['ask', 'ping'],
          ...(toolArguments ? { toolArguments } : {}),
        }],
      },
    },
    // `allow` isolates the host-argument layer from approval; `require_approval`
    // proves the approver sees (and the digest binds) the merged arguments.
    policyResolver: () => ({ decision, reason: 'probe', reasonCode: 'PROBE', policyId: 'probe', riskLevel: decision === 'allow' ? 'low' : 'high' }),
    systemPrompt: `probe-${id}`,
    cwd: '/home/sandbox/workspace',
    physicalRoots: [],
    agentSession: { agentSessionId: `host-args-session-${id}` },
    context: { orgId: 'probe-org', userId: 'probe-user', workspaceId: 'probe-ws' },
    fetchImpl: async () => new Response('{}'),
    approvalStore: approvals,
    toolLedger: {
      async started(entry: { toolName: string; args: unknown }) { ledger.push({ toolName: entry.toolName, args: entry.args }); },
      async ended() {},
    },
  } as any);
  const agent = created.at(-1);
  const tools = agent.ctx.get('tools');
  const invoke = async (name: string, callId: string, args: Record<string, unknown>) => {
    try {
      const result = await tools.execute({ name, callId, arguments: args, agent, signal: AbortSignal.timeout(10_000) });
      return { isError: result?.isError === true, text: JSON.stringify(result?.content ?? result) };
    } catch (error) {
      return { isError: true, text: `THREW ${String(error)}` };
    }
  };
  const prompt = async () => {
    await handle.session.prompt('hi');
    return wire.at(-1);
  };
  return { handle, invoke, prompt, ledger, approvals };
}

const a = await run('a', { kb_id: 'hr' });
const b = await run('b', { kb_id: 'finance' });
const c = await run('c', undefined);
const d = await run('d', { kb_id: 'legal' }, 'require_approval');

const out: Record<string, unknown> = {};
out.globalAskProps = Object.keys(root.get(ASK)?.parameters?.properties ?? {});
out.wireA = await a.prompt();
out.wireB = await b.prompt();
out.wireC = await c.prompt();
const [ra, rb] = await Promise.all([
  a.invoke(ASK, 'a-1', { question: 'q-a' }),
  b.invoke(ASK, 'b-1', { question: 'q-b' }),
]);
out.callA = ra;
out.callB = rb;
out.callAOverride = await a.invoke(ASK, 'a-2', { question: 'q-a2', kb_id: 'finance' });
out.callCHidden = await c.invoke(ASK, 'c-1', { question: 'q-c', kb_id: 'finance' });
out.callCPing = await c.invoke(PING, 'c-2', {});
await d.invoke(ASK, 'd-1', { question: 'q-d', kb_id: 'hr' });
out.approvalShownD = d.approvals.shown;
out.ledgerA = a.ledger;
out.ledgerC = c.ledger;

// Reconnect: the shadow resolves the global definition at call time.
const before = root.get(ASK);
out.callCrash = await a.invoke(ASK, 'a-crash', { question: '__crash__' });
let after = root.get(ASK);
for (let i = 0; i < 60 && (after === undefined || after === before); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  after = root.get(ASK);
}
out.reconnected = after !== undefined && after !== before;
out.callAfterReconnect = await a.invoke(ASK, 'a-3', { question: 'q-after' });

await a.handle.dispose();
await b.handle.dispose();
await c.handle.dispose();
await d.handle.dispose();
out.globalAskPropsAfter = Object.keys(root.get(ASK)?.parameters?.properties ?? {});
console.log(`RESULT ${JSON.stringify(out)}`);
process.exit(0);
