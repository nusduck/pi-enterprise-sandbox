/**
 * PR-10: Hybrid SSE (MySQL history + Redis live + watermark catch-up).
 * Offline fakes only — no live MySQL/Redis.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RunEventSseService,
  formatSseDataFrame,
  formatSsePingFrame,
  formatSseEndFrame,
  projectRedisStreamToSseEnvelope,
  resolveSseAfterSequence,
  shouldEmitSequence,
  sleepMs,
  waitForWritableResume,
} from '../../src/application/run-event-sse-service.js';
import { projectRunEventToSseEnvelope } from '../../src/application/run-event-query-service.js';

const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const EVT1 = '01K0G2PAV8FPMVC9QHJG7JPN58';
const EVT2 = '01K0G2PAV8FPMVC9QHJG7JPN59';
const EVT3 = '01K0G2PAV8FPMVC9QHJG7JPN5A';
const EVT4 = '01K0G2PAV8FPMVC9QHJG7JPN5B';

function env(seq, type, eventId) {
  return {
    sequence: seq,
    event: { type, event_type: type, eventId, event_id: eventId },
    ts: 1_000 + seq,
    eventId,
    event_id: eventId,
  };
}

describe('SSE frame formatting (plan §18.4)', () => {
  it('writes id=eventId, event=type, data envelope', () => {
    const frame = formatSseDataFrame(env(18, 'tool.execution.completed', EVT1));
    assert.match(frame, new RegExp(`^id: ${EVT1}\\n`));
    assert.match(frame, /event: tool\.execution\.completed\n/);
    assert.match(frame, /"sequence":18/);
    assert.match(frame, /\n\n$/);
  });

  it('falls back id to sequence when no eventId', () => {
    const frame = formatSseDataFrame({
      sequence: 3,
      event: { type: 'run.started' },
      ts: 1,
    });
    assert.match(frame, /^id: 3\n/);
  });

  it('formats ping and end frames', () => {
    assert.match(formatSsePingFrame('2026-07-18T00:00:00.000Z'), /event: ping/);
    assert.match(formatSseEndFrame('SUCCEEDED'), /event: end/);
    assert.match(formatSseEndFrame('SUCCEEDED'), /SUCCEEDED/);
  });
});

describe('cursor + dedupe helpers', () => {
  it('resolveSseAfterSequence prefers max of after + numeric Last-Event-ID', async () => {
    const n = await resolveSseAfterSequence({
      afterSequence: 5,
      lastEventId: '12',
    });
    assert.equal(n, 12);
  });

  it('resolveSseAfterSequence resolves ULID via callback', async () => {
    const n = await resolveSseAfterSequence({
      afterSequence: 2,
      lastEventId: EVT2,
      resolveEventSequence: async (id) => {
        assert.equal(id, EVT2);
        return 7;
      },
    });
    assert.equal(n, 7);
  });

  it('shouldEmitSequence is strictly greater-than last', () => {
    assert.equal(shouldEmitSequence({ sequence: 5 }, 5), false);
    assert.equal(shouldEmitSequence({ sequence: 6 }, 5), true);
    assert.equal(shouldEmitSequence({ sequence: -1 }, 0), false);
  });

  it('projectRedisStreamToSseEnvelope maps stream fields', () => {
    const e = projectRedisStreamToSseEnvelope({
      eventId: EVT1,
      sequence: '4',
      type: 'run.started',
      payload: JSON.stringify({ status: 'RUNNING' }),
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    assert.equal(e.sequence, 4);
    assert.equal(e.event.type, 'run.started');
    assert.equal(e.eventId, EVT1);
  });

  it('projectRunEventToSseEnvelope exposes top-level eventId', () => {
    const e = projectRunEventToSseEnvelope({
      sequenceNo: 2,
      eventType: 'run.queued',
      eventId: EVT1,
      payloadJson: { status: 'QUEUED' },
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    assert.equal(e.sequence, 2);
    assert.equal(e.eventId, EVT1);
    assert.equal(e.event.type, 'run.queued');
  });
});

describe('RunEventSseService hybrid openStream', () => {
  it('replays MySQL history then ends when terminal with no gap', async () => {
    const events = [
      env(1, 'run.accepted', EVT1),
      env(2, 'run.queued', EVT2),
      env(3, 'run.completed', EVT3),
    ];
    const eventQueryService = {
      async listEvents({ afterSequence = 0 }) {
        const page = events.filter((e) => e.sequence > afterSequence);
        return {
          events: page,
          terminal: true,
          status: 'SUCCEEDED',
        };
      },
    };
    const svc = new RunEventSseService({
      eventQueryService,
      runEventStream: null,
      pollMs: 5,
      heartbeatMs: 60_000,
    });
    const frames = [];
    const result = await svc.openStream(
      { runId: RUN, auth: { externalOrgId: 'o', externalUserId: 'u' }, afterSequence: 0 },
      {
        write: (c) => {
          frames.push(c);
          return true;
        },
        isClosed: () => false,
      },
    );
    assert.equal(result.lastSequence, 3);
    const joined = frames.join('');
    assert.match(joined, /run\.accepted/);
    assert.match(joined, /run\.completed/);
    assert.match(joined, /event: end/);
    // No duplicates
    assert.equal((joined.match(/"sequence":1/g) || []).length, 1);
    assert.equal((joined.match(/"sequence":2/g) || []).length, 1);
    assert.equal((joined.match(/"sequence":3/g) || []).length, 1);
  });

  it('dedupes Redis live against MySQL history by sequence', async () => {
    let mysqlCalls = 0;
    const mysql = [
      env(1, 'run.accepted', EVT1),
      env(2, 'run.queued', EVT2),
    ];
    // Redis re-notifies seq 2 and adds 3 (overlap + new).
    const redisEntries = [
      {
        streamId: '1-0',
        eventId: EVT2,
        sequence: '2',
        type: 'run.queued',
        payload: '{}',
        createdAt: '2026-07-18T00:00:00.000Z',
      },
      {
        streamId: '1-1',
        eventId: EVT3,
        sequence: '3',
        type: 'run.started',
        payload: '{}',
        createdAt: '2026-07-18T00:00:01.000Z',
      },
    ];
    let livePhase = false;
    const eventQueryService = {
      async listEvents({ afterSequence = 0 }) {
        mysqlCalls += 1;
        if (!livePhase) {
          const page = mysql.filter((e) => e.sequence > afterSequence);
          return { events: page, terminal: false, status: 'RUNNING' };
        }
        // After live: terminal empty once seq>=3
        if (afterSequence >= 3) {
          return { events: [], terminal: true, status: 'SUCCEEDED' };
        }
        return {
          events: [env(3, 'run.started', EVT3)].filter((e) => e.sequence > afterSequence),
          terminal: true,
          status: 'SUCCEEDED',
        };
      },
    };
    const runEventStream = {
      async readAfter(_runId, { afterId = '0-0' } = {}) {
        livePhase = true;
        if (afterId === '0-0') return redisEntries;
        return [];
      },
    };
    const svc = new RunEventSseService({
      eventQueryService,
      runEventStream,
      pollMs: 5,
      heartbeatMs: 60_000,
      mysqlCatchupMs: 1,
    });
    const frames = [];
    let closed = false;
    // Close after enough ticks so terminal catch-up can fire.
    setTimeout(() => {
      closed = true;
    }, 80);
    await svc.openStream(
      { runId: RUN, auth: { externalOrgId: 'o', externalUserId: 'u' }, afterSequence: 0 },
      {
        write: (c) => {
          frames.push(c);
          return true;
        },
        isClosed: () => closed,
      },
    );
    const joined = frames.join('');
    // seq 2 only once despite Redis overlap
    assert.equal((joined.match(/"sequence":2/g) || []).length, 1);
    assert.match(joined, /"sequence":3/);
    assert.ok(mysqlCalls >= 2, 'expected history + catch-up MySQL reads');
  });

  it('MySQL catch-up closes gap when Redis misses an event', async () => {
    // History has 1; Redis only has 3; MySQL catch-up must deliver 2 then 3.
    const all = [
      env(1, 'run.accepted', EVT1),
      env(2, 'message.delta', EVT2),
      env(3, 'run.completed', EVT3),
    ];
    let phase = 'history';
    const eventQueryService = {
      async listEvents({ afterSequence = 0 }) {
        if (phase === 'history') {
          // First drain returns only seq 1
          const page = all.filter((e) => e.sequence > afterSequence && e.sequence <= 1);
          if (afterSequence >= 1) {
            phase = 'live';
            return { events: [], terminal: false, status: 'RUNNING' };
          }
          return { events: page, terminal: false, status: 'RUNNING' };
        }
        // Catch-up / live MySQL: remaining events
        const page = all.filter((e) => e.sequence > afterSequence);
        return {
          events: page,
          terminal: page.length === 0 || afterSequence >= 3,
          status: afterSequence >= 3 || page.some((e) => e.sequence === 3) ? 'SUCCEEDED' : 'RUNNING',
        };
      },
    };
    const runEventStream = {
      async readAfter() {
        phase = 'live';
        // Only seq 3 on Redis — 2 must come from MySQL catch-up.
        return [
          {
            streamId: '9-0',
            eventId: EVT3,
            sequence: '3',
            type: 'run.completed',
            payload: '{}',
            createdAt: '2026-07-18T00:00:00.000Z',
          },
        ];
      },
    };
    const svc = new RunEventSseService({
      eventQueryService,
      runEventStream,
      pollMs: 5,
      heartbeatMs: 60_000,
      mysqlCatchupMs: 1,
    });
    const frames = [];
    const result = await svc.openStream(
      { runId: RUN, auth: { externalOrgId: 'o', externalUserId: 'u' }, afterSequence: 0 },
      {
        write: (c) => {
          frames.push(c);
          return true;
        },
        isClosed: () => false,
      },
    );
    const joined = frames.join('');
    assert.match(joined, /"sequence":1/);
    assert.match(joined, /"sequence":2/);
    assert.match(joined, /"sequence":3/);
    assert.equal(result.lastSequence, 3);
  });

  it('falls back to MySQL poll when Redis readAfter throws', async () => {
    const events = [env(1, 'run.accepted', EVT1), env(2, 'run.completed', EVT4)];
    let calls = 0;
    const eventQueryService = {
      async listEvents({ afterSequence = 0 }) {
        calls += 1;
        const page = events.filter((e) => e.sequence > afterSequence);
        return {
          events: page,
          terminal: true,
          status: 'SUCCEEDED',
        };
      },
    };
    const runEventStream = {
      async readAfter() {
        throw new Error('redis down');
      },
    };
    const svc = new RunEventSseService({
      eventQueryService,
      runEventStream,
      pollMs: 5,
      heartbeatMs: 60_000,
    });
    const frames = [];
    await svc.openStream(
      { runId: RUN, auth: { externalOrgId: 'o', externalUserId: 'u' }, afterSequence: 0 },
      {
        write: (c) => {
          frames.push(c);
          return true;
        },
        isClosed: () => false,
      },
    );
    const joined = frames.join('');
    assert.match(joined, /run\.accepted/);
    assert.match(joined, /run\.completed/);
    assert.ok(calls >= 1);
  });

  it('respects afterSequence resume (no earlier events)', async () => {
    const events = [
      env(1, 'run.accepted', EVT1),
      env(2, 'run.queued', EVT2),
      env(3, 'run.completed', EVT3),
    ];
    const eventQueryService = {
      async listEvents({ afterSequence = 0 }) {
        return {
          events: events.filter((e) => e.sequence > afterSequence),
          terminal: true,
          status: 'SUCCEEDED',
        };
      },
    };
    const svc = new RunEventSseService({
      eventQueryService,
      pollMs: 5,
      heartbeatMs: 60_000,
    });
    const frames = [];
    await svc.openStream(
      { runId: RUN, auth: { externalOrgId: 'o', externalUserId: 'u' }, afterSequence: 1 },
      {
        write: (c) => {
          frames.push(c);
          return true;
        },
        isClosed: () => false,
      },
    );
    const joined = frames.join('');
    assert.doesNotMatch(joined, /"sequence":1/);
    assert.match(joined, /"sequence":2/);
    assert.match(joined, /"sequence":3/);
  });

  it('abort signal ends stream without throwing cancel side effects', async () => {
    const ac = new AbortController();
    const eventQueryService = {
      async listEvents() {
        return { events: [], terminal: false, status: 'RUNNING' };
      },
    };
    const svc = new RunEventSseService({
      eventQueryService,
      pollMs: 10,
      heartbeatMs: 60_000,
      sleep: async (_ms, signal) => {
        ac.abort();
        if (signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
      },
    });
    const result = await svc.openStream(
      { runId: RUN, auth: { externalOrgId: 'o', externalUserId: 'u' }, afterSequence: 0 },
      {
        write: () => true,
        isClosed: () => false,
        signal: ac.signal,
      },
    );
    assert.equal(typeof result.lastSequence, 'number');
  });
});

describe('async backpressure + sleep listener hygiene', () => {
  it('write(false) blocks next event until drain; then continues', async () => {
    const events = [
      env(1, 'run.accepted', EVT1),
      env(2, 'run.queued', EVT2),
      env(3, 'run.completed', EVT3),
    ];
    const eventQueryService = {
      async listEvents({ afterSequence = 0 }) {
        return {
          events: events.filter((e) => e.sequence > afterSequence),
          terminal: true,
          status: 'SUCCEEDED',
        };
      },
    };

    let writeCount = 0;
    /** @type {((v: 'drained'|'closed'|'aborted') => void) | null} */
    let resolveDrain = null;
    let drainWaits = 0;
    const frames = [];
    let sawSeq2BeforeDrain = false;

    const svc = new RunEventSseService({
      eventQueryService,
      pollMs: 5,
      heartbeatMs: 60_000,
    });

    const streamPromise = svc.openStream(
      { runId: RUN, auth: { externalOrgId: 'o', externalUserId: 'u' }, afterSequence: 0 },
      {
        write: (c) => {
          writeCount += 1;
          frames.push(c);
          // First data frame backpressures; later frames OK.
          if (writeCount === 1) return false;
          return true;
        },
        waitDrain: () => {
          drainWaits += 1;
          // Before drain resolves, only seq 1 should be written (no seq 2 yet).
          if (frames.some((f) => f.includes('"sequence":2'))) {
            sawSeq2BeforeDrain = true;
          }
          return new Promise((resolve) => {
            resolveDrain = resolve;
          });
        },
        isClosed: () => false,
      },
    );

    // Wait until first write blocked on drain.
    for (let i = 0; i < 50 && drainWaits === 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(drainWaits, 1, 'expected one drain wait after write(false)');
    assert.equal(sawSeq2BeforeDrain, false, 'must not emit seq 2 before drain');
    assert.match(frames.join(''), /"sequence":1/);
    assert.doesNotMatch(frames.join(''), /"sequence":2/);

    resolveDrain('drained');
    const result = await streamPromise;
    assert.equal(result.lastSequence, 3);
    const joined = frames.join('');
    assert.match(joined, /"sequence":2/);
    assert.match(joined, /"sequence":3/);
    assert.equal(sawSeq2BeforeDrain, false);
  });

  it('close during drain ends promptly without waiting forever', async () => {
    const events = [
      env(1, 'run.accepted', EVT1),
      env(2, 'run.queued', EVT2),
    ];
    const eventQueryService = {
      async listEvents({ afterSequence = 0 }) {
        return {
          events: events.filter((e) => e.sequence > afterSequence),
          terminal: false,
          status: 'RUNNING',
        };
      },
    };

    let closed = false;
    /** @type {((v: 'drained'|'closed'|'aborted') => void) | null} */
    let resolveDrain = null;
    const svc = new RunEventSseService({
      eventQueryService,
      pollMs: 5,
      heartbeatMs: 60_000,
    });

    const started = Date.now();
    const streamPromise = svc.openStream(
      { runId: RUN, auth: { externalOrgId: 'o', externalUserId: 'u' }, afterSequence: 0 },
      {
        write: () => false, // always backpressure
        waitDrain: () =>
          new Promise((resolve) => {
            resolveDrain = resolve;
          }),
        isClosed: () => closed,
      },
    );

    for (let i = 0; i < 50 && !resolveDrain; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(resolveDrain, 'stuck waiting for drain');
    closed = true;
    resolveDrain('closed');
    const result = await streamPromise;
    assert.ok(Date.now() - started < 2_000, 'must not hang on close during drain');
    // First write(false) still advances sequence after queuing.
    assert.equal(result.lastSequence, 1);
  });

  it('sleepMs removes abort listener after normal timeout (no growth)', async () => {
    const ac = new AbortController();
    let addCount = 0;
    let removeCount = 0;
    const realAdd = ac.signal.addEventListener.bind(ac.signal);
    const realRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = (type, fn, opts) => {
      if (type === 'abort') addCount += 1;
      return realAdd(type, fn, opts);
    };
    ac.signal.removeEventListener = (type, fn, opts) => {
      if (type === 'abort') removeCount += 1;
      return realRemove(type, fn, opts);
    };

    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleepMs(5, ac.signal);
    }
    assert.equal(addCount, 8);
    assert.equal(removeCount, 8, 'each completed sleep must drop its abort listener');
  });

  it('waitForWritableResume removes stream listeners on drain', async () => {
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
    assert.ok(listeners.get('drain')?.size === 1);
    assert.ok(listeners.get('close')?.size === 1);
    // Fire drain
    for (const fn of [...(listeners.get('drain') || [])]) fn();
    assert.equal(await p, 'drained');
    assert.equal(listeners.get('drain')?.size ?? 0, 0);
    assert.equal(listeners.get('close')?.size ?? 0, 0);
    assert.equal(listeners.get('error')?.size ?? 0, 0);
  });

  it('long live poll does not accumulate abort listeners across sleeps', async () => {
    let polls = 0;
    const ac = new AbortController();
    let addCount = 0;
    let removeCount = 0;
    const realAdd = ac.signal.addEventListener.bind(ac.signal);
    const realRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = (type, fn, opts) => {
      if (type === 'abort') addCount += 1;
      return realAdd(type, fn, opts);
    };
    ac.signal.removeEventListener = (type, fn, opts) => {
      if (type === 'abort') removeCount += 1;
      return realRemove(type, fn, opts);
    };

    const eventQueryService = {
      async listEvents() {
        polls += 1;
        if (polls >= 6) {
          // End after several empty live polls.
          return { events: [], terminal: true, status: 'SUCCEEDED' };
        }
        return { events: [], terminal: false, status: 'RUNNING' };
      },
    };
    const svc = new RunEventSseService({
      eventQueryService,
      pollMs: 5,
      heartbeatMs: 60_000,
      mysqlCatchupMs: 1,
      // Use real sleepMs so listener accounting is exercised.
      sleep: sleepMs,
    });

    await svc.openStream(
      { runId: RUN, auth: { externalOrgId: 'o', externalUserId: 'u' }, afterSequence: 0 },
      {
        write: () => true,
        isClosed: () => false,
        signal: ac.signal,
      },
    );

    assert.ok(addCount >= 3, `expected multiple sleeps, addCount=${addCount}`);
    assert.equal(
      addCount,
      removeCount,
      `abort listeners leaked: add=${addCount} remove=${removeCount}`,
    );
  });
});
