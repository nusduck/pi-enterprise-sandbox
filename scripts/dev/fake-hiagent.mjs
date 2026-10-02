#!/usr/bin/env node
/**
 * 开发 / 真实链路验证用的假 HiAgent 应用 API 服务端
 * （docs/design/hiagent-remote-delegation.md §5：compose 中以假 HiAgent 容器接入
 * agent 网络，登记一个 hiagent 远端，跑两轮委派确认续聊）。
 *
 * 单文件、无依赖（只有 node:http）。实现阻塞模式的两个动作：
 * - `POST /create_conversation`（body `{ AppKey, Inputs, UserID }`）→
 *   `{ Conversation: { AppConversationID, ... } }`；
 * - `POST /chat_query_v2`（body `{ AppKey, AppConversationID, Query,
 *   ResponseMode: "blocking", UserID }`）→ 阻塞响应
 *   `{ event, task_id, id, conversation_id, answer, created_at }`，
 *   `answer` 回显收到的 `Query` 与该会话的轮次（`echo[<round>]: <Query>`）。
 *
 * 两种用法：
 * - 开发联调：`node scripts/dev/fake-hiagent.mjs --port 8787 --key dev-key`
 * - 测试 / smoke：`import { startFakeHiAgent } from '.../fake-hiagent.mjs'`，端口传 0。
 *
 * 配置（CLI 优先于环境变量）：
 *   --port N / PORT            监听端口，默认 8787
 *   --host H / HOST            监听地址，默认 127.0.0.1
 *   --key K / HIAGENT_FAKE_KEY  期望的 `Apikey` 头，默认 `dev-hiagent-key`
 *
 * 未知 AppConversationID 的 chat 返回会话不存在错误体
 * （`ResponseMetadata.Error = { Code: ConversationNotFound, ... }`），正好用来
 * 验证客户端的「删绑定 → 新建 → 只重试一次」路径。
 *
 * **生产拒绝运行**：`DEPLOYMENT_ENV=production` 直接退出。这里没有任何真实凭据。
 */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_KEY = 'dev-hiagent-key';
const MAX_BODY_BYTES = 1024 * 1024;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = '';
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

function errorBody(action, code, message) {
  return {
    ResponseMetadata: {
      RequestId: `fake-${Date.now()}`,
      Action: action,
      Version: 'v1',
      Service: 'hiagent',
      Region: 'fake',
      Error: { Code: code, Message: message },
    },
  };
}

/** 起一台假 HiAgent。返回 `{ url, close, state }`（state 可查建了几个会话）。 */
export async function startFakeHiAgent({ port = 0, host = '127.0.0.1', appKey = DEFAULT_KEY } = {}) {
  let seq = 0;
  const rounds = new Map();
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // action 取路径最后一段：baseUrl 可能自带前缀（如 /app/v1），不能全路径比对。
    const action = new URL(req.url ?? '/', 'http://fake').pathname.split('/').pop() ?? '';
    if (req.method !== 'POST' || (action !== 'create_conversation' && action !== 'chat_query_v2')) {
      return send(404, { error: 'unknown action (want POST /create_conversation or /chat_query_v2)' });
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return send(200, errorBody(action, 'BadRequest', String(err.message || err)));
    }
    if (req.headers.apikey !== appKey) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized: bad Apikey header' }));
    }
    if (action === 'create_conversation') {
      seq += 1;
      const id = `fake-conv-${seq}`;
      rounds.set(id, 0);
      return send(200, {
        Conversation: {
          AppConversationID: id,
          ConversationName: '',
          CreateTime: new Date().toISOString(),
          LastChatTime: new Date().toISOString(),
          EmptyConversation: true,
        },
      });
    }
    const convId = String(body.AppConversationID ?? '');
    if (!rounds.has(convId)) {
      return send(200, errorBody(action, 'ConversationNotFound', 'conversation not found or expired'));
    }
    const round = (rounds.get(convId) ?? 0) + 1;
    rounds.set(convId, round);
    const query = String(body.Query ?? '');
    // 只回显轮次与原文，不记任何别的东西；日志里同样不打 AppKey。
    console.log(`[fake-hiagent] chat ${convId} round=${round} queryChars=${query.length}`);
    return send(200, {
      event: 'message_end',
      task_id: `fake-task-${round}`,
      id: `fake-msg-${round}`,
      conversation_id: convId,
      answer: `echo[${round}]: ${query}`,
      created_at: Math.floor(Date.now() / 1000),
    });
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  console.log(`[fake-hiagent] listening on ${host}:${actual}`);
  return {
    url: `http://${host}:${actual}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    state: { rounds },
  };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  if (String(process.env.DEPLOYMENT_ENV ?? '').toLowerCase() === 'production') {
    console.error('[fake-hiagent] refuses to run with DEPLOYMENT_ENV=production');
    process.exit(1);
  }
  const port = Number(arg('port', process.env.PORT ?? DEFAULT_PORT));
  const host = String(arg('host', process.env.HOST ?? DEFAULT_HOST));
  const appKey = String(arg('key', process.env.HIAGENT_FAKE_KEY ?? DEFAULT_KEY));
  await startFakeHiAgent({ port, host, appKey });
}
