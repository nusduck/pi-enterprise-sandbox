/**
 * Deterministic OpenAI-compatible chat completions provider for tests ONLY.
 *
 * Production must never enable this path. Callers set AGENT_ENABLE_FAKE_LLM=1
 * and point LLMIO_BASE_URL at the returned base URL. Guards reject production.
 *
 * Usage (tests):
 *   const { startFakeOpenAIProvider, assertFakeLlmAllowed } = await import('./fake-openai-provider.js');
 *   assertFakeLlmAllowed(process.env);
 *   const fake = await startFakeOpenAIProvider();
 *   process.env.LLMIO_BASE_URL = fake.baseUrl;
 *   ...
 *   await fake.close();
 */
import http from 'node:http';

/** Env flag that enables the test-only fake provider. */
export const FAKE_LLM_ENV = 'AGENT_ENABLE_FAKE_LLM';

/**
 * True when the fake provider flag is set.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isFakeLlmEnabled(env = process.env) {
  const raw = env[FAKE_LLM_ENV];
  if (raw == null || String(raw).trim() === '') return false;
  const v = String(raw).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Fail-closed production guard. Throws if fake LLM is requested under production.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean} whether fake LLM is enabled (and allowed)
 */
export function assertFakeLlmAllowed(env = process.env) {
  if (!isFakeLlmEnabled(env)) return false;
  const nodeEnv = String(env.NODE_ENV || '').toLowerCase();
  const deployEnv = String(env.DEPLOYMENT_ENV || '').toLowerCase();
  if (nodeEnv === 'production' || deployEnv === 'production') {
    throw new Error(
      `${FAKE_LLM_ENV} is forbidden when NODE_ENV or DEPLOYMENT_ENV is production`,
    );
  }
  return true;
}

/**
 * Build a non-streaming OpenAI chat.completions payload.
 * @param {string} content
 * @param {string} [model]
 */
export function buildChatCompletionResponse(content, model = 'fake-model') {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/**
 * Build a deterministic tool-call response accepted by OpenAI-compatible
 * providers. This stays in the guarded test helper; production never loads a
 * synthetic model response path.
 *
 * @param {{ id: string, name: string, arguments: object|string }[]} toolCalls
 * @param {string} [model]
 */
export function buildChatCompletionToolResponse(toolCalls, model = 'fake-model') {
  return {
    id: 'chatcmpl-fake-tool',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments:
                typeof call.arguments === 'string'
                  ? call.arguments
                  : JSON.stringify(call.arguments ?? {}),
            },
          })),
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

/**
 * SSE stream chunks for OpenAI chat.completions stream=true.
 * @param {string} content
 * @param {string} [model]
 */
export function buildChatCompletionStream(content, model = 'fake-model') {
  const id = 'chatcmpl-fake-stream';
  const chunks = [
    {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ];
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

/**
 * SSE equivalent of {@link buildChatCompletionToolResponse}.
 * @param {{ id: string, name: string, arguments: object|string }[]} toolCalls
 * @param {string} [model]
 */
export function buildChatCompletionToolStream(toolCalls, model = 'fake-model') {
  const id = 'chatcmpl-fake-tool-stream';
  const created = Math.floor(Date.now() / 1000);
  const chunks = [
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null },
      ],
    },
    ...toolCalls.map((call, index) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments:
                    typeof call.arguments === 'string'
                      ? call.arguments
                      : JSON.stringify(call.arguments ?? {}),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })),
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    },
  ];
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function normalizeScriptedResponse(value, fallback) {
  if (typeof value === 'string') return { content: value, toolCalls: null };
  if (value && typeof value === 'object') {
    const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls : null;
    if (toolCalls?.length) return { content: null, toolCalls };
    if (typeof value.content === 'string') {
      return { content: value.content, toolCalls: null };
    }
  }
  return { content: fallback, toolCalls: null };
}

/**
 * Start a local OpenAI-compatible HTTP server.
 * @param {{
 *   reply?: string,
 *   port?: number,
 *   responder?: (input: { body: any, requestIndex: number, requests: object[] }) =>
 *     (string|{ content?: string, toolCalls?: { id: string, name: string, arguments: object|string }[] })|
 *     Promise<string|{ content?: string, toolCalls?: { id: string, name: string, arguments: object|string }[] }>,
 * }} [options]
 * @returns {Promise<{
 *   baseUrl: string,
 *   port: number,
 *   requests: object[],
 *   setResponder: (next: Function|null) => void,
 *   close: () => Promise<void>,
 * }>}
 */
export function startFakeOpenAIProvider(options = {}) {
  const reply = options.reply ?? 'fake-llm-ok';
  const requests = [];
  let responder = typeof options.responder === 'function' ? options.responder : null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    requests.push({ method: req.method, path: url.pathname, body });

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'fake-model', object: 'model' }],
        }),
      );
      return;
    }

    if (
      req.method === 'POST' &&
      (url.pathname === '/chat/completions' ||
        url.pathname === '/v1/chat/completions' ||
        url.pathname.endsWith('/chat/completions'))
    ) {
      const stream = Boolean(body && body.stream);
      const scripted = normalizeScriptedResponse(
        responder
          ? await responder({
              body,
              requestIndex: requests.length - 1,
              requests,
            })
          : reply,
        reply,
      );
      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.end(
          scripted.toolCalls
            ? buildChatCompletionToolStream(
                scripted.toolCalls,
                body?.model || 'fake-model',
              )
            : buildChatCompletionStream(
                scripted.content,
                body?.model || 'fake-model',
              ),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          scripted.toolCalls
            ? buildChatCompletionToolResponse(
                scripted.toolCalls,
                body?.model || 'fake-model',
              )
            : buildChatCompletionResponse(
                scripted.content,
                body?.model || 'fake-model',
              ),
        ),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `fake provider: no route ${url.pathname}` } }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        port,
        requests,
        setResponder(next) {
          responder = typeof next === 'function' ? next : null;
        },
        close: () =>
          new Promise((resClose, rejClose) => {
            // A release-gate responder may intentionally hold a model request
            // across a Worker SIGKILL. Close active sockets first so cleanup
            // cannot wait forever on a deliberately unresolved responder.
            server.closeAllConnections?.();
            server.closeIdleConnections?.();
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    });
  });
}
