import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';
import { buildAgentCard } from '../../src/application/a2a/agent-card.js';
import { createA2aHttpHandler } from '../../src/presentation/a2a/http-handler.js';

const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN4A';
const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CRED = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const TASK = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const TRACE = 'a'.repeat(32);

describe('root A2A Agent Card gateway', () => {
  it('refuses missing identities and non-origin-relative RPC paths', () => {
    assert.throws(
      () => buildAgentCard({ baseUrl: 'https://agent.example.com' }),
      /agentId or rpcPath/,
    );
    assert.throws(
      () => buildAgentCard({
        baseUrl: 'https://agent.example.com',
        rpcPath: '//evil.example.com/a2a',
      }),
      /origin-relative/,
    );
  });

  it('advertises a callable credential-routed endpoint instead of a phantom default Agent', async () => {
    const calls = [];
    const a2aHandler = createA2aHttpHandler({
      credentialService: {
        async authenticate(header, options) {
          calls.push(['authenticate', header, options]);
          return {
            orgId: ORG,
            agentId: AGENT,
            serviceUserId: USER,
            clientId: 'root-card-client',
            credentialId: CRED,
            scopes: ['agent.read'],
          };
        },
      },
      taskService: {
        async sendMessage() {
          throw new Error('not used');
        },
        async getTask(input) {
          calls.push(['getTask', input]);
          return {
            kind: 'task',
            id: TASK,
            status: { state: 'working' },
          };
        },
        async cancelTask() {
          throw new Error('not used');
        },
      },
      streamService: { async openTaskStream() {} },
      publicBaseUrl: 'https://agent.example.com',
      deploymentEnv: 'production',
      resolveTraceId: () => TRACE,
      readBody: async (req) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf8');
      },
      json: (res, status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      },
    });
    const server = createAgentHttpServer({
      createRunService: { async execute() {} },
      getRunService: { async execute() {} },
      cancelRunService: { async execute() {} },
      eventQueryService: { async listEvents() { return { events: [] }; } },
      a2aHandler,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const cardResponse = await fetch(
        `http://127.0.0.1:${port}/.well-known/agent-card.json`,
      );
      assert.equal(cardResponse.status, 200);
      const card = await cardResponse.json();
      assert.equal(card.url, 'https://agent.example.com/a2a');
      assert.equal(card.url.includes('/default'), false);

      const rpcResponse = await fetch(`http://127.0.0.1:${port}/a2a`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer root-card-token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'GetTask',
          params: { id: TASK },
        }),
      });
      assert.equal(rpcResponse.status, 200);
      const rpc = await rpcResponse.json();
      assert.equal(rpc.result.id, TASK);
      assert.equal(calls[0][2].agentId, null);
      assert.equal(calls[1][1].agentId, AGENT);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
