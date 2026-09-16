/**
 * Node IncomingMessage → Web Request → Hono fetch → Node response.
 * Node 22 has global Request/Response; Hono 4 speaks fetch.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';

/**
 * 由本监听器注入的对端地址头。**先剥后写**——客户端自己带的同名头一律丢弃。
 * 这是应用层唯一可信的来源：本文件把 `IncomingMessage` 转成 `Request` 时
 * socket 就丢了，Hono 那边再也拿不到真实对端，`getClientIp` 以前只能去猜
 * `X-Forwarded-For`（谁都能伪造），取不到还兜底成 `127.0.0.1`。
 */
export const PEER_IP_HEADER = 'x-exec-peer-ip';

/**
 * 客户端提前断开 → `AbortSignal`。
 *
 * **必须监听 `res` 的 `'close'` 而不是 `req` 的**：`IncomingMessage` 在请求体
 * 正常读完之后也会触发 `'close'`，拿它当取消信号会把每一个正常请求都判成
 * 取消。`ServerResponse` 的 `'close'` 只在响应结束或连接断掉时触发，用
 * `writableFinished` 就能把两者分开——响应已经写完是正常收尾，没写完就是
 * 对端走了。
 *
 * 这条线是 2026-09-16 审查 R2 的另一半：路由拿到这个 signal 之后，取消才
 * 真的能到达 bwrap 进程树；在此之前 Agent 侧 RPC 超时只是让客户端不再等，
 * sandbox 那边的命令仍在继续写文件。
 */
function clientAbortSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

function incomingToRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const host = req.headers.host ?? '127.0.0.1';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const method = req.method ?? 'GET';
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() === PEER_IP_HEADER) continue;
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }
  const peer = req.socket?.remoteAddress ?? '';
  if (peer) headers.set(PEER_IP_HEADER, peer);
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as ReadableStream;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

async function sendResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (response.body == null) {
    res.end();
    return;
  }
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

export function listenHono(app: Hono, port: number, host = '0.0.0.0'): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const response = await app.fetch(incomingToRequest(req, clientAbortSignal(res)));
        await sendResponse(response, res);
      } catch (err) {
        // 对端已经走了：没有人在等这个响应，也不该把断连记成服务端错误。
        if (res.destroyed || res.writableEnded) return;
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
        }
        const message = err instanceof Error ? err.message : 'internal error';
        res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message } }));
      }
    })();
  });
  server.listen(port, host, () => {
    process.stdout.write(`exec listening on ${port}\n`);
  });
  return server;
}
