/**
 * 出站 HiAgent 客户端（docs/design/hiagent-remote-delegation.md §1/H6/H7）对本地假服务端。
 *
 * 字段大小写按官方 SDK 源码断言：请求体 PascalCase（`AppKey/Inputs/UserID`、
 * `AppConversationID/Query/ResponseMode`），阻塞响应小写 snake_case
 * （`task_id/conversation_id/answer`），鉴权头 `Apikey`。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  HiAgentClient,
  HiAgentError,
  isHiAgentSessionInvalid,
} from '../../src/runtime/providers/hiagent-client.js';
import type { HiAgentRemoteAgentEntry } from '../../src/runtime/providers/a2a-remote-registry.js';

const APP_KEY = 'test-hiagent-app-key';

interface Seen {
  action: string;
  body: Record<string, unknown>;
  apikey: string | undefined;
}

interface Fake {
  server: Server;
  base: string;
  seen: Seen[];
  rounds: Map<string, number>;
  convSeq: number;
  /** 让下一次 chat_query_v2 返回会话失效错误（只一次）。 */
  failNextChatOnce: { code: string; message: string } | null;
  delayMs: number;
  largeAnswer: boolean;
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function startFake(): Promise<Fake> {
  const fake: Fake = {
    server: null as unknown as Server,
    base: '',
    seen: [],
    rounds: new Map(),
    convSeq: 0,
    failNextChatOnce: null,
    delayMs: 0,
    largeAnswer: false,
  };
  fake.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const action = new URL(req.url ?? '/', 'http://x').pathname.split('/').pop() ?? '';
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch {
      return send(200, { ResponseMetadata: { Error: { Code: 'BadRequest', Message: 'not json' } } });
    }
    fake.seen.push({ action, body, apikey: req.headers.apikey as string | undefined });
    if (req.headers.apikey !== APP_KEY) return send(401, { unauthorized: true });
    if (req.method === 'POST' && action === 'create_conversation') {
      fake.convSeq += 1;
      const id = `conv-${fake.convSeq}`;
      fake.rounds.set(id, 0);
      return send(200, {
        Conversation: {
          AppConversationID: id,
          ConversationName: '',
          CreateTime: '2026-10-03T00:00:00Z',
          LastChatTime: '2026-10-03T00:00:00Z',
          EmptyConversation: true,
        },
      });
    }
    if (req.method === 'POST' && action === 'chat_query_v2') {
      if (fake.delayMs > 0) await new Promise((r) => setTimeout(r, fake.delayMs));
      const convId = String(body.AppConversationID ?? '');
      if (!fake.rounds.has(convId)) {
        return send(200, {
          ResponseMetadata: {
            RequestId: 'r-1', Action: 'chat_query_v2', Version: 'v1', Service: 'hiagent', Region: 'cn-north-1',
            Error: { Code: 'ConversationNotFound', Message: 'conversation not found or expired' },
          },
        });
      }
      if (fake.failNextChatOnce) {
        const { code, message } = fake.failNextChatOnce;
        fake.failNextChatOnce = null;
        return send(200, {
          ResponseMetadata: {
            RequestId: 'r-2', Action: 'chat_query_v2', Version: 'v1', Service: 'hiagent', Region: 'cn-north-1',
            Error: { Code: code, Message: message },
          },
        });
      }
      const round = (fake.rounds.get(convId) ?? 0) + 1;
      fake.rounds.set(convId, round);
      const query = String(body.Query ?? '');
      const answer = fake.largeAnswer ? 'x'.repeat(4096) : `echo[${round}]: ${query}`;
      return send(200, {
        event: 'message_end',
        task_id: `task-${round}`,
        id: `msg-${round}`,
        conversation_id: convId,
        answer,
        created_at: 1759449600,
      });
    }
    return send(404, {});
  });
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/app/v1`;
  return fake;
}

function entry(fake: Fake, over: Partial<HiAgentRemoteAgentEntry> = {}): HiAgentRemoteAgentEntry {
  return {
    id: 'hi-helper',
    name: '火山助手',
    description: '',
    protocol: 'hiagent',
    baseUrl: fake.base,
    authTokenRef: 'HIAGENT_APP_KEY',
    timeoutMs: 60_000,
    ...over,
  };
}

describe('HiAgentClient', () => {
  let fake: Fake;
  beforeEach(async () => {
    fake = await startFake();
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  function client(over: Record<string, unknown> = {}) {
    return new HiAgentClient({ env: { HIAGENT_APP_KEY: APP_KEY }, ...over });
  }

  it('creates a conversation and chats with PascalCase request fields', async () => {
    const c = client();
    const convId = await c.createConversation({ entry: entry(fake), userId: 'user-1' });
    assert.match(convId, /^conv-/);
    const result = await c.chat({ entry: entry(fake), userId: 'user-1', remoteConversationId: convId, prompt: 'hello' });
    assert.equal(result.text, 'echo[1]: hello');
    assert.equal(result.taskId, 'task-1');

    const create = fake.seen.find((s) => s.action === 'create_conversation')!;
    assert.deepEqual(Object.keys(create.body).sort(), ['AppKey', 'Inputs', 'UserID']);
    assert.equal(create.body.UserID, 'user-1');
    const chat = fake.seen.find((s) => s.action === 'chat_query_v2')!;
    assert.deepEqual(Object.keys(chat.body).sort(), ['AppConversationID', 'AppKey', 'Query', 'ResponseMode', 'UserID']);
    assert.equal(chat.body.ResponseMode, 'blocking');
    assert.equal(chat.body.Query, 'hello');
    // 鉴权走 Apikey 头；AppKey 不进 URL。
    assert.ok(fake.seen.every((s) => s.apikey === APP_KEY));
  });

  it('reads the blocking response lowercase fields and drops think/tool messages', async () => {
    const c = client();
    const convId = await c.createConversation({ entry: entry(fake), userId: 'user-1' });
    const result = await c.chat({ entry: entry(fake), userId: 'user-1', remoteConversationId: convId, prompt: 'q' });
    assert.match(result.text, /^echo\[1\]: q$/);
  });

  it('maps a HiAgent error body to HIAGENT_FAILED with the server code', async () => {
    const c = client();
    await assert.rejects(
      c.chat({ entry: entry(fake), userId: 'user-1', remoteConversationId: 'conv-missing', prompt: 'q' }),
      (err: HiAgentError) =>
        err instanceof HiAgentError && err.code === 'HIAGENT_FAILED' && /ConversationNotFound/.test(err.message),
    );
  });

  it('does not leak the credential into error messages', async () => {
    const c = client();
    await assert.rejects(
      c.chat({ entry: entry(fake), userId: 'user-1', remoteConversationId: 'conv-missing', prompt: 'q' }),
      (err: Error) => {
        assert.equal(err.message.includes(APP_KEY), false);
        return true;
      },
    );
  });

  it('rejects a non-JSON response as unknown shape', async () => {
    const html = new HiAgentClient({
      env: { HIAGENT_APP_KEY: APP_KEY },
      fetchImpl: (async () => new Response('<html>not json</html>', { status: 200 })) as unknown as typeof fetch,
    });
    await assert.rejects(
      html.chat({ entry: entry(fake), userId: 'user-1', remoteConversationId: 'conv-1', prompt: 'q' }),
      (err: HiAgentError) => err.code === 'HIAGENT_UNAVAILABLE' && /non-JSON/.test(err.message),
    );
  });

  it('times out a hanging request', async () => {
    fake.delayMs = 300;
    const c = client();
    const convId = await c.createConversation({ entry: entry(fake), userId: 'user-1' });
    await assert.rejects(
      c.chat({ entry: entry(fake, { timeoutMs: 50 }), userId: 'user-1', remoteConversationId: convId, prompt: 'q' }),
      (err: HiAgentError) => err.code === 'HIAGENT_UNAVAILABLE' && /timed out/.test(err.message),
    );
  });

  it('refuses an oversized response', async () => {
    fake.largeAnswer = true;
    const c = new HiAgentClient({ env: { HIAGENT_APP_KEY: APP_KEY }, maxResponseBytes: 2048 });
    const convId = await c.createConversation({ entry: entry(fake), userId: 'user-1' });
    await assert.rejects(
      c.chat({ entry: entry(fake), userId: 'user-1', remoteConversationId: convId, prompt: 'q' }),
      (err: HiAgentError) => err.code === 'HIAGENT_UNAVAILABLE' && /exceeds/.test(err.message),
    );
  });

  it('fails closed when the credential variable is missing, before any request', async () => {
    const c = new HiAgentClient({ env: {} });
    await assert.rejects(
      c.createConversation({ entry: entry(fake), userId: 'user-1' }),
      (err: HiAgentError) => err.code === 'HIAGENT_UNAVAILABLE' && /HIAGENT_APP_KEY/.test(err.message),
    );
    assert.equal(fake.seen.length, 0);
  });

  it('aborts when the caller cancels', async () => {
    fake.delayMs = 300;
    const c = client();
    const convId = await c.createConversation({ entry: entry(fake), userId: 'user-1' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(
      c.chat({ entry: entry(fake), userId: 'user-1', remoteConversationId: convId, prompt: 'q', signal: controller.signal }),
      HiAgentError,
    );
  });
});

describe('isHiAgentSessionInvalid', () => {
  it('matches conversation-not-found style errors only', () => {
    assert.equal(isHiAgentSessionInvalid(new HiAgentError('HIAGENT_FAILED', 'remote x ConversationNotFound: conversation not found or expired', 'ConversationNotFound')), true);
    assert.equal(isHiAgentSessionInvalid(new HiAgentError('HIAGENT_FAILED', 'remote x InvalidConversation: invalid conversation id', 'InvalidConversation')), true);
    // 会话无关的错误不能触发重建。
    assert.equal(isHiAgentSessionInvalid(new HiAgentError('HIAGENT_FAILED', 'remote x InvalidQuery: query is invalid', 'InvalidQuery')), false);
    assert.equal(isHiAgentSessionInvalid(new HiAgentError('HIAGENT_UNAVAILABLE', 'remote x: timed out')), false);
    assert.equal(isHiAgentSessionInvalid(new Error('boom')), false);
  });
});
