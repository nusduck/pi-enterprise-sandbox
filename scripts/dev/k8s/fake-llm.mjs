// K8s 多副本演练（up.sh sim）用的可控假模型（OpenAI 兼容 chat/completions）。只在 scripts/dev/k8s 的 sim 模式里用，
// 生产与开发 Compose 都不加载它。
//
// 行为由用户消息里的标记决定：`[[SIM id=<id> mode=<mode>]]`
//   mode=tool       第一轮立即回一个 bash 工具调用（往工作区 sim-<id>.log 追加一行），拿到工具结果后回文本。
//   mode=hold-tool  第一轮挂住，直到 POST /_sim/release {id} 才回 bash 工具调用；之后同 tool。
//   mode=hold-text  第一轮挂住，放行后回文本。
//   mode=text       立即回文本。
// 没有工具的请求（DSH 每轮另发的标题生成）立即回固定文本，不计入模型轮次。
//
// 控制面（同端口）：GET /_sim/log、POST /_sim/release {id}、POST /_sim/reset。
// 日志里每条模型轮次请求记录来源地址（= 发起请求的 Worker Pod IP），用来判断 Run 落在哪个副本。
import http from 'node:http';
import {
  buildChatCompletionResponse,
  buildChatCompletionStream,
  buildChatCompletionToolResponse,
  buildChatCompletionToolStream,
} from '/repo/agent/tests/support/fake-openai-provider.js';

const PORT = Number(process.env.PORT || 8080);
const MARKER = /\[\[SIM id=([A-Za-z0-9_-]+) mode=([a-z-]+)\]\]/;

let seq = 0;
let log = [];
let held = [];

function toolCall(id) {
  return {
    toolCalls: [
      {
        id: `call_${id}_${seq}`,
        name: 'bash',
        arguments: {
          command: `echo "$(date +%s%N) ${id}" >> /home/sandbox/workspace/sim-${id}.log`,
          description: `sim ${id}`,
          timeoutMs: 20000,
        },
      },
    ],
  };
}

function send(res, body, scripted) {
  if (res.writableEnded || res.destroyed) return false;
  const model = body?.model || 'fake-model';
  if (body?.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.end(
      scripted.toolCalls
        ? buildChatCompletionToolStream(scripted.toolCalls, model)
        : buildChatCompletionStream(scripted.content, model),
    );
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        scripted.toolCalls
          ? buildChatCompletionToolResponse(scripted.toolCalls, model)
          : buildChatCompletionResponse(scripted.content, model),
      ),
    );
  }
  return true;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://sim');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }

  if (url.pathname === '/_sim/log' && req.method === 'GET') return json(res, 200, log);
  if (url.pathname === '/_sim/reset' && req.method === 'POST') {
    for (const h of held) h.res.destroy();
    log = [];
    held = [];
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/_sim/release' && req.method === 'POST') {
    const id = String(body?.id || '');
    const released = [];
    for (const h of held.filter((x) => x.id === id)) {
      const ok = send(h.res, h.body, h.mode === 'hold-tool' ? toolCall(id) : { content: `done ${id}` });
      h.entry.state = ok ? 'released' : 'aborted';
      released.push(h.entry.seq);
    }
    held = held.filter((x) => x.id !== id);
    return json(res, 200, { released });
  }
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname.endsWith('/models'))) {
    return json(res, 200, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] });
  }
  if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    return json(res, 404, { error: { message: `sim: no route ${url.pathname}` } });
  }

  const tools = Array.isArray(body?.tools) ? body.tools : [];
  if (tools.length === 0) return send(res, body, { content: 'sim title' });

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const match = MARKER.exec(JSON.stringify(messages));
  const toolResults = messages.filter((m) => m?.role === 'tool').length;
  seq += 1;
  const entry = {
    seq,
    id: match?.[1] || null,
    mode: match?.[2] || null,
    turn: toolResults + 1,
    remote: String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
    at: new Date().toISOString(),
    state: 'answered',
  };
  log.push(entry);

  if (!match) return send(res, body, { content: 'sim: no marker' });
  const [, id, mode] = match;
  if (toolResults > 0 || mode === 'text') return send(res, body, { content: `done ${id}` });
  if (mode === 'tool') return send(res, body, toolCall(id));
  if (mode === 'hold-tool' || mode === 'hold-text') {
    entry.state = 'held';
    const h = { id, mode, res, body, entry };
    held.push(h);
    res.on('close', () => {
      if (!res.writableEnded) {
        entry.state = 'aborted';
        held = held.filter((x) => x !== h);
      }
    });
    return undefined;
  }
  return send(res, body, { content: `sim: unknown mode ${mode}` });
});

server.listen(PORT, '0.0.0.0', () => console.log(`[fake-llm] listening on ${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
