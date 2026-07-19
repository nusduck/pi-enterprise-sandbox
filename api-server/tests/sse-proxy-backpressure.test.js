/**
 * PR-10 severe follow-up: BFF SSE proxy backpressure + disconnect cleanup.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  waitForResponseDrain,
  proxySseUpstream,
} from '../src/routes/runs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Minimal ServerResponse stand-in: EventEmitter + write/end.
 */
function createFakeResponse() {
  const ee = new EventEmitter();
  const res = {
    writableEnded: false,
    destroyed: false,
    closed: false,
    chunks: [],
    writeHighWater: true,
    write(chunk) {
      this.chunks.push(chunk);
      return this.writeHighWater;
    },
    end() {
      this.writableEnded = true;
      this.closed = true;
      ee.emit('close');
    },
    once(ev, fn) {
      ee.once(ev, fn);
    },
    on(ev, fn) {
      ee.on(ev, fn);
    },
    off(ev, fn) {
      ee.off(ev, fn);
    },
    emit(ev, ...args) {
      ee.emit(ev, ...args);
    },
    listenerCount(ev) {
      return ee.listenerCount(ev);
    },
  };
  return res;
}

/**
 * Async queue reader for proxySseUpstream.
 * @param {Uint8Array[]} chunks
 */
function createQueueReader(chunks) {
  const queue = [...chunks];
  let cancelled = false;
  let cancelCount = 0;
  let releaseCount = 0;
  return {
    get cancelled() {
      return cancelled;
    },
    get cancelCount() {
      return cancelCount;
    },
    get releaseCount() {
      return releaseCount;
    },
    async read() {
      if (cancelled) return { done: true, value: undefined };
      if (queue.length === 0) return { done: true, value: undefined };
      return { done: false, value: queue.shift() };
    },
    async cancel() {
      cancelled = true;
      cancelCount += 1;
      queue.length = 0;
    },
    releaseLock() {
      releaseCount += 1;
    },
  };
}

describe('waitForResponseDrain', () => {
  it('resolves drained and removes all listeners', async () => {
    const res = createFakeResponse();
    const p = waitForResponseDrain(res);
    assert.equal(res.listenerCount('drain'), 1);
    assert.equal(res.listenerCount('close'), 1);
    assert.equal(res.listenerCount('error'), 1);
    res.emit('drain');
    assert.equal(await p, 'drained');
    assert.equal(res.listenerCount('drain'), 0);
    assert.equal(res.listenerCount('close'), 0);
    assert.equal(res.listenerCount('error'), 0);
  });

  it('resolves aborted without leaving listeners', async () => {
    const res = createFakeResponse();
    const ac = new AbortController();
    const p = waitForResponseDrain(res, { signal: ac.signal });
    ac.abort();
    assert.equal(await p, 'aborted');
    assert.equal(res.listenerCount('drain'), 0);
  });

  it('resolves closed on res close during wait', async () => {
    const res = createFakeResponse();
    const p = waitForResponseDrain(res);
    res.end();
    assert.equal(await p, 'closed');
    assert.equal(res.listenerCount('drain'), 0);
  });
});

describe('proxySseUpstream backpressure', () => {
  it('does not read next upstream chunk until drain after write(false)', async () => {
    const res = createFakeResponse();
    res.writeHighWater = false; // first write backpressures

    const reads = [];
    const chunks = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
    let idx = 0;
    const reader = {
      async read() {
        reads.push(idx);
        if (idx >= chunks.length) return { done: true, value: undefined };
        const value = chunks[idx];
        idx += 1;
        // Proxy only calls read again after drain when write returned false.
        return { done: false, value };
      },
      async cancel() {},
      releaseLock() {},
    };

    const proxyPromise = proxySseUpstream({ reader, res, signal: null });

    // Let first write+drain wait settle
    for (let i = 0; i < 40 && res.listenerCount('drain') === 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(res.listenerCount('drain'), 1, 'waiting on drain');
    assert.equal(reads.length, 1, 'must not read second chunk before drain');
    assert.equal(res.chunks.length, 1);

    // Now allow writes and drain
    res.writeHighWater = true;
    res.emit('drain');
    await proxyPromise;

    assert.equal(reads.length, 4); // 3 chunks + done
    assert.equal(res.chunks.length, 3);
  });

  it('close during drain cancels upstream reader and ends', async () => {
    const res = createFakeResponse();
    res.writeHighWater = false;
    const reader = createQueueReader([
      new Uint8Array([9]),
      new Uint8Array([8]),
    ]);
    const ac = new AbortController();

    const proxyPromise = proxySseUpstream({
      reader,
      res,
      signal: ac.signal,
    });

    for (let i = 0; i < 40 && res.listenerCount('drain') === 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(res.listenerCount('drain'), 1);

    ac.abort();
    // Also emit close so isClosed paths fire
    res.closed = true;
    res.emit('close');

    await proxyPromise;
    assert.ok(reader.cancelCount >= 1, 'upstream reader must be cancelled');
    assert.ok(reader.releaseCount >= 1, 'reader lock released');
    assert.equal(res.listenerCount('drain'), 0);
  });

  it('finally always cancel/release even when stream completes cleanly', async () => {
    const res = createFakeResponse();
    const reader = createQueueReader([new Uint8Array([1])]);
    await proxySseUpstream({ reader, res, signal: null });
    assert.equal(reader.cancelCount, 1);
    assert.equal(reader.releaseCount, 1);
  });
});

describe('handleRunEvents source contract (backpressure wiring)', () => {
  it('uses waitForResponseDrain and proxySseUpstream with cancel', () => {
    const src = readFileSync(join(__dirname, '../src/routes/runs.js'), 'utf8');
    assert.match(src, /export function waitForResponseDrain/);
    assert.match(src, /export async function proxySseUpstream/);
    assert.match(src, /waitForResponseDrain/);
    assert.match(src, /reader\.cancel/);
    assert.match(src, /releaseLock/);
    // Must not use bare once('drain') without abort/close cleanup path.
    assert.doesNotMatch(
      src,
      /new Promise\(\(resolve\) => res\.once\('drain', resolve\)\)/,
    );
  });
});
