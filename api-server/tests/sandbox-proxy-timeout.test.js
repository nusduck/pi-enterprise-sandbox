/**
 * AGENTS.md §2 — the BFF's Sandbox proxies are bounded.
 *
 * 2026-08-26 full-repo standards review: the file/artifact/dataset proxies and
 * the `/health` probe used bare `fetch` with no AbortSignal, so a stalled
 * Sandbox pinned the browser request and the BFF socket until the client gave
 * up. Only the SSE relay is exempt (bounded by the client connection).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSandboxBounded } from '../src/routes/files.js';
import { createSandboxClient } from '../src/services/sandbox-client.js';

/** fetch stub that never answers until its signal aborts. */
function hangingFetch() {
  return (_url, options = {}) =>
    new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      );
    });
}

test('bounded proxy fetch fails with 504 when Sandbox never answers', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = hangingFetch();
  try {
    await assert.rejects(
      fetchSandboxBounded('http://sandbox:8081/x', {}, 20),
      (err) => {
        assert.equal(err.code, 'SANDBOX_TIMEOUT');
        assert.equal(err.status, 504);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('bounded proxy fetch does not cut the body once headers arrive', async () => {
  const originalFetch = globalThis.fetch;
  /** @type {AbortSignal | undefined} */
  let seenSignal;
  globalThis.fetch = async (_url, options = {}) => {
    seenSignal = options.signal;
    return new Response('payload', { status: 200 });
  };
  try {
    const resp = await fetchSandboxBounded('http://sandbox:8081/x', {}, 20);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(seenSignal?.aborted, false);
    assert.equal(await resp.text(), 'payload');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a caller abort is not reported as a Sandbox timeout', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = hangingFetch();
  const upstream = new AbortController();
  try {
    const pending = fetchSandboxBounded(
      'http://sandbox:8081/x',
      { signal: upstream.signal },
      60_000,
    );
    upstream.abort();
    await assert.rejects(pending, (err) => {
      assert.notEqual(err.code, 'SANDBOX_TIMEOUT');
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sandbox /health probe carries a deadline', async () => {
  const originalFetch = globalThis.fetch;
  /** @type {AbortSignal | undefined} */
  let seenSignal;
  globalThis.fetch = async (_url, options = {}) => {
    seenSignal = options.signal;
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await createSandboxClient().checkHealth();
    assert.ok(
      seenSignal instanceof AbortSignal,
      '/health probe must pass an AbortSignal',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
