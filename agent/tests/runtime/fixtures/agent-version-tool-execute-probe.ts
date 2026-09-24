/**
 * Real DSH scope probe for AV-01/02. No model request is made: the registered
 * harmless MCP tool is invoked through the actual tools.execute seam.
 */
import {
  bootEnterpriseRuntime,
  InMemoryApprovalStore,
} from '../../../src/runtime/index.js';
import * as runtime from '../../../src/runtime/index.js';
import { createDshRuntimeFactory } from '../../../src/infrastructure/dsh/runtime-factory.js';
import { buildRunPolicyResolver } from '../../../src/application/tool-risk-resolver.js';

process.env.LLMIO_API_KEY = 'agent-version-runtime-probe';
process.env.MCP_SERVERS_JSON = '[]';
process.env.SANDBOX_INTERNAL_HMAC_KEYRING = JSON.stringify({
  probe: Buffer.alloc(32, 7).toString('base64url'),
});
process.env.SANDBOX_INTERNAL_HMAC_ACTIVE_KID = 'probe';

const ctx = await bootEnterpriseRuntime();
let bodyCalls = 0;

class AutoApproveStore extends InMemoryApprovalStore {
  override async persistPending(
    record: Parameters<InMemoryApprovalStore['persistPending']>[0],
  ) {
    await super.persistPending({ ...record, status: 'APPROVED' });
  }
}

await ctx.inject(['tools'], (scoped) => {
  scoped.tools.register({
    name: 'mcp__probe__echo',
    description: 'Harmless in-process fixture',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      bodyCalls += 1;
      return 'fixture';
    },
  });
});

let createdAgent: any;
const factory = createDshRuntimeFactory({
  bootRuntime: async () => ctx,
  loadRuntime: async () => ({
    ...runtime,
    mountSessionPersistence: () => ({
      bindOwner: () => () => undefined,
      has: async () => false,
      runAsOwner: (_owner, fn) => fn(),
    }),
  }),
  async createAgent(agentCtx, options) {
    const handle = await agentCtx.agents.create(options);
    createdAgent = handle.agent;
    return handle;
  },
});

const agentVersion = {
  agentVersionId: 'version-probe-1',
  configJson: {
    toolPolicy: { tools: { todo_write: 'deny' } },
    mcpServers: [{ serverId: 'probe', enabledTools: ['echo'] }],
  },
};

// A deliberate platform classification of this exact MCP call as low risk.
// Without it the external-high default asks for approval, and the ask parks
// the scope — a park rejection would look like the authorization rule working
// when it never ran. It also proves the tenant cannot be the only reason a
// call is allowed: the platform decision is still resolved independently.
const platformPolicy = { tools: { 'mcp__probe__echo': 'low' } };
const runPolicyResolver = buildRunPolicyResolver(platformPolicy, agentVersion);

const handle = await factory.create({
  model: { id: 'deepseek-v4-flash', provider: 'deepseek-official' },
  agentVersion,
  policyResolver: (toolName: string) => runPolicyResolver(toolName),
  systemPrompt: 'probe',
  cwd: '/home/sandbox/workspace',
  physicalRoots: ['/var/sandbox/workspaces/probe'],
  agentSession: { agentSessionId: 'session-probe-1' },
  context: {
    orgId: 'probe-org',
    userId: 'probe-user',
    workspaceId: 'probe-workspace',
  },
  fetchImpl: async () => new Response(JSON.stringify({ ok: true, data: {} })),
  approvalStore: new AutoApproveStore(),
});

const agent = createdAgent;
const tools = agent?.ctx?.get?.('tools') ?? ctx.get('tools');
const invoke = async (name: string, callId: string, args: Record<string, unknown>) => {
  try {
    return await tools.execute({
      name,
      callId,
      arguments: args,
      agent,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    return { threw: String(error), isError: true };
  }
};

const denied = await invoke('todo_write', 'probe-denied', { todos: [] });
const selected = await invoke('mcp__probe__echo', 'probe-selected', {});
const unbound = await invoke('mcp__probe__echo_other', 'probe-unbound', {});
console.log(JSON.stringify({
  bodyCalls,
  denied,
  selected,
  unbound,
  scopedToolCount: typeof tools?.schemas === 'function' ? tools.schemas().length : null,
}));
await handle.dispose();
process.exit(0);
