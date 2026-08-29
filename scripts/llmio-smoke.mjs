// Wave 0 冒烟：验证 LLMIO 网关能否承受 dsh-llm-deepseek 的请求形态。
// 只打印结构与结论，绝不打印 API key。
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(process.argv[2] || '.env', 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const base = (env.LLMIO_BASE_URL || '').replace(/\/+$/, '');
const key = env.LLMIO_API_KEY || '';
const model = env.MODEL_ID || 'deepseek-v4-flash';
if (!base || !key) { console.error('缺 LLMIO_BASE_URL / LLMIO_API_KEY'); process.exit(2); }
console.log(`网关: ${base}`);
console.log(`模型: ${model}`);
console.log(`密钥: 已加载 (${key.length} 字符)\n`);

// dsh-llm-deepseek 会附带的两个额外头
const HARNESS_HEADERS = {
  'x-deepseek-harness-user-id': '00000000-0000-4000-8000-000000000000',
  'user-agent': 'dsh/0.1.1-rc.2 (smoke-test)',
};

async function probe(label, headers, body) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    console.log(`  ✗ ${label}: 连接失败 — ${e.message}`);
    return null;
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 400);
    console.log(`  ✗ ${label}: HTTP ${res.status} — ${text}`);
    return null;
  }
  const stats = { frames: 0, textDeltas: 0, toolCallDeltas: 0, finish: null, usage: null, roles: new Set() };
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { stats.frames++; continue; }
      stats.frames++;
      try {
        const j = JSON.parse(payload);
        const d = j.choices?.[0]?.delta;
        if (d?.role) stats.roles.add(d.role);
        if (typeof d?.content === 'string' && d.content) stats.textDeltas++;
        if (d?.tool_calls?.length) stats.toolCallDeltas++;
        if (j.choices?.[0]?.finish_reason) stats.finish = j.choices[0].finish_reason;
        if (j.usage) stats.usage = j.usage;
      } catch { /* 非 JSON 帧忽略 */ }
    }
  }
  console.log(`  ✓ ${label}: ${Date.now() - t0}ms · ${stats.frames} 帧 · 文本增量 ${stats.textDeltas} · 工具增量 ${stats.toolCallDeltas} · finish=${stats.finish}`);
  if (stats.usage) console.log(`     usage: ${JSON.stringify(stats.usage)}`);
  return stats;
}

const TOOLS = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}];

console.log('【探针 1】纯净头 + 流式文本');
const p1 = await probe('baseline', {}, {
  model, stream: true, max_tokens: 64,
  messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
});

console.log('\n【探针 2】加上 dsh-llm-deepseek 的归属头');
const p2 = await probe('harness headers', HARNESS_HEADERS, {
  model, stream: true, max_tokens: 64,
  messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
});

console.log('\n【探针 3】归属头 + 流式工具调用');
const p3 = await probe('tool call', HARNESS_HEADERS, {
  model, stream: true, max_tokens: 256, tools: TOOLS, tool_choice: 'auto',
  messages: [{ role: 'user', content: "What's the weather in Singapore? Use the tool." }],
});

console.log('\n【探针 4】流式 usage（KV cache 统计是否可见）');
const p4 = await probe('stream_options', HARNESS_HEADERS, {
  model, stream: true, max_tokens: 64, stream_options: { include_usage: true },
  messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
});

console.log('\n──────── 结论 ────────');
console.log(`网关可达且支持流式        : ${p1 ? '是' : '否'}`);
console.log(`容忍 harness 归属头       : ${p2 ? '是' : '否'}`);
console.log(`支持流式工具调用          : ${p3 ? (p3.toolCallDeltas > 0 ? '是' : '连通但本次未触发工具') : '否'}`);
console.log(`支持 stream_options.usage : ${p4 ? (p4.usage ? '是' : '接受参数但未回 usage') : '否'}`);
const gate = p1 && p2 && p3;
console.log(`\nWave 0 门槛: ${gate ? '通过 —— 可以进 Wave 1' : '未通过 —— 需要写自定义适配器'}`);
