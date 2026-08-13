/**
 * Simulate a standard A2A 0.3 client (message/send, message/stream, tasks/*)
 * against the Agent HTTP + stream adapter.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createA2aHttpHandler } from '../../src/presentation/a2a/http-handler.js';
import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';
import { A2aStreamService } from '../../src/application/a2a/stream-service.js';
import { buildA2aTaskObject } from '../../src/application/a2a/event-projector.js';
import { A2A_PROTOCOL_VERSION } from '../../src/application/a2a/json-rpc.js';
import {
  assertA2aStreamResult,
  assertOfficialStreamGrammar,
} from '../../src/application/a2a/stream-event-schema.js';
import {
  StandardA2aClient,
  parseOfficialJsonRpcSse,
} from './standard-a2a-client.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN4A';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const TASK = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const CRED = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const ART = '01K0G2PAV8FPMVC9QHJG7JPN5F';
const EVT1 = '01K0G2PAV8FPMVC9QHJG7JPN58';
const EVT2 = '01K0G2PAV8FPMVC9QHJG7JPN59';
const MSG = '01K0G2PAV8FPMVC9QHJG7JPN5A';
const TERM = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const TOKEN = 'good-token';
const TRACE = 'a'.repeat(32);

const JOURNAL = [
  {
    sequence: 1,
    eventId: EVT1,
    event: { type: 'run.accepted', status: 'ACCEPTED' },
    ts: 1,
  },
  {
    sequence: 2,
    eventId: EVT2,
    event: { type: 'run.started', status: 'RUNNING' },
    ts: 2,
  },
  {
    sequence: 3,
    eventId: MSG,
    event: {
      type: 'message.completed',
      role: 'assistant',
      messageId: 'asst-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Analysis complete.' }],
      },
    },
    ts: 3,
  },
  {
    sequence: 4,
    eventId: ART,
    event: {
      type: 'artifact.ready',
      artifactId: ART,
      name: 'out.csv',
      mimeType: 'text/csv',
    },
    ts: 4,
  },
  {
    sequence: 5,
    eventId: TERM,
    event: { type: 'run.succeeded', status: 'SUCCEEDED' },
    ts: 5,
  },
];

function taskSnapshot(runStatus = 'SUCCEEDED') {
  return buildA2aTaskObject({
    a2aTaskId: TASK,
    runStatus,
    contextId: CONV,
  });
}

async function startServer() {
  const principal = {
    orgId: ORG,
    agentId: AGENT,
    serviceUserId: USER,
    clientId: 'client-a',
    credentialId: CRED,
    scopes: ['agent.invoke', 'agent.read', 'agent.cancel', 'artifact.read'],
    callerType: 'a2a',
    callerId: 'client-a',
  };

  const taskService = {
    async sendMessage() {
      return taskSnapshot('ACCEPTED');
    },
    async getTask() {
      return taskSnapshot('SUCCEEDED');
    },
    async cancelTask() {
      return taskSnapshot('CANCELLED');
    },
    async resolveOwnedTask() {
      return {
        a2aTaskId: TASK,
        runId: RUN,
        contextId: CONV,
        clientId: 'client-a',
        orgId: ORG,
        agentId: AGENT,
      };
    },
    runAuthForPrincipal() {
      return { provider: 'a2a', externalOrgId: ORG, externalUserId: 'client-a' };
    },
  };

  const streamService = new A2aStreamService({
    taskService,
    eventQueryService: {
      async listEvents({ afterSequence }) {
        const page = JOURNAL.filter((e) => e.sequence > afterSequence);
        if (page.length === 0) {
          return {
            events: [],
            status: 'SUCCEEDED',
            terminal: afterSequence >= 5,
          };
        }
        return {
          events: page,
          status: page[page.length - 1].event.status || 'RUNNING',
          terminal: false,
        };
      },
    },
    getRunService: {
      async execute() {
        return { runId: RUN, status: 'SUCCEEDED' };
      },
    },
    pollMs: 5,
    heartbeatMs: 60_000,
    mysqlCatchupMs: 1,
    sleep: async () => {},
  });

  const a2aHandler = createA2aHttpHandler({
    credentialService: {
      async authenticate(header, opts) {
        if (!header || !String(header).includes(TOKEN)) {
          const { A2aAuthError } = await import(
            '../../src/application/a2a/credential-service.js'
          );
          throw new A2aAuthError('bad', { code: 'A2A_AUTH_INVALID' });
        }
        if (opts?.agentId && opts.agentId !== AGENT) {
          const { A2aAuthError } = await import(
            '../../src/application/a2a/credential-service.js'
          );
          throw new A2aAuthError('mismatch', { code: 'A2A_AUTH_AGENT_MISMATCH' });
        }
        return principal;
      },
    },
    taskService,
    streamService,
    publicBaseUrl: 'https://agent.example.com',
    deploymentEnv: 'production',
    resolveAgentMeta: async (id) =>
      id === AGENT
        ? { name: 'Enterprise Analysis Agent', description: 'test' }
        : null,
    resolveTraceId: () => TRACE,
    readBody: async (req) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      return Buffer.concat(chunks).toString('utf8');
    },
    json: (res, status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    },
  });

  const server = createAgentHttpServer({
    createRunService: { async execute() { throw new Error('no'); } },
    getRunService: { async execute() { throw new Error('no'); } },
    cancelRunService: { async execute() { throw new Error('no'); } },
    eventQueryService: { async listEvents() { return { events: [] }; } },
    a2aHandler,
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const client = new StandardA2aClient({
    baseUrl: `http://127.0.0.1:${port}`,
    token: TOKEN,
    agentId: AGENT,
  });
  return {
    server,
    client,
    close: () => new Promise((r) => server.close(r)),
  };
}

describe('standard A2A 0.3 client simulator', () => {
  it('parses official JSON-RPC SSE and rejects kind literal drift', () => {
    const ok = parseOfficialJsonRpcSse(
      [
        'data: {"jsonrpc":"2.0","id":1,"result":{"kind":"task","id":"t1","contextId":"c1","status":{"state":"working"}}}',
        '',
        'data: {"jsonrpc":"2.0","id":1,"result":{"kind":"status-update","taskId":"t1","contextId":"c1","status":{"state":"completed"},"final":true}}',
        '',
      ].join('\n'),
    );
    assert.equal(ok[0].kind, 'task');
    assert.equal(ok[1].kind, 'status-update');
    assertOfficialStreamGrammar(ok);

    assert.throws(
      () =>
        parseOfficialJsonRpcSse(
          'data: {"jsonrpc":"2.0","id":1,"result":{"kind":"statusUpdate","taskId":"t1","contextId":"c1","status":{"state":"working"},"final":false}}\n\n',
        ),
      /kind/,
    );
  });

  it('discovers the card and completes send / get / cancel with official methods', async () => {
    const { client, close } = await startServer();
    try {
      const card = await client.getAgentCard();
      assert.equal(card.protocolVersion, A2A_PROTOCOL_VERSION);
      assert.equal(card.preferredTransport, 'JSONRPC');
      assert.match(card.url, /\/a2a\/agents\//);

      const created = await client.sendMessage({
        text: 'Analyze Q2 risk',
        messageId: 'std-send-1',
      });
      assert.equal(created.kind, 'task');
      assert.equal(created.id, TASK);

      const got = await client.getTask(created.id);
      assert.equal(got.kind, 'task');
      assert.equal(got.status.state, 'completed');

      const cancelled = await client.cancelTask(created.id);
      assert.equal(cancelled.kind, 'task');
      assert.equal(cancelled.status.state, 'canceled');
    } finally {
      await close();
    }
  });

  it('message/stream follows official task-lifecycle grammar', async () => {
    const { client, close } = await startServer();
    try {
      const results = await client.sendStreamingMessage({
        text: 'Analyze Q2 risk',
        messageId: 'std-stream-1',
      });

      for (const result of results) assertA2aStreamResult(result);
      assertOfficialStreamGrammar(results);

      assert.equal(results[0].kind, 'task');
      assert.ok(!results.some((r) => r.kind === 'message'));

      const statuses = results.filter((r) => r.kind === 'status-update');
      assert.deepEqual(
        statuses.map((r) => r.status.state),
        ['submitted', 'working', 'working', 'completed'],
      );
      const withText = statuses.find((r) => r.status.message?.parts?.[0]?.text);
      assert.equal(withText.status.message.parts[0].text, 'Analysis complete.');
      assert.equal(withText.status.message.messageId, 'asst-1');
      assert.equal(withText.status.message.role, 'agent');

      assert.ok(results.some((r) => r.kind === 'artifact-update'));
      assert.equal(statuses.at(-1).final, true);
    } finally {
      await close();
    }
  });

  it('tasks/resubscribe is the same official StreamResponse union', async () => {
    const { client, close } = await startServer();
    try {
      const results = await client.resubscribe(TASK);
      assertOfficialStreamGrammar(results);
      assert.equal(results[0].kind, 'task');
      assert.ok(results.some((r) => r.kind === 'status-update' && r.final));
    } finally {
      await close();
    }
  });
});
