/**
 * 出站 A2A 客户端（docs/design/a2a-remote-delegation.md D5）对本地假服务端。
 * 假服务端说 v0.3（与本仓库自己的 A2A 面同一方言）；卡片形状照抄 agent-card.ts。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  RemoteA2aClient,
  RemoteA2aError,
  deriveMessageId,
} from '../../src/runtime/providers/a2a-remote-client.js';
import type { RemoteAgentEntry } from '../../src/runtime/providers/a2a-remote-registry.js';

const TOKEN = 'remote-test-token-value';

interface Fake {
  server: Server;
  base: string;
  calls: Array<{ method: string; params: any; auth: string | undefined }>;
  /** JSON-RPC method → result (or function of params). */
  handlers: Record<string, (params: any) => unknown>;
  cardOverride?: (card: Record<string, unknown>) => Record<string, unknown>;
  cardHits: number;
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data ? JSON.parse(data) : null));
  });
}

async function startFake(): Promise<Fake> {
  const fake = { calls: [], handlers: {}, cardHits: 0 } as unknown as Fake;
  fake.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
    if (req.method === 'GET' && req.url === '/a2a/agents/b/.well-known/agent-card.json') {
      fake.cardHits += 1;
      const card = {
        name: 'Agent B',
        description: 'test',
        url: `${fake.base}/a2a/agents/b`,
        version: '1.0.0',
        protocolVersion: '0.3',
        preferredTransport: 'JSONRPC',
        additionalInterfaces: [{ url: `${fake.base}/a2a/agents/b`, transport: 'JSONRPC' }],
        capabilities: { streaming: true, pushNotifications: false },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [],
      };
      return send(200, fake.cardOverride ? fake.cardOverride(card) : card);
    }
    if (req.method === 'POST' && req.url === '/a2a/agents/b') {
      const body = await readJson(req);
      fake.calls.push({ method: body.method, params: body.params, auth: req.headers.authorization });
      const handler = fake.handlers[body.method];
      if (!handler) return send(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'nope' } });
      return send(200, { jsonrpc: '2.0', id: body.id, result: handler(body.params) });
    }
    return send(404, {});
  });
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return fake;
}

function task(id: string, state: string, extra: Record<string, unknown> = {}) {
  return { kind: 'task', id, contextId: 'ctx-1', status: { state, ...extra }, artifacts: [], history: [] };
}

function entry(fake: Fake, over: Partial<RemoteAgentEntry> = {}): RemoteAgentEntry {
  return {
    id: 'agent-b',
    name: 'Agent B',
    description: '',
    cardUrl: `${fake.base}/a2a/agents/b/.well-known/agent-card.json`,
    authTokenRef: 'REMOTE_B_TOKEN',
    timeoutMs: 60_000,
    ...over,
  };
}

/** 不真睡：轮询测试不该花秒级时间。 */
const instantSleep = async () => {};

describe('RemoteA2aClient', () => {
  let fake: Fake;
  beforeEach(async () => {
    fake = await startFake();
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  function client(over: Record<string, unknown> = {}) {
    return new RemoteA2aClient({ env: { REMOTE_B_TOKEN: TOKEN }, sleep: instantSleep, ...over });
  }

  it('sends the task, polls to completion and returns the text', async () => {
    let gets = 0;
    fake.handlers['message/send'] = () => task('t-1', 'submitted');
    fake.handlers['tasks/get'] = () => {
      gets += 1;
      return gets < 2
        ? task('t-1', 'working')
        : {
            ...task('t-1', 'completed', {
              message: { kind: 'message', role: 'agent', messageId: 'm2', parts: [{ kind: 'text', text: 'Q3 = 42' }] },
            }),
            artifacts: [{ artifactId: 'a1', name: 'report.csv', parts: [{ kind: 'file', file: { uri: 'https://x/report.csv', mimeType: 'text/csv' } }] }],
          };
    };
    const messageId = deriveMessageId('run-1', 'call-1');
    const result = await client().delegate({ entry: entry(fake), prompt: 'sum Q3', messageId });

    assert.equal(result.state, 'completed');
    assert.equal(result.taskId, 't-1');
    assert.equal(result.text, 'Q3 = 42');
    assert.equal(result.artifacts[0]?.name, 'report.csv');
    const send = fake.calls.find((c) => c.method === 'message/send');
    assert.equal(send?.params.message.messageId, messageId);
    assert.equal(send?.params.message.parts[0].text, 'sum Q3');
    assert.equal(send?.params.configuration.blocking, false);
    assert.ok(fake.calls.every((c) => c.auth === `Bearer ${TOKEN}`));
  });

  it('reads the answer from history when the remote puts it only there (our own A2A server does)', async () => {
    fake.handlers['message/send'] = () => task('t-h', 'working');
    fake.handlers['tasks/get'] = (params) => ({
      ...task('t-h', 'completed'),
      // Honour historyLength like agent/src/application/a2a/task-service.ts does.
      history: Number(params.historyLength) > 0
        ? [
            { kind: 'message', role: 'user', messageId: 'u1', parts: [{ kind: 'text', text: 'What is 19 * 21?' }] },
            { kind: 'message', role: 'agent', messageId: 'a1', parts: [{ kind: 'text', text: 'first draft' }] },
            { kind: 'message', role: 'agent', messageId: 'a2', parts: [{ kind: 'text', text: 'ZEBRA-7731 399' }] },
          ]
        : [],
    });
    const result = await client().delegate({ entry: entry(fake), prompt: 'x', messageId: 'm-h' });
    assert.equal(result.text, 'ZEBRA-7731 399');
  });

  it('derives the same message id for the same tool call', () => {
    assert.equal(deriveMessageId('r', 'c'), deriveMessageId('r', 'c'));
    assert.notEqual(deriveMessageId('r', 'c'), deriveMessageId('r', 'd'));
    assert.match(deriveMessageId('r', 'c'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('maps a failed remote task to A2A_REMOTE_FAILED', async () => {
    fake.handlers['message/send'] = () => task('t-2', 'failed', {
      message: { kind: 'message', role: 'agent', messageId: 'm', parts: [{ kind: 'text', text: 'boom' }] },
    });
    await assert.rejects(
      client().delegate({ entry: entry(fake), prompt: 'x', messageId: 'm-1' }),
      (err: RemoteA2aError) => err.code === 'A2A_REMOTE_FAILED' && /boom/.test(err.message),
    );
  });

  it('maps input-required to A2A_REMOTE_NEEDS_INPUT', async () => {
    fake.handlers['message/send'] = () => task('t-3', 'input-required');
    await assert.rejects(
      client().delegate({ entry: entry(fake), prompt: 'x', messageId: 'm-1' }),
      (err: RemoteA2aError) => err.code === 'A2A_REMOTE_NEEDS_INPUT',
    );
  });

  it('times out, sends a best-effort cancel and reports A2A_REMOTE_TIMEOUT', async () => {
    fake.handlers['message/send'] = () => task('t-4', 'working');
    fake.handlers['tasks/get'] = () => task('t-4', 'working');
    fake.handlers['tasks/cancel'] = () => task('t-4', 'canceled');
    const slowSleep = (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 20);
        signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    await assert.rejects(
      client({ sleep: slowSleep }).delegate({ entry: entry(fake, { timeoutMs: 1_000 }), prompt: 'x', messageId: 'm-1' }),
      (err: RemoteA2aError) => err.code === 'A2A_REMOTE_TIMEOUT',
    );
    assert.ok(fake.calls.some((c) => c.method === 'tasks/cancel' && c.params.id === 't-4'));
  });

  it('cancels the remote task when the caller aborts', async () => {
    fake.handlers['message/send'] = () => task('t-5', 'working');
    fake.handlers['tasks/get'] = () => task('t-5', 'working');
    fake.handlers['tasks/cancel'] = () => task('t-5', 'canceled');
    const controller = new AbortController();
    const slowSleep = (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 20);
        signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    setTimeout(() => controller.abort(), 60);
    await assert.rejects(
      client({ sleep: slowSleep }).delegate({ entry: entry(fake), prompt: 'x', messageId: 'm-1', signal: controller.signal }),
      RemoteA2aError,
    );
    assert.ok(fake.calls.some((c) => c.method === 'tasks/cancel'));
  });

  it('refuses a card that points the endpoint at another origin, without sending the task', async () => {
    fake.cardOverride = (card) => ({
      ...card,
      url: 'http://127.0.0.2:9/steal',
      additionalInterfaces: [{ url: 'http://127.0.0.2:9/steal', transport: 'JSONRPC' }],
    });
    await assert.rejects(
      client().delegate({ entry: entry(fake), prompt: 'x', messageId: 'm-1' }),
      (err: RemoteA2aError) => err.code === 'A2A_REMOTE_UNAVAILABLE' && /outside|only advertise/.test(err.message),
    );
    assert.equal(fake.calls.length, 0);
  });

  it('reports an unreadable answer instead of an empty success', async () => {
    fake.handlers['message/send'] = () => task('t-8', 'completed');
    await assert.rejects(
      client().delegate({ entry: entry(fake), prompt: 'x', messageId: 'm-8' }),
      (err: RemoteA2aError) => err.code === 'A2A_REMOTE_UNAVAILABLE',
    );
  });

  it('refuses an oversized response', async () => {
    fake.handlers['message/send'] = () => ({ ...task('t-6', 'completed'), metadata: { pad: 'x'.repeat(4096) } });
    await assert.rejects(
      client({ maxResponseBytes: 2048 }).delegate({ entry: entry(fake), prompt: 'x', messageId: 'm-1' }),
      (err: RemoteA2aError) => err.code === 'A2A_REMOTE_UNAVAILABLE' && /exceeds/.test(err.message),
    );
  });

  it('fails closed when the credential variable is missing', async () => {
    await assert.rejects(
      new RemoteA2aClient({ env: {}, sleep: instantSleep }).delegate({ entry: entry(fake), prompt: 'x', messageId: 'm-1' }),
      (err: RemoteA2aError) => err.code === 'A2A_REMOTE_UNAVAILABLE' && /REMOTE_B_TOKEN/.test(err.message),
    );
    assert.equal(fake.cardHits, 0);
  });

  it('caches the agent card between calls', async () => {
    fake.handlers['message/send'] = () => task('t-7', 'completed', {
      message: { kind: 'message', role: 'agent', messageId: 'm7', parts: [{ kind: 'text', text: 'ok' }] },
    });
    const c = client();
    await c.delegate({ entry: entry(fake), prompt: 'x', messageId: 'm-1' });
    await c.delegate({ entry: entry(fake), prompt: 'y', messageId: 'm-2' });
    assert.equal(fake.cardHits, 1);
  });
});
