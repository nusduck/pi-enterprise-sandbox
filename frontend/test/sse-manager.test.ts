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
    // Build contiguous cursor 1..5
    for (let i = 1; i <= 5; i += 1) {
      const r = mgr.handleRuntimeEvent(
        makeRuntimeEvent({
          event_id: `e${i}`,
          sequence: i,
          run_id: 'r_seq',
          type: i === 1 ? 'run.started' : 'message.delta',
          payload: i === 1 ? {} : { message_id: 'm', text: String(i) },
        }),
      );
      assert.equal(r.outcome, 'applied');
    }
    assert.equal(mgr.getStore().runsById.r_seq.lastSequence, 5);

    const r3 = mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 'e3_dup',
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
    assert.equal(mgr.getStore().messagesById.m.text, '2345new');
  });
});

describe('sequence gap recovery', () => {
  it('order 1,3,2: gap does not advance cursor; reconnect uses after_sequence=1; then 2/3 apply', async () => {
    const urls: string[] = [];
    let calls = 0;

    const fetchImpl: typeof fetch = async (input, init) => {
      calls += 1;
      urls.push(String(input));
      // Honour abort so gap cancel can end the first stream
      if (init?.signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }

      if (calls === 1) {
        // Live stream: 1 then jump to 3 (gap) — manager cancels reader
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              sseData({
                event_id: 'g1',
                sequence: 1,
                run_id: 'r_gap',
                type: 'run.started',
                payload: {},
              }),
            );
            controller.enqueue(
              sseData({
                event_id: 'g3',
                sequence: 3,
                run_id: 'r_gap',
                type: 'message.delta',
                payload: { message_id: 'm', text: 'three' },
              }),
            );
            // Do not close: next read waits until gap recovery cancels.
          },
          cancel() {
            /* gap recovery */
          },
        });
        return new Response(stream, { status: 200 });
      }

      // Reconnect from after_sequence=1 — deliver missing 2 then 3
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            sseData({
              event_id: 'g2',
              sequence: 2,
              run_id: 'r_gap',
              type: 'message.delta',
              payload: { message_id: 'm', text: 'two' },
            }),
          );
          controller.enqueue(
            sseData({
              event_id: 'g3',
              sequence: 3,
              run_id: 'r_gap',
              type: 'message.delta',
              payload: { message_id: 'm', text: 'three' },
            }),
          );
          controller.enqueue(
            sseData({
              event_id: 'g4',
              sequence: 4,
              run_id: 'r_gap',
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
      maxRetries: 4,
      maxGapRecoveries: 4,
      retryBaseMs: 1,
      retryMaxMs: 5,
      sleep: async () => {},
    });

    mgr.connect('r_gap');
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(calls >= 2, `expected reconnect after gap, calls=${calls}`);
    // Second fetch must resume from last *applied* sequence (1), not jump to 3
    assert.ok(
      urls.some((u) => u.includes('after_sequence=1')),
      `expected after_sequence=1 in ${JSON.stringify(urls)}`,
    );

    const run = mgr.getStore().runsById.r_gap;
    assert.ok(run);
    assert.equal(run.lastSequence, 4);
    assert.equal(mgr.getStore().messagesById.m?.text, 'twothree');
    assert.equal(run.status, 'succeeded');
    mgr.disconnectAll();
  });

  it('gap recovery on one run does not affect another run cursor or connection', async () => {
    const urls: string[] = [];
    let gapRunCalls = 0;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (init?.signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      if (url.includes('r_other')) {
        // Other run: one event then close (finite stream; no hang)
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              sseData({
                event_id: 'o2',
                sequence: 2,
                run_id: 'r_other',
                type: 'message.delta',
                payload: { message_id: 'mo', text: 'ok' },
              }),
            );
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      gapRunCalls += 1;
      if (gapRunCalls === 1) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              sseData({
                event_id: 'x1',
                sequence: 1,
                run_id: 'r_gap_iso',
                type: 'run.started',
                payload: {},
              }),
            );
            controller.enqueue(
              sseData({
                event_id: 'x9',
                sequence: 9,
                run_id: 'r_gap_iso',
                type: 'message.delta',
                payload: { message_id: 'mx', text: 'skip' },
              }),
            );
          },
          cancel() {},
        });
        return new Response(stream, { status: 200 });
      }
      // Second subscription: empty close (finite)
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
      maxGapRecoveries: 1,
      retryBaseMs: 1,
      retryMaxMs: 5,
      sleep: async () => {},
    });

    // Seed other run and connect both
    mgr.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: 'o1',
        sequence: 1,
        run_id: 'r_other',
        type: 'run.started',
      }),
    );
    mgr.connect('r_other');
    mgr.connect('r_gap_iso');
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(mgr.getStore().runsById.r_gap_iso?.lastSequence, 1);
    // Other run still advanced on its own stream; gap on r_gap_iso did not reset it
    assert.equal(mgr.getStore().runsById.r_other?.lastSequence, 2);
    assert.ok(urls.some((u) => u.includes('r_other')));
    assert.ok(urls.some((u) => u.includes('r_gap_iso')));
    mgr.disconnectAll();
  });

  it('duplicate events do not trigger gap reconnect', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const ev = {
            event_id: 'dup1',
            sequence: 1,
            run_id: 'r_dup',
            type: 'run.started',
            payload: {},
          };
          controller.enqueue(sseData(ev));
          controller.enqueue(sseData(ev)); // duplicate
          controller.enqueue(
            sseData({
              event_id: 'dup2',
              sequence: 2,
              run_id: 'r_dup',
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
      maxGapRecoveries: 3,
      retryBaseMs: 1,
      retryMaxMs: 5,
      sleep: async () => {},
    });
    mgr.connect('r_dup');
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(calls, 1, 'duplicates must not force reconnect');
    assert.equal(mgr.getGapRecoveryCount('r_dup'), 0);
    assert.equal(mgr.getStore().runsById.r_dup?.status, 'succeeded');
    mgr.disconnectAll();
  });
});

// silence unused in case tree-shake warnings
void mockFetchSequence;
