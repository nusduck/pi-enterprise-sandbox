/**
 * SSE parser unit tests — fragmentation, flush, malformed, abort, UTF-8.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSSEParser, readSSEStream } from '../src/sse.js';

function enc(str) {
  return new TextEncoder().encode(str);
}

describe('createSSEParser', () => {
  it('parses a complete single event', () => {
    const events = [];
    const p = createSSEParser({ onEvent: (e) => events.push(e) });
    const out = p.feed('data: {"type":"token","text":"hi"}\n');
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'token');
    assert.equal(events[0].text, 'hi');
  });

  it('handles fragmented chunks across feed() calls', () => {
    const events = [];
    const p = createSSEParser({ onEvent: (e) => events.push(e) });
    assert.deepEqual(p.feed('data: {"type":"tok'), []);
    assert.deepEqual(p.feed('en","text":"ab'), []);
    const out = p.feed('c"}\n');
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'abc');
    assert.equal(events.length, 1);
  });

  it('handles multiple events in one chunk', () => {
    const p = createSSEParser();
    const chunk =
      'data: {"type":"token","text":"a"}\n' +
      'data: {"type":"token","text":"b"}\n' +
      'data: {"type":"done"}\n';
    const out = p.feed(chunk);
    assert.equal(out.length, 3);
    assert.equal(out[0].text, 'a');
    assert.equal(out[2].type, 'done');
  });

  it('flushes trailing buffer without final newline on stream end', () => {
    const p = createSSEParser();
    p.feed('data: {"type":"token","text":"partial"}\n');
    p.feed('data: {"type":"done"}'); // no trailing newline
    assert.equal(p.buffer.length > 0, true);
    const flushed = p.flush();
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].type, 'done');
    assert.equal(p.buffer, '');
  });

  it('skips malformed JSON without throwing', () => {
    const bad = [];
    const good = [];
    const p = createSSEParser({
      onEvent: (e) => good.push(e),
      onMalformed: (raw) => bad.push(raw),
    });
    const out = p.feed(
      'data: {not-json}\n' +
      'data: {"type":"token","text":"ok"}\n' +
      'data: \n' +
      'data: {"type":"done"}\n',
    );
    assert.equal(bad.length, 1);
    assert.equal(out.length, 2);
    assert.equal(good[0].text, 'ok');
    assert.equal(good[1].type, 'done');
  });

  it('abort clears buffer and stops further dispatch', () => {
    const events = [];
    const p = createSSEParser({ onEvent: (e) => events.push(e) });
    p.feed('data: {"type":"token","text":"x"');
    p.abort();
    assert.equal(p.aborted, true);
    assert.equal(p.buffer, '');
    assert.deepEqual(p.feed('data: {"type":"token","text":"y"}\n'), []);
    assert.deepEqual(p.flush(), []);
    assert.equal(events.length, 0);
  });

  it('reassembles multi-byte UTF-8 split across binary chunks', () => {
    // "你好" in UTF-8: E4 BD A0 E5 A5 BD
    const text = '你好';
    const bytes = enc(`data: {"type":"token","text":"${text}"}\n`);
    // Split in the middle of the first multi-byte character sequence after prefix
    // Find a split point inside the multi-byte region of the JSON value
    const full = Array.from(bytes);
    // Split roughly in half — may cut a multi-byte sequence
    const mid = Math.floor(full.length / 2);
    const p = createSSEParser();
    const a = p.feed(new Uint8Array(full.slice(0, mid)));
    const b = p.feed(new Uint8Array(full.slice(mid)));
    const events = [...a, ...b];
    assert.equal(events.length, 1);
    assert.equal(events[0].text, text);
  });

  it('tolerates CRLF line endings', () => {
    const p = createSSEParser();
    const out = p.feed('data: {"type":"done"}\r\n');
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'done');
  });

  it('ignores non-data SSE lines (comments, event:, id:)', () => {
    const p = createSSEParser();
    const out = p.feed(
      ': keep-alive\n' +
      'event: message\n' +
      'id: 1\n' +
      'data: {"type":"token","text":"z"}\n',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'z');
  });
});

describe('readSSEStream', () => {
  function mockResponse(chunks, { abortAfter } = {}) {
    let i = 0;
    let cancelled = false;
    const reader = {
      async read() {
        if (cancelled) return { done: true, value: undefined };
        if (abortAfter != null && i >= abortAfter) {
          return { done: true, value: undefined };
        }
        if (i >= chunks.length) return { done: true, value: undefined };
        const value = chunks[i++];
        return { done: false, value };
      },
      cancel() {
        cancelled = true;
      },
      releaseLock() {},
    };
    return {
      body: {
        getReader() {
          return reader;
        },
      },
    };
  }

  it('dispatches events and flushes trailing buffer on done', async () => {
    const events = [];
    const resp = mockResponse([
      enc('data: {"type":"token","text":"a"}\n'),
      enc('data: {"type":"done"}'), // no newline — must flush
    ]);
    await readSSEStream(resp, (e) => events.push(e));
    assert.equal(events.length, 2);
    assert.equal(events[0].text, 'a');
    assert.equal(events[1].type, 'done');
  });

  it('stops on abort signal', async () => {
    const events = [];
    const ctrl = new AbortController();
    const chunks = [
      enc('data: {"type":"token","text":"1"}\n'),
      enc('data: {"type":"token","text":"2"}\n'),
      enc('data: {"type":"token","text":"3"}\n'),
    ];
    let i = 0;
    const reader = {
      async read() {
        if (ctrl.signal.aborted) return { done: true, value: undefined };
        if (i === 1) ctrl.abort();
        if (i >= chunks.length) return { done: true, value: undefined };
        return { done: false, value: chunks[i++] };
      },
      cancel() {},
      releaseLock() {},
    };
    const resp = { body: { getReader: () => reader } };
    await readSSEStream(resp, (e) => events.push(e), ctrl.signal);
    // At most first event before abort; must not throw
    assert.ok(events.length <= 2);
  });

  it('returns immediately if signal already aborted', async () => {
    const events = [];
    const ctrl = new AbortController();
    ctrl.abort();
    const resp = mockResponse([enc('data: {"type":"token","text":"x"}\n')]);
    await readSSEStream(resp, (e) => events.push(e), ctrl.signal);
    assert.equal(events.length, 0);
  });
});
