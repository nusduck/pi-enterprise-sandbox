/**
 * 网关流式工具调用的分片合并（2026-10-03 真实链路发现）。
 *
 * 部分上游（vLLM 风格，调用 id 前缀 `chatcmpl-tool-`）在首个分片之后的每个
 * tool_calls 分片里显式带 `"id": ""`、`"function": {"name": null}`。出厂
 * `dsh-llm-deepseek` 只在字段为 `undefined` 时跳过，于是首片里的 `bash` 与调用 id
 * 被空值覆盖，工具名变成空串，风险策略按未知工具拒绝。这里用真实适配器对着本地
 * SSE 服务复现，并证明 `installLlmStreamSanitizer` 之后名字与 id 保留。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import { installLlmStreamSanitizer, stripEmptyToolCallFields } from '../../src/runtime/providers/llm-stream-sanitizer.js';

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({ id: 'r1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

const VLLM_STYLE = [
  chunk({ role: 'assistant', content: '' }),
  chunk({ tool_calls: [{ index: 0, id: 'chatcmpl-tool-abc', type: 'function', function: { name: 'bash', arguments: '' } }] }),
  chunk({ tool_calls: [{ index: 0, id: '', type: null, function: { name: null, arguments: '{"command": ' } }] }),
  // 同一个分片被 TCP 拆成两半：消毒器必须按行缓冲，不能按网络块解析。
  chunk({ tool_calls: [{ index: 0, id: null, function: { name: '', arguments: '"echo hi"}' } }] }),
  chunk({}, 'tool_calls'),
  'data: [DONE]\n\n',
];

let server: Server;
let baseURL = '';
const ready = new Promise<void>((resolve) => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const body = VLLM_STYLE.join('');
    // 按固定 7 字节切片发送，逼出跨块的半行。
    let i = 0;
    const tick = () => {
      if (i >= body.length) return res.end();
      res.write(body.slice(i, i + 7));
      i += 7;
      setImmediate(tick);
    };
    req.resume();
    req.on('end', tick);
  }).listen(0, '127.0.0.1', () => {
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve();
  });
});
after(() => server.close());

async function finalToolCall() {
  await ready;
  const options = resolveAdapterOptions({ baseURL, apiKeyEnv: 'K', models: [{ id: 'm' }] } as never, undefined as never);
  const adapter = new DeepSeekAdapter({
    options: () => options,
    resolveApiKey: async () => 'test-key',
    resolveUserId: () => 'u',
  } as never);
  let block: { id?: string; name?: string; arguments?: string } | undefined;
  for await (const c of adapter.stream({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'run it' }] }],
    tools: [{ name: 'bash', description: 'shell', parameters: { type: 'object', properties: {} } }],
  } as never) as AsyncIterable<Record<string, any>>) {
    if (c.type === 'block-end' && c.block?.type === 'tool-call') block = c.block;
  }
  return block;
}

test('出厂适配器：后续分片的空 id / null name 会覆盖首片（复现，钉住上游行为）', async () => {
  const block = await finalToolCall();
  assert.equal(block?.name, '');
  assert.equal(block?.id, '');
});

test('装上消毒器后：工具名与调用 id 来自首片，参数完整拼接', async () => {
  const uninstall = installLlmStreamSanitizer(baseURL);
  try {
    const block = await finalToolCall();
    assert.equal(block?.name, 'bash');
    assert.equal(block?.id, 'chatcmpl-tool-abc');
    assert.deepEqual(JSON.parse(block?.arguments ?? ''), { command: 'echo hi' });
  } finally {
    uninstall();
  }
});

test('只删空值：首片的真实值、content 与 reasoning 原样保留；首片自己缺名仍然缺名（不会被“修”成可执行）', () => {
  const first = { choices: [{ delta: { content: '', tool_calls: [{ index: 0, id: 'x', type: 'function', function: { name: 'bash', arguments: '' } }] } }] };
  assert.equal(stripEmptyToolCallFields(first), false);
  assert.equal(first.choices[0].delta.tool_calls[0].function.name, 'bash');
  const nameless = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: '', arguments: '{}' } }] } }] };
  assert.equal(stripEmptyToolCallFields(nameless), true);
  assert.equal('name' in nameless.choices[0].delta.tool_calls[0].function, false);
  assert.equal(stripEmptyToolCallFields({ choices: [{ delta: { content: 'hi' } }] }), false);
});

test('范围：其他 URL 的事件流原样透传', async () => {
  await ready;
  const uninstall = installLlmStreamSanitizer(`${baseURL}/v1`);
  try {
    const res = await fetch(`${baseURL}/chat/completions`, { method: 'POST', body: '{}' });
    assert.ok((await res.text()).includes('"id":""'));
  } finally {
    uninstall();
  }
});
