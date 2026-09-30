/** Real production factory and DSH loop; intercept only the model transport. */
import { bootEnterpriseRuntime } from '../../../src/runtime/index.js';
import * as runtime from '../../../src/runtime/index.js';
import { createDshRuntimeFactory } from '../../../src/infrastructure/dsh/runtime-factory.js';

process.env.LLMIO_API_KEY = 'prompt-assembly-probe';
process.env.MCP_SERVERS_JSON = '[]';
process.env.SANDBOX_INTERNAL_HMAC_KEYRING = JSON.stringify({
  probe: Buffer.alloc(32, 7).toString('base64url'),
});
process.env.SANDBOX_INTERNAL_HMAC_ACTIVE_KID = 'probe';

const ctx = await bootEnterpriseRuntime();
const requests: Array<{ system: string; tools: string[] }> = [];
ctx.on('llm/stream', async function* (options: Record<string, any>) {
  if (options.purpose == null) requests.push({
    system: String(options.system ?? ''),
    tools: (options.tools ?? []).map((tool: { name: string }) => tool.name),
  });
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: 'ok' };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } };
  yield { type: 'finish', reason: 'stop' };
});

const agents: any[] = [];
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
  async createAgent(agentCtx, options) {
    const handle = await agentCtx.agents.create(options);
    agents.push(handle.agent);
    return handle;
  },
});

const persona = 'You are a specialist. Preserve {{customer_name}} literally.';
async function create(id: string, systemPrompt: string, deny: string[] = []) {
  return factory.create({
    model: { id: 'deepseek-v4-flash', provider: 'deepseek-official' },
    agentVersion: {
      agentVersionId: id,
      configJson: { systemPrompt, toolPolicy: { tools: Object.fromEntries(deny.map((name) => [name, 'deny'])) } },
    },
    systemPrompt,
    cwd: '/home/sandbox/workspace',
    physicalRoots: ['/var/sandbox/workspaces/probe'],
    agentSession: { agentSessionId: id },
    context: { orgId: 'probe-org', userId: 'probe-user', workspaceId: id },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, data: {} })),
  });
}

const full = await create('prompt-full', '');
await full.session.prompt('Create a file deliverable.');
const restricted = await create('prompt-restricted', persona,
  ['write', 'edit', 'bash', 'job_output', 'job_kill', 'submit_artifact']);
await restricted.session.prompt('Read the project.');
await full.session.prompt('Check that the other scope did not change mine.');

// Visibility changes inside the same session must affect the next request,
// and disposing the restriction must restore its guidance as well as schemas.
const tools = agents[0].ctx.get('tools');
const restore = tools.restrict({ allow: ['read'] });
await full.session.prompt('Read only.');
restore();
await full.session.prompt('Create a file again.');
const restoreEmpty = tools.restrict({ allow: [] });
await full.session.prompt('Answer without tools.');
restoreEmpty();
const restoreWithoutRead = tools.restrict({ allow: ['write', 'edit'] });
await full.session.prompt('Check tool guidance dependencies.');
restoreWithoutRead();
const restoreWithoutEdit = tools.restrict({ allow: ['read', 'write'] });
await full.session.prompt('Check that write guidance cannot recommend hidden edit.');
restoreWithoutEdit();

await restricted.dispose();
await full.dispose();
console.log(JSON.stringify({ requests, persona }));
process.exit(0);
