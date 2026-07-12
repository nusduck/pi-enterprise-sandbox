/**
 * SSE parser unit tests — fragmentation, flush, malformed, abort, UTF-8.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSSEParser, readSSEStream } from '../src/shared/sse/parser.ts';

function enc(str: string) {
  return new TextEncoder().encode(str);
}

describe('createSSEParser', () => {
  it('parses a complete single event', () => {
    const events: unknown[] = [];
    const p = createSSEParser({ onEvent: (e) => events.push(e) });
    const out = p.feed('data: {"type":"token","text":"hi"}\n');
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'token');
    assert.equal((events[0] as { text: string }).text, 'hi');
  });

  it('handles fragmented chunks across feed() calls', () => {
    const events: unknown[] = [];
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
    assert.equal(out[2].type, 'done');
  });

  it('flush parses trailing buffer without newline', () => {
    const p = createSSEParser();
    p.feed('data: {"type":"token","text":"z"}');
    const out = p.flush();
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'z');
  });

  it('skips malformed JSON and continues', () => {
    const bad: string[] = [];
    const p = createSSEParser({
      onMalformed: (raw) => bad.push(raw),
    });
    const out = p.feed(
      'data: {not-json}\ndata: {"type":"token","text":"ok"}\n',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'ok');
    assert.equal(bad.length, 1);
  });

  it('abort stops further parsing', () => {
    const p = createSSEParser();
    p.abort();
    assert.equal(p.aborted, true);
    assert.deepEqual(p.feed('data: {"type":"token","text":"x"}\n'), []);
  });

  it('decodes binary UTF-8 chunks', () => {
    const p = createSSEParser();
    const out = p.feed(enc('data: {"type":"token","text":"你好"}\n'));
    assert.equal(out.length, 1);
    assert.equal(out[0].text, '你好');
  });

  it('tolerates CRLF line endings', () => {
    const p = createSSEParser();
    const out = p.feed('data: {"type":"done"}\r\n');
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'done');
  });
});

describe('readSSEStream', () => {
  it('reads a mock Response body stream', async () => {
    const events: unknown[] = [];
    const chunks = [
      enc('data: {"type":"token","text":"a"}\n'),
      enc('data: {"type":"done"}\n'),
    ];
    let i = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(chunks[i++]);
        } else {
          controller.close();
        }
      },
    });
    const resp = new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    });
    await readSSEStream(resp, (ev) => events.push(ev));
    assert.equal(events.length, 2);
    assert.equal((events[0] as { type: string }).type, 'token');
    assert.equal((events[1] as { type: string }).type, 'done');
  });

  it('stops on abort signal', async () => {
    const events: unknown[] = [];
    const ctrl = new AbortController();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(enc('data: {"type":"token","text":"a"}\n'));
        ctrl.abort();
        // leave stream open; abort should cancel
      },
    });
    const resp = new Response(stream);
    await readSSEStream(resp, (ev) => events.push(ev), ctrl.signal);
    // may have 0 or 1 events depending on race; must not throw
    assert.ok(events.length <= 1);
  });
});
