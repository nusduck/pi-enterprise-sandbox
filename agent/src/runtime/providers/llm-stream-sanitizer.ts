/**
 * 模型流式响应的工具调用分片消毒。
 *
 * 为什么存在：部分 OpenAI 兼容上游（vLLM 风格，调用 id 前缀 `chatcmpl-tool-`）在
 * 首个 tool_calls 分片之后，每个分片都显式带 `"id": ""`、`"type": null`、
 * `"function": {"name": null}`。出厂 `dsh-llm-deepseek` 只在字段为 `undefined` 时
 * 跳过，于是首片里的工具名与调用 id 被空值覆盖；工具名成空串，风险策略按未知工具
 * 拒绝（fail-closed 正确，但整轮工具全废）。见 `tests/runtime/llm-stream-tool-call.test.ts`。
 *
 * 做法：适配器直接调全局 `fetch` 且不接受注入，所以只能包一层全局 `fetch`。
 * 范围收得很窄——只处理 `POST {baseURL}/chat/completions` 的 `text/event-stream`
 * 响应，只删 tool_calls 分片里的空 id / 空 type / 空 name / 空 arguments；
 * 其他请求、其他字段、非 JSON 行一律原样透传。空值本来就表示“这片没带”，删掉
 * 与 OpenAI 协议语义一致，不会让缺名的调用变得可执行（仍然按未知工具拒绝）。
 *
 * 退役条件：出厂适配器改为把空值当缺省后，复现用例的第一条会失败，届时删掉本文件。
 */

type FetchFn = typeof globalThis.fetch;

/** 删掉一个 SSE `data:` JSON 里 tool_calls 分片的空值字段；返回是否改动。 */
export function stripEmptyToolCallFields(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return false;
  let changed = false;
  for (const choice of choices) {
    const calls = (choice as { delta?: { tool_calls?: unknown } } | null)?.delta?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (call === null || typeof call !== 'object') continue;
      const c = call as Record<string, unknown>;
      for (const key of ['id', 'type'] as const) {
        if (key in c && (c[key] === '' || c[key] === null)) {
          delete c[key];
          changed = true;
        }
      }
      const fn = c.function;
      if (fn !== null && typeof fn === 'object') {
        const f = fn as Record<string, unknown>;
        if ('name' in f && (f.name === '' || f.name === null)) {
          delete f.name;
          changed = true;
        }
        if ('arguments' in f && f.arguments === null) {
          delete f.arguments;
          changed = true;
        }
      }
    }
  }
  return changed;
}

function sanitizeLine(line: string): string {
  const match = /^data:\s?(.*)$/.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
  if (!match || !match[1] || match[1] === '[DONE]') return line;
  let payload: unknown;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    return line;
  }
  return stripEmptyToolCallFields(payload) ? `data: ${JSON.stringify(payload)}` : line;
}

/** 按行缓冲的 SSE 变换：网络块可能切在一行中间，只处理完整的行。 */
export function createToolCallSanitizerStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  return new TransformStream({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      const end = buffer.lastIndexOf('\n');
      if (end === -1) return;
      const complete = buffer.slice(0, end + 1);
      buffer = buffer.slice(end + 1);
      controller.enqueue(encoder.encode(complete.split('\n').map(sanitizeLine).join('\n')));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(sanitizeLine(buffer)));
    },
  });
}

/** 适配器按 `${baseURL}/chat/completions` 原样拼接，baseURL 带尾斜杠时会出现 `//`：比较前统一。 */
function requestUrl(input: Parameters<FetchFn>[0]): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return raw.replace(/\/+(chat\/completions)$/, '/$1');
}

/**
 * 包装全局 `fetch`，只对 `POST {baseURL}/chat/completions` 的事件流做消毒。
 * 返回卸载函数（测试用）；对同一进程重复安装同一个 baseURL 是幂等的。
 */
export function installLlmStreamSanitizer(baseURL: string): () => void {
  const target = `${baseURL.replace(/\/+$/, '')}/chat/completions`;
  const installed = installedTargets.get(target);
  if (installed) return installed;

  const original: FetchFn = globalThis.fetch;
  const wrapped: FetchFn = async (input, init) => {
    const response = await original(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'POST' || requestUrl(input) !== target) return response;
    if (!response.ok || !response.body) return response;
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) return response;
    return new Response(response.body.pipeThrough(createToolCallSanitizerStream()), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  globalThis.fetch = wrapped;
  const uninstall = () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original;
    installedTargets.delete(target);
  };
  installedTargets.set(target, uninstall);
  return uninstall;
}

const installedTargets = new Map<string, () => void>();
