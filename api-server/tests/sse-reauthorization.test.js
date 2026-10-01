/**
 * Bounded SSE re-authorization: fail-closed close, timer release, no Run cancel.
 * Run: node --test api-server/tests/sse-reauthorization.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SSE_REAUTH_INTERVAL_MS,
  defaultSseReauthorize,
  startSseReauthorization,
} from '../src/application/sse-reauthorization.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('condition timeout'));
      setTimeout(tick, 2);
    };
    tick();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('startSseReauthorization', () => {
  it('is inert when browser auth is disabled', async () => {
    let calls = 0;
    const handle = startSseReauthorization({
      req: null,
      authEnabled: false,
      intervalMs: 5,
      reauthorize: async () => {
        calls += 1;
      },
      onRevoked: () => {
        throw new Error('must not be called');
      },
    });
    await sleep(30);
    assert.equal(calls, 0);
    handle.stop();
  });

  it('keeps the stream open while re-authorization succeeds', async () => {
    let calls = 0;
    let revoked = 0;
    const handle = startSseReauthorization({
      req: null,
      authEnabled: true,
      intervalMs: 5,
      reauthorize: async () => {
        calls += 1;
      },
      onRevoked: () => {
        revoked += 1;
      },
    });
    await waitUntil(() => calls >= 3);
    assert.equal(revoked, 0);
    handle.stop();
    const settled = calls;
    await sleep(25);
    assert.equal(calls, settled, 'stop() must release the timer');
  });

  it('closes once and releases the timer on a 401/authority failure', async () => {
    let calls = 0;
    let revoked = 0;
    startSseReauthorization({
      req: null,
      authEnabled: true,
      intervalMs: 5,
      reauthorize: async () => {
        calls += 1;
        const err = new Error('unauthorized');
        err.status = 401;
        throw err;
      },
      onRevoked: () => {
        revoked += 1;
      },
    });
    await waitUntil(() => revoked === 1);
    const settled = calls;
    await sleep(30);
    assert.equal(revoked, 1, 'onRevoked must fire exactly once');
    assert.equal(calls, settled, 'timer must be cleared after fail-closed close');
  });

  it('stop() is idempotent and suppresses a late failure', async () => {
    let revoked = 0;
    let rejectNow = false;
    const handle = startSseReauthorization({
      req: null,
      authEnabled: true,
      intervalMs: 5,
      reauthorize: async () => {
        if (rejectNow) throw new Error('late');
      },
      onRevoked: () => {
        revoked += 1;
      },
    });
    handle.stop();
    rejectNow = true;
    await sleep(30);
    assert.equal(revoked, 0);
  });

  it('fires at the default 15s bound', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let calls = 0;
    let revoked = 0;
    startSseReauthorization({
      req: null,
      authEnabled: true,
      reauthorize: async () => {
        calls += 1;
        throw new Error('unauthorized');
      },
      onRevoked: () => {
        revoked += 1;
      },
    });
    // Nothing fires before the bound.
    t.mock.timers.tick(SSE_REAUTH_INTERVAL_MS - 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 0);
    assert.equal(revoked, 0);
    t.mock.timers.tick(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 1);
    assert.equal(revoked, 1);
  });

  it('exposes a 15s target cadence', () => {
    assert.equal(SSE_REAUTH_INTERVAL_MS, 15_000);
  });
});

describe('defaultSseReauthorize', () => {
  it('fails closed when the request carries no credential', async () => {
    await assert.rejects(defaultSseReauthorize({ headers: {} }));
  });

  it('re-resolves the Cookie session through the Agent', async (t) => {
    const original = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ id: 'u1' }), { status: 200 });
    };
    t.after(() => {
      globalThis.fetch = original;
    });
    await defaultSseReauthorize({
      headers: { cookie: 'dsh_enterprise_session=sse-token' },
      traceId: null,
      traceContext: null,
    });
    assert.match(seen[0] ?? '', /\/internal\/auth\/me$/);
  });
});

describe('handleRunEvents re-authorization wiring', () => {
  const src = readFileSync(join(__dirname, '../src/routes/runs.ts'), 'utf8');

  it('starts bounded re-authorization and stops it in finally', () => {
    assert.match(src, /startSseReauthorization\(/);
    assert.match(src, /reauthorization\?\.stop\(\)/);
  });

  it('closes the relay on revoke without cancelling the Run', () => {
    assert.match(src, /onRevoked:\s*\(\)\s*=>\s*\{[\s\S]*?controller\.abort\(\)/);
    // The revoke path aborts only this subscription. `cancelAgentRun` may only
    // appear in the explicit POST /cancel route, never in the SSE relay.
    const cancelCalls = src.match(/cancelAgentRun\(/g) ?? [];
    assert.equal(cancelCalls.length, 1);
  });

  it('releases the upstream reader on close', () => {
    assert.match(src, /reader\.cancel/);
    assert.match(src, /releaseLock/);
  });
});
