/**
 * Per-run SSE Manager — Last-Event-ID, reconnect, dedupe, multi-run isolation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityStore } from '../src/entities/index.ts';
import { createRunSSEManager } from '../src/shared/sse/manager.ts';
import { makeRuntimeEvent } from '../src/shared/schemas/events.ts';

function enc(str: string) {
  return new TextEncoder().encode(str);
}

function sseData(obj: unknown): Uint8Array {
  return enc(`data: ${JSON.stringify(obj)}\n`);
}

function mockFetchSequence(
  chunksList: Array<Uint8Array[] | Error>,
): typeof fetch {
  let call = 0;
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const idx = call++;
    const item = chunksList[Math.min(idx, chunksList.length - 1)];
    if (item instanceof Error) throw item;

    // Honour abort
    if (init?.signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }

    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (init?.signal?.aborted) {
          controller.close();
          return;
        }
        if (i < item.length) {
          controller.enqueue(item[i++]);
        } else {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
}

describe('RunSSEManager handleEvent (pure path)', () => {
  it('applies events and tracks lastEventId per run', () => {
    const store = createEntityStore();
    const mgr = createRunSSEManager(store);

    mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 'e1',
        sequence: 1,
        run_id: 'r1',
        type: 'run.started',
      }),
    );
    mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 'e2',
        sequence: 2,
        run_id: 'r1',
        type: 'message.delta',
        payload: { message_id: 'm1', text: 'hi' },
      }),
    );

    const s = mgr.getStore();
    assert.equal(s.runsById.r1.lastEventId, 'e2');
    assert.equal(s.runsById.r1.lastSequence, 2);
    assert.equal(s.messagesById.m1.text, 'hi');

    const conn = mgr.getConnection('r1');
    assert.ok(conn);
    assert.equal(conn!.lastEventId, 'e2');
    assert.ok(conn!.seenEventIds.has('e1'));
    assert.ok(conn!.seenEventIds.has('e2'));
  });

  it('dedupes repeated event_ids across reconnect simulation', () => {
    const mgr = createRunSSEManager(createEntityStore());
    const event = makeRuntimeEvent({
      event_id: 'same',
      sequence: 1,
      run_id: 'r1',
      type: 'run.started',
    });
    assert.equal(mgr.handleRuntimeEvent(event).outcome, 'applied');
    assert.equal(mgr.handleRuntimeEvent(event).outcome, 'duplicate');
    assert.equal(mgr.getStore().runsById.r1.lastSequence, 1);
  });

  it('keeps multi-run status independent', () => {
    const mgr = createRunSSEManager(createEntityStore());
    mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 'a1',
        sequence: 1,
        run_id: 'ra',
        type: 'run.started',
      }),
    );
    mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 'b1',
        sequence: 1,
        run_id: 'rb',
        type: 'run.started',
      }),
    );
    mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 'a2',
        sequence: 2,
        run_id: 'ra',
        type: 'run.completed',
      }),
    );
    mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 'b2',
        sequence: 2,
        run_id: 'rb',
        type: 'run.failed',
        payload: { message: 'boom' },
      }),
    );

    const s = mgr.getStore();
    assert.equal(s.runsById.ra.status, 'succeeded');
    assert.equal(s.runsById.rb.status, 'failed');
    assert.equal(s.runsById.rb.error, 'boom');
  });

  it('disconnect one run does not affect another', () => {
    const mgr = createRunSSEManager(createEntityStore(), {
      // Prevent real network
      fetchImpl: async () => {
        throw new Error('no network in unit test');
      },
      maxRetries: 0,
      sleep: async () => {},
    });

    // Seed connections via handleEvent
    mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 'x1',
        sequence: 1,
        run_id: 'rx',
        type: 'run.started',
      }),
    );
    mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 'y1',
        sequence: 1,
        run_id: 'ry',
        type: 'run.started',
      }),
    );

    mgr.disconnect('rx');
    assert.equal(mgr.getConnection('rx')?.connectionStatus, 'closed');
    // ry still tracked
    assert.ok(mgr.getStore().runsById.ry);
    assert.notEqual(mgr.getConnection('ry')?.connectionStatus, 'closed');
  });
});

describe('RunSSEManager stream + Last-Event-ID', () => {
  it('sends Last-Event-ID header on reconnect resume', async () => {
    const headersSeen: Array<Record<string, string>> = [];
    let calls = 0;

    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      const h = (init?.headers || {}) as Record<string, string>;
      headersSeen.push({ ...h });

      if (calls === 1) {
        // First connection delivers one event then ends → triggers reconnect
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              sseData({
                event_id: 'e1',
                sequence: 1,
                run_id: 'r_resume',
                type: 'run.started',
                payload: {},
              }),
            );
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }

      // Second connection: should include Last-Event-ID
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            sseData({
              event_id: 'e2',
              sequence: 2,
              run_id: 'r_resume',
              type: 'run.completed',
              payload: {},
            }),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };

    const mgr = createRunSSEManager(createEntityStore(), {
      fetchImpl,
      maxRetries: 3,
      retryBaseMs: 1,
      retryMaxMs: 5,
      sleep: async () => {},
    });

    mgr.connect('r_resume');

    // Wait for both connections
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(calls >= 2, `expected >=2 fetch calls, got ${calls}`);
    // Second call should carry Last-Event-ID from e1
    const second = headersSeen[1] || {};
    const lastId =
      second['Last-Event-ID'] ||
      second['last-event-id'] ||
      Object.entries(second).find(([k]) => k.toLowerCase() === 'last-event-id')?.[1];
    assert.equal(lastId, 'e1');

    // Terminal event should close
    assert.equal(mgr.getStore().runsById.r_resume?.status, 'succeeded');
    mgr.disconnectAll();
  });

  it('does not auto-connect other runs when one connects', async () => {
    let urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        { status: 200 },
      );
    };

    const mgr = createRunSSEManager(createEntityStore(), {
      fetchImpl,
      maxRetries: 0,
      sleep: async () => {},
    });

    // Seed two runs in store
    mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 's1',
        sequence: 1,
        run_id: 'only_me',
        type: 'run.started',
      }),
    );
    mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 's2',
        sequence: 1,
        run_id: 'other',
        type: 'run.started',
      }),
    );

    mgr.connect('only_me');
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes('only_me'));
    assert.ok(!urls[0].includes('other'));
    mgr.disconnectAll();
  });
});

describe('sequence resume after rehydrate', () => {
  it('skips already-seen sequences when feeding resumed events', () => {
    const mgr = createRunSSEManager(createEntityStore());
    // Simulate rehydrate cursor
    mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 'e5',
        sequence: 5,
        run_id: 'r_seq',
        type: 'run.started',
      }),
    );
    // Force lastSequence to 5 via applied event; now feed 3,4,6
    const r3 = mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 'e3',
        sequence: 3,
        run_id: 'r_seq',
        type: 'message.delta',
        payload: { text: 'old' },
      }),
    );
    assert.equal(r3.outcome, 'out_of_order');

    const r6 = mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 'e6',
        sequence: 6,
        run_id: 'r_seq',
        type: 'message.delta',
        payload: { message_id: 'm', text: 'new' },
      }),
    );
    assert.equal(r6.outcome, 'applied');
    assert.equal(mgr.getStore().messagesById.m.text, 'new');
  });
});

// silence unused in case tree-shake warnings
void mockFetchSequence;
