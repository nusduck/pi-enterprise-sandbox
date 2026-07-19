/**
 * Fake OpenAI provider — test-only, production-guarded.
 * Run: node --test agent/tests/fake-openai-provider.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAKE_LLM_ENV,
  assertFakeLlmAllowed,
  isFakeLlmEnabled,
  startFakeOpenAIProvider,
  buildChatCompletionResponse,
  buildChatCompletionToolResponse,
  buildChatCompletionToolStream,
} from '../testing/fake-openai-provider.js';

describe('fake OpenAI provider guards', () => {
  it('is disabled by default', () => {
    assert.equal(isFakeLlmEnabled({}), false);
    assert.equal(assertFakeLlmAllowed({}), false);
  });

  it('allows non-production when flag is set', () => {
    const env = { [FAKE_LLM_ENV]: '1', NODE_ENV: 'test', DEPLOYMENT_ENV: 'development' };
    assert.equal(isFakeLlmEnabled(env), true);
    assert.equal(assertFakeLlmAllowed(env), true);
  });

  it('rejects NODE_ENV=production', () => {
    assert.throws(
      () => assertFakeLlmAllowed({ [FAKE_LLM_ENV]: 'true', NODE_ENV: 'production' }),
      /forbidden.*production/i,
    );
  });

  it('rejects DEPLOYMENT_ENV=production', () => {
    assert.throws(
      () =>
        assertFakeLlmAllowed({
          [FAKE_LLM_ENV]: '1',
          NODE_ENV: 'development',
          DEPLOYMENT_ENV: 'production',
        }),
      /forbidden.*production/i,
    );
  });
});

describe('fake OpenAI provider HTTP', () => {
  it('serves deterministic chat completions (non-stream + stream)', async () => {
    const fake = await startFakeOpenAIProvider({ reply: 'hello-deterministic' });
    try {
      const nonStream = await fetch(`${fake.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(nonStream.status, 200);
      const json = await nonStream.json();
      assert.equal(json.choices[0].message.content, 'hello-deterministic');

      const stream = await fetch(`${fake.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'fake',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      assert.equal(stream.status, 200);
      const text = await stream.text();
      assert.match(text, /hello-deterministic/);
      assert.match(text, /\[DONE\]/);
      assert.ok(fake.requests.length >= 2);
    } finally {
      await fake.close();
    }
  });

  it('buildChatCompletionResponse is stable shape', () => {
    const payload = buildChatCompletionResponse('x');
    assert.equal(payload.object, 'chat.completion');
    assert.equal(payload.choices[0].finish_reason, 'stop');
  });

  it('serves scripted streaming tool calls followed by text', async () => {
    let turn = 0;
    const fake = await startFakeOpenAIProvider({
      responder: () => {
        turn += 1;
        if (turn === 1) {
          return {
            toolCalls: [
              {
                id: 'call_fake_python_1',
                name: 'python',
                arguments: { code: "print('ok')" },
              },
            ],
          };
        }
        return { content: 'tool-finished' };
      },
    });
    try {
      const first = await fetch(`${fake.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'fake', stream: true, messages: [] }),
      });
      const firstBody = await first.text();
      assert.match(firstBody, /call_fake_python_1/);
      assert.match(firstBody, /"finish_reason":"tool_calls"/);

      const second = await fetch(`${fake.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'fake', stream: false, messages: [] }),
      });
      assert.equal((await second.json()).choices[0].message.content, 'tool-finished');
      assert.equal(fake.requests.length, 2);
    } finally {
      await fake.close();
    }
  });

  it('tool payload builders preserve exact ids, names, and arguments', () => {
    const calls = [
      { id: 'call_1', name: 'submit_artifact', arguments: { path: 'out.txt' } },
    ];
    const json = buildChatCompletionToolResponse(calls);
    assert.equal(json.choices[0].message.tool_calls[0].id, 'call_1');
    assert.equal(json.choices[0].message.tool_calls[0].function.name, 'submit_artifact');
    assert.equal(
      json.choices[0].message.tool_calls[0].function.arguments,
      '{"path":"out.txt"}',
    );
    assert.match(buildChatCompletionToolStream(calls), /submit_artifact/);
  });
});
