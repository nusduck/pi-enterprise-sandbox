import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxClient } from '../src/infrastructure/sandbox/sandbox-client.js';

test('command and process wait HTTP bounds follow the declared operation timeout', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const delays = [];

  globalThis.setTimeout = (callback, delay, ...args) => {
    delays.push(delay);
    return originalSetTimeout(callback, delay, ...args);
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ status: 'completed' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  try {
    const client = createSandboxClient();
    await client.executeCommand('session_1', 'sleep 120', 120);
    await client.waitProcess('process_1', 45);
    assert.deepEqual(delays, [125_000, 50_000]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});
