/**
 * AGENTS.md §2 — every outbound call to Sandbox is bounded.
 *
 * 2026-08-26 full-repo standards review: `sbFetch` defaulted `timeoutMs` to
 * null, so the whole owner-scoped public plane (workspace GC, operator process
 * control, file/artifact reads) and the `/health` probe could hang forever on a
 * stalled Sandbox.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxClient } from '../src/infrastructure/sandbox/sandbox-client.js';

/** fetch stub that never answers until its signal aborts. */
function hangingFetch(seen) {
  return (url, options = {}) =>
    new Promise((_resolve, reject) => {
      seen.push({ url: String(url), signal: options.signal });
      options.signal?.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      );
    });
}

const PUBLIC_PLANE_CALLS = [
  ['removeSessionWorkspace', (c) => c.removeSessionWorkspace('sess-1')],
  ['getProcessLogs', (c) => c.getProcessLogs('sess-1', 'proc-1')],
  ['readProcess', (c) => c.readProcess('sess-1', 'proc-1')],
  ['writeProcessStdin', (c) => c.writeProcessStdin('sess-1', 'proc-1', 'x')],
  ['signalProcess', (c) => c.signalProcess('sess-1', 'proc-1')],
  ['cancelProcess', (c) => c.cancelProcess('sess-1', 'proc-1')],
  ['readFile', (c) => c.readFile('sess-1', 'a.txt')],
  ['writeFile', (c) => c.writeFile('sess-1', 'a.txt', 'x')],
  ['listFiles', (c) => c.listFiles('sess-1')],
  ['lsFiles', (c) => c.lsFiles('sess-1')],
  ['findFiles', (c) => c.findFiles('sess-1')],
  ['grepFiles', (c) => c.grepFiles('sess-1')],
  ['editFile', (c) => c.editFile('sess-1', { path: 'a.txt' })],
  ['submitArtifact', (c) => c.submitArtifact('sess-1', 'a', 'a.txt', 'text/plain')],
  ['listArtifacts', (c) => c.listArtifacts('sess-1')],
  ['downloadFileStream', (c) => c.downloadFileStream('sess-1', 'a.txt')],
  ['downloadArtifactStream', (c) => c.downloadArtifactStream('sess-1', 'art-1')],
  ['downloadDatasetContent', (c) => c.downloadDatasetContent('sess-1', 'ds-1')],
];

for (const [name, call] of PUBLIC_PLANE_CALLS) {
  test(`sandbox client bounds ${name} on a hung Sandbox`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const originalFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = hangingFetch(seen);
    try {
      const pending = call(createSandboxClient());
      // Longer than any default deadline in the client.
      t.mock.timers.tick(120_000);
      await assert.rejects(pending, /timed out/, `${name} must time out`);
      assert.equal(seen.length, 1);
      assert.ok(seen[0].signal, `${name} must pass an abort signal`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('sandbox client does not cut a streaming body once headers arrive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalFetch = globalThis.fetch;
  /** @type {AbortSignal | undefined} */
  let seenSignal;
  globalThis.fetch = async (_url, options = {}) => {
    seenSignal = options.signal;
    return new Response('bytes', { status: 200 });
  };
  try {
    const resp = await createSandboxClient().downloadArtifactStream(
      'sess-1',
      'art-1',
    );
    assert.equal(resp.status, 200);
    // The deadline covered time-to-headers only — it must not fire afterwards.
    t.mock.timers.tick(600_000);
    assert.equal(seenSignal?.aborted, false);
    assert.equal(await resp.text(), 'bytes');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkHealth probe carries a deadline', async () => {
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
