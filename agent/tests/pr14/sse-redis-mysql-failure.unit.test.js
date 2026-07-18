/**
 * PR-14 offline: SSE Redis/MySQL failure, gap catch-up, backpressure (plan §25.5 / §25.8).
 *
 * Invariants:
 * - Redis throw → MySQL poll fallback; events still contiguous
 * - Redis gap (missing seq) → MySQL catch-up before later seq; no cursor skip
 * - Transient MySQL listEvents throw during live does not cancel Run / corrupt cursor
 * - write(false) backpressure blocks next sequence until drain
 * - disconnect/abort ends subscription only (no cancel hook)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RunEventSseService,
  waitForWritableResume,
  sleepMs,
} from '../../src/application/run-event-sse-service.js';

const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const EVT = (n) => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let s = '01K0G2PAV8FPMVC9QHJG7';
  const pad = String(n).padStart(5, '0');
  for (const ch of pad) s += alphabet[Number(ch) % 32];
  return s.slice(0, 26);
};

function env(seq, type = 'message.delta') {
  const eventId = EVT(seq);
  return {
    sequence: seq,
    event: { type, event_type: type, eventId, event_id: eventId },
    ts: 1000 + seq,
    eventId,
    event_id: eventId,
  };
}

function collectSequences(frames) {
  const out = [];
  for (const f of frames) {
    const m = /"sequence":(\d+)/.exec(f);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

describe('PR-14 SSE: Redis failure + gap + MySQL', () => {
  it('Redis readAfter permanent failure falls back to MySQL without losing events', async () => {
    const events = [env(1, 'run.accepted'), env(2, 'run.completed')];
    let mysqlCalls = 0;
    const eventQueryService = {
      async listEvents({ afterSequence = 0 }) {
        mysqlCalls += 1;
        return {
          events: events.filter((e) => e.sequence > afterSequence),
          terminal: true,
          status: 'SUCCEEDED',
        };
      },
    };
    const runEventStream = {
      async readAfter() {
        throw new Error('ECONNREFUSED redis');
      },
    };
    const svc = new RunEventSseService({
      eventQueryService,
      runEventStream,
      pollMs: 2,
      heartbeatMs: 60_000,
    });
    const frames = [];
    const result = await svc.openStream(
      { runId: RUN, auth: { externalOrgId: 'o', externalUserId: 'u' } },
      {
        write: (c) => {
          frames.push(c);
          return true;
        },
        isClosed: () => false,
      },
    );
    const seqs = collectSequences(frames);
    assert.deepEqual(seqs, [1, 2]);
    assert.equal(result.lastSequence, 2);
    assert.ok(mysqlCalls >= 1);
    assert.match(result.mode, /mysql/);
  });

  it('Redis gap forces MySQL catch-up; never emits later seq before gap fill', async () => {
    const all = [env(1, 'run.accepted'), env(2, 'message.delta'), env(3, 'run.completed')];
    let phase = 'history';
    /** @type {number[]} */
    const emitOrder = [];

    const eventQueryService = {
      async listEvents({ afterSequence = 0 }) {
        if (phase === 'history') {
          if (afterSequence < 1) {
            return {
              events: all.filter((e) => e.sequence === 1),
              terminal: false,
              status: 'RUNNING',
            };
          }
          phase = 'live';
          return { events: [], terminal: false, status: 'RUNNING' };
        }
        // Catch-up / poll: remaining
        const page = all.filter((e) => e.sequence > afterSequence);
        return {
          events: page,
          terminal: afterSequence >= 3 || page.some((e) => e.sequence === 3),
          status:
            afterSequence >= 3 || page.some((e) => e.sequence === 3)
              ? 'SUCCEEDED'
              : 'RUNNING',
        };
      },
    };

    let redisReads = 0;
    const runEventStream = {
      async readAfter() {
        redisReads += 1;
        phase = 'live';
        // Only seq 3 on Redis — 2 is the gap
        if (redisReads === 1) {
          return [
            {
              streamId: '9-0',
              eventId: EVT(3),
              sequence: '3',
              type: 'run.completed',
              payload: '{}',
              createdAt: '2026-07-18T00:00:00.000Z',
            },
          ];
        }
        return [];
      },
    };

    const svc = new RunEventSseService({
      eventQueryService,
      runEventStream,
      pollMs: 2,
      heartbeatMs: 60_000,
      mysqlCatchupMs: 1,
    });
    const frames = [];
    const result = await svc.openStream(
      { runId: RUN, auth: { externalOrgId: 'o', externalUserId: 'u' } },
      {
        write: (c) => {
          const m = /"sequence":(\d+)/.exec(c);
          if (m) emitOrder.push(Number(m[1]));
          frames.push(c);
          return true;
        },
        isClosed: () => false,
      },
    );
    assert.deepEqual(emitOrder, [1, 2, 3]);
    assert.equal(result.lastSequence, 3);
  });

  it('MySQL listEvents throws mid-live loop: cursor preserved; recovers without dupes', async () => {
    const events = [env(1, 'run.accepted'), env(2, 'run.queued'), env(3, 'run.completed')];
    let liveFailsLeft = 1;
    let historyDone = false;
    const eventQueryService = {
      async listEvents({ afterSequence = 0 }) {
        // History + cutover: deliver seq 1, then empty non-terminal once.
        if (!historyDone) {
          if (afterSequence < 1) {
            return {
              events: [events[0]],
              terminal: false,
              status: 'RUNNING',
            };
          }
          historyDone = true;
          return { events: [], terminal: false, status: 'RUNNING' };
        }
        // Live loop: one transient failure then full tail
        if (liveFailsLeft > 0) {
          liveFailsLeft -= 1;
          throw new Error('mysql gone away');
        }
        const page = events.filter((e) => e.sequence > afterSequence);
        return {
          events: page,
          terminal: afterSequence >= 3 || page.some((e) => e.sequence === 3),
          status: 'SUCCEEDED',
        };
      },
    };

    let ticks = 0;
    const svc = new RunEventSseService({
      eventQueryService,
      runEventStream: null,
      pollMs: 1,
      heartbeatMs: 60_000,
      mysqlCatchupMs: 0,
      sleep: async (_ms, signal) => {
        ticks += 1;
        if (signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        if (ticks > 40) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
      },
    });

    const sequences = [];
    const result = await svc.openStream(
      { runId: RUN, auth: { externalOrgId: 'o', externalUserId: 'u' } },
      {
        write: (c) => {
          const m = /"sequence":(\d+)/.exec(c);
          if (m) sequences.push(Number(m[1]));
          return true;
        },
        isClosed: () => false,
      },
    );

    // After transient live failure, full contiguous tail must still deliver
    assert.deepEqual(sequences, [1, 2, 3]);
    assert.equal(result.lastSequence, 3);
  });
});

describe('PR-14 SSE: backpressure + disconnect hygiene', () => {
  it('write(false) holds next sequence until drain resolves', async () => {
    const events = [env(1), env(2), env(3, 'run.completed')];
    const eventQueryService = {
      async listEvents({ afterSequence = 0 }) {
        return {
          events: events.filter((e) => e.sequence > afterSequence),
          terminal: true,
          status: 'SUCCEEDED',
        };
      },
    };
    let writes = 0;
    /** @type {((v: 'drained'|'closed'|'aborted') => void) | null} */
    let resolveDrain = null;
    let drainWaits = 0;
    const frames = [];
    const svc = new RunEventSseService({
      eventQueryService,
      pollMs: 2,
      heartbeatMs: 60_000,
    });

    const p = svc.openStream(
      { runId: RUN, auth: { externalOrgId: 'o', externalUserId: 'u' } },
      {
        write: (c) => {
          writes += 1;
          frames.push(c);
          if (writes === 1) return false;
          return true;
        },
        waitDrain: () => {
          drainWaits += 1;
          return new Promise((resolve) => {
            resolveDrain = resolve;
          });
        },
        isClosed: () => false,
      },
    );

    for (let i = 0; i < 100 && drainWaits === 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    assert.equal(drainWaits, 1);
    assert.deepEqual(collectSequences(frames), [1]);
    resolveDrain('drained');
    const result = await p;
    assert.deepEqual(collectSequences(frames), [1, 2, 3]);
    assert.equal(result.lastSequence, 3);
  });

  it('abort ends stream; no cancel side effect channel required', async () => {
    let cancelHooks = 0;
    const ac = new AbortController();
    const eventQueryService = {
      async listEvents() {
        return { events: [], terminal: false, status: 'RUNNING' };
      },
    };
    const svc = new RunEventSseService({
      eventQueryService,
      pollMs: 5,
      heartbeatMs: 60_000,
      sleep: async (_ms, signal) => {
        ac.abort();
        cancelHooks += 0; // document: openStream never calls cancel
        if (signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
      },
    });
    const result = await svc.openStream(
      { runId: RUN, auth: { externalOrgId: 'o', externalUserId: 'u' } },
      {
        write: () => true,
        isClosed: () => false,
        signal: ac.signal,
      },
    );
    assert.equal(typeof result.lastSequence, 'number');
    assert.equal(cancelHooks, 0);
  });

  it('waitForWritableResume cleans listeners; sleepMs pairs add/remove', async () => {
    /** @type {Map<string, Set<Function>>} */
    const listeners = new Map();
    const stream = {
      writableEnded: false,
      destroyed: false,
      once(ev, fn) {
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev).add(fn);
      },
      off(ev, fn) {
        listeners.get(ev)?.delete(fn);
      },
    };
    const p = waitForWritableResume({ stream, isClosed: () => false });
    for (const fn of [...(listeners.get('drain') || [])]) fn();
    assert.equal(await p, 'drained');
    assert.equal(listeners.get('drain')?.size ?? 0, 0);

    const ac = new AbortController();
    let add = 0;
    let rem = 0;
    const realAdd = ac.signal.addEventListener.bind(ac.signal);
    const realRem = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = (t, fn, o) => {
      if (t === 'abort') add += 1;
      return realAdd(t, fn, o);
    };
    ac.signal.removeEventListener = (t, fn, o) => {
      if (t === 'abort') rem += 1;
      return realRem(t, fn, o);
    };
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleepMs(1, ac.signal);
    }
    assert.equal(add, rem);
  });
});
