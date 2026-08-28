/**
 * Regression: the A2A projector must understand the RunEvent vocabulary the
 * Run services actually emit.
 *
 * 2026-08-26 real-user-scenario R1: `message/stream` and `tasks/resubscribe`
 * ended after `submitted` / `working` with no `final: true` frame, while
 * `tasks/get` reported `completed`. Root cause: the projector's run-status set
 * listed `run.succeeded` / `run.status` / `run.terminal` — none of which any
 * service emits — while the real terminal event is `run.completed` and the
 * generic transition event is `run.status.changed`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  projectEnvelopeToA2aResult,
  buildA2aTaskObject,
  RUN_STATUS_EVENT_TYPES,
} from '../../src/application/a2a/event-projector.js';
import { A2aStreamService } from '../../src/application/a2a/stream-service.js';
import { assertOfficialStreamGrammar } from '../../src/application/a2a/stream-event-schema.js';
import { A2A_METHODS } from '../../src/application/a2a/json-rpc.js';

const TASK = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN4A';
const EVT1 = '01K0G2PAV8FPMVC9QHJG7JPN58';
const EVT2 = '01K0G2PAV8FPMVC9QHJG7JPN59';
const EVT3 = '01K0G2PAV8FPMVC9QHJG7JPN5B';
const MSG = '01K0G2PAV8FPMVC9QHJG7JPN5A';
const EVT4 = '01K0G2PAV8FPMVC9QHJG7JPN5H';

const ctx = { a2aTaskId: TASK, contextId: CONV };

function parseDataLines(frames) {
  return frames
    .join('')
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
}

/** The exact envelope shape `projectRunEventToSseEnvelope` produces. */
function envelope(sequence, eventId, eventType, payload, ts = sequence) {
  return {
    sequence,
    event_id: eventId,
    ts,
    event: { type: eventType, event_id: eventId, ...payload },
  };
}

describe('A2A projector understands the emitted RunEvent vocabulary', () => {
  it('projects run.completed to a terminal status-update', () => {
    const out = projectEnvelopeToA2aResult(
      envelope(5, EVT4, 'run.completed', {
        from: 'RUNNING',
        to: 'SUCCEEDED',
        status: 'SUCCEEDED',
      }),
      { ...ctx, lastA2aStatus: 'working' },
    );
    assert.ok(out, 'run.completed must project to an A2A stream result');
    assert.equal(out.kind, 'status-update');
    assert.equal(out.result.status.state, 'completed');
    assert.equal(out.result.final, true);
  });

  it('projects run.status.changed from its durable payload status', () => {
    const out = projectEnvelopeToA2aResult(
      envelope(3, EVT3, 'run.status.changed', {
        from: 'STARTING',
        to: 'RUNNING',
        status: 'RUNNING',
      }),
      { ...ctx, lastA2aStatus: 'submitted' },
    );
    assert.ok(out, 'run.status.changed must project to an A2A stream result');
    assert.equal(out.result.status.state, 'working');
    assert.equal(out.result.final, false);
  });

  it('projects run.status.changed onto auth-required while parked on approval', () => {
    const out = projectEnvelopeToA2aResult(
      envelope(4, EVT3, 'run.status.changed', {
        from: 'RUNNING',
        to: 'WAITING_APPROVAL',
        status: 'WAITING_APPROVAL',
      }),
      { ...ctx, lastA2aStatus: 'working' },
    );
    assert.ok(out);
    assert.equal(out.result.status.state, 'auth-required');
    assert.equal(out.result.final, false);
  });

  it('projects a live message.completed whose payload nests under data', () => {
    // Shape captured from a real Run's journal (observability projector writes
    // `{ context, data }`): role/message/messageId sit one level down.
    const out = projectEnvelopeToA2aResult(
      envelope(54, MSG, 'message.completed', {
        context: { runId: RUN, traceId: 'x' },
        data: {
          role: 'assistant',
          messageId: `assistant:${RUN}:seq2`,
          message: {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'text', text: 'LIVE_VERIFY_OK', truncated: false }],
          },
        },
      }),
      { ...ctx, lastA2aStatus: 'working' },
    );
    assert.ok(out, 'nested message.completed must project');
    assert.equal(out.kind, 'status-update');
    assert.equal(out.result.status.state, 'working');
    assert.equal(out.result.final, false);
    assert.equal(out.result.status.message.role, 'agent');
    assert.equal(out.result.status.message.messageId, `assistant:${RUN}:seq2`);
    assert.equal(out.result.status.message.parts[0].text, 'LIVE_VERIFY_OK');
  });

  it('does not project user or toolResult turns as agent messages', () => {
    for (const role of ['user', 'toolResult']) {
      const out = projectEnvelopeToA2aResult(
        envelope(6, MSG, 'message.completed', {
          context: { runId: RUN },
          data: {
            role,
            message: { role, content: [{ type: 'text', text: 'not the agent' }] },
          },
        }),
        { ...ctx, lastA2aStatus: 'working' },
      );
      assert.equal(out, null, `${role} must not project`);
    }
  });

  it('every run.* eventType emitted by src is projectable', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const appDir = path.resolve(here, '../../src/application');
    /** @type {Set<string>} */
    const emitted = new Set();
    for (const name of readdirSync(appDir)) {
      if (!name.endsWith('.js')) continue;
      const source = readFileSync(path.join(appDir, name), 'utf8');
      for (const m of source.matchAll(/eventType\s*[:=]\s*'(run\.[a-z_.]+)'/g)) {
        emitted.add(m[1]);
      }
    }
    assert.ok(emitted.size > 0, 'expected to find run.* eventType literals');
    const unprojectable = [...emitted].filter(
      (type) => !RUN_STATUS_EVENT_TYPES.has(type),
    );
    assert.deepEqual(
      unprojectable,
      [],
      `run.* events emitted by src but invisible to the A2A projector: ${unprojectable.join(', ')}`,
    );
  });
});

describe('A2A stream reaches a terminal frame on the real vocabulary', () => {
  const events = [
    envelope(1, EVT1, 'run.accepted', { status: 'ACCEPTED' }),
    envelope(2, EVT2, 'run.queued', { status: 'QUEUED' }),
    envelope(3, EVT3, 'run.started', {
      from: 'QUEUED',
      to: 'STARTING',
      status: 'STARTING',
    }),
    envelope(4, MSG, 'message.completed', {
      role: 'assistant',
      messageId: 'asst-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'A2A_STREAM_OK' }],
      },
    }),
    envelope(5, EVT4, 'run.completed', {
      from: 'RUNNING',
      to: 'SUCCEEDED',
      status: 'SUCCEEDED',
    }),
  ];

  function makeStream() {
    return new A2aStreamService({
      taskService: {
        async resolveOwnedTask() {
          return { a2aTaskId: TASK, runId: RUN, contextId: CONV };
        },
        runAuthForPrincipal: () => ({}),
        async getTask() {
          return buildA2aTaskObject({
            a2aTaskId: TASK,
            runStatus: 'RUNNING',
            contextId: CONV,
          });
        },
      },
      eventQueryService: {
        async listEvents({ afterSequence }) {
          const page = events.filter((e) => e.sequence > afterSequence);
          if (page.length === 0) {
            return { events: [], status: 'SUCCEEDED', terminal: true };
          }
          return {
            events: page,
            status: page[page.length - 1].event.status || 'RUNNING',
            terminal: false,
          };
        },
      },
      getRunService: {
        async execute() {
          return { runId: RUN, status: 'SUCCEEDED' };
        },
      },
      pollMs: 5,
      heartbeatMs: 60_000,
      mysqlCatchupMs: 1,
      sleep: async () => {},
    });
  }

  async function collect(method, rpcId) {
    const frames = [];
    await makeStream().openTaskStream(
      {
        principal: {},
        agentId: AGENT,
        taskId: TASK,
        rpcId,
        afterSequence: 0,
        includeInitialTask: true,
        method,
      },
      {
        write: (chunk) => {
          frames.push(chunk);
          return true;
        },
        isClosed: () => false,
      },
    );
    return parseDataLines(frames).map((d) => d.result);
  }

  it('message/stream ends with final: true and carries the agent text', async () => {
    const results = await collect(A2A_METHODS.SEND_STREAMING_MESSAGE, 1);
    assertOfficialStreamGrammar(results);
    const statuses = results.filter((r) => r.kind === 'status-update');
    assert.deepEqual(
      statuses.map((r) => r.status.state),
      ['submitted', 'working', 'working', 'completed'],
    );
    assert.equal(
      statuses.find((r) => r.status.message)?.status.message.parts[0].text,
      'A2A_STREAM_OK',
    );
    assert.equal(statuses.at(-1).final, true);
  });

  it('tasks/resubscribe replays through the terminal frame', async () => {
    const results = await collect(A2A_METHODS.SUBSCRIBE_TO_TASK, 2);
    assertOfficialStreamGrammar(results);
    assert.ok(
      results.some((r) => r.kind === 'status-update' && r.final === true),
      'resubscribe must replay a final status-update',
    );
  });
});
