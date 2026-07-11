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
});
