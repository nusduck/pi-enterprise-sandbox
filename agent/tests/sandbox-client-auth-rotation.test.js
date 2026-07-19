import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxClient } from '../infrastructure/sandbox-client.js';

test('existing Sandbox client resolves the service token for every request', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.SANDBOX_API_TOKEN;
  const observed = [];
  globalThis.fetch = async (_url, options = {}) => {
    observed.push(new Headers(options.headers).get('x-api-key'));
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    process.env.SANDBOX_API_TOKEN = 'service-token-before-rotation';
    const client = createSandboxClient();
    await client.checkHealth();

    process.env.SANDBOX_API_TOKEN = 'service-token-after-rotation';
    await client.checkHealth();

    assert.deepEqual(observed, [
      'service-token-before-rotation',
      'service-token-after-rotation',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken == null) delete process.env.SANDBOX_API_TOKEN;
    else process.env.SANDBOX_API_TOKEN = originalToken;
  }
});
