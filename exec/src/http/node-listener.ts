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

function incomingToRequest(req: IncomingMessage): Request {
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
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
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
        const response = await app.fetch(incomingToRequest(req));
        await sendResponse(response, res);
      } catch (err) {
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
