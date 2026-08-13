/**
 * A2A v0.3 stream contract: kind union, channel split, collapse, schema.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectEnvelopeToA2aResult,
  buildA2aTaskObject,
} from '../../src/application/a2a/event-projector.js';
import { A2aStreamService } from '../../src/application/a2a/stream-service.js';
import {
  A2A_STREAM_RESULT_KINDS,
  streamKindsForMethod,
  assertA2aStreamResult,
  assertOfficialStreamGrammar,
  prepareA2aStreamResult,
  omitNullFields,
  A2aStreamSchemaError,
} from '../../src/application/a2a/stream-event-schema.js';
import { A2A_METHODS } from '../../src/application/a2a/json-rpc.js';

const TASK = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN4A';
const ART = '01K0G2PAV8FPMVC9QHJG7JPN5F';
const EVT1 = '01K0G2PAV8FPMVC9QHJG7JPN58';
const EVT2 = '01K0G2PAV8FPMVC9QHJG7JPN59';
const MSG = '01K0G2PAV8FPMVC9QHJG7JPN5A';

const ctx = { a2aTaskId: TASK, contextId: CONV, runStatus: 'RUNNING' };

function parseDataLines(frames) {
  return frames
    .join('')
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
}

describe('A2A official 0.3 stream union', () => {
  it('message/stream and tasks/resubscribe share the full StreamResponse union', () => {
    assert.deepEqual(
      [...streamKindsForMethod(A2A_METHODS.SEND_STREAMING_MESSAGE)],
      [...A2A_STREAM_RESULT_KINDS],
    );
    assert.ok(streamKindsForMethod('message/stream').includes('status-update'));
    assert.ok(streamKindsForMethod('tasks/resubscribe').includes('status-update'));
  });
});

describe('A2A projector contract', () => {
  it('collapses no-op run status transitions', () => {
    const first = projectEnvelopeToA2aResult(
      {
        sequence: 1,
        eventId: EVT1,
        event: { type: 'run.accepted', status: 'ACCEPTED' },
        ts: Date.now(),
      },
      ctx,
    );
    assert.equal(first.kind, 'status-update');
    assert.equal(first.result.status.state, 'submitted');

    const queued = projectEnvelopeToA2aResult(
      {
        sequence: 2,
        eventId: EVT2,
        event: { type: 'run.queued', status: 'QUEUED' },
        ts: Date.now(),
      },
      { ...ctx, lastA2aStatus: 'submitted' },
    );
    assert.equal(queued, null);
  });

  it('does not prefix-match unknown run.* events', () => {
    const out = projectEnvelopeToA2aResult(
      {
        sequence: 1,
        event: { type: 'run.heartbeat', status: 'RUNNING' },
      },
      ctx,
    );
    assert.equal(out, null);
  });

  it('folds message.completed into status-update.status.message', () => {
    const out = projectEnvelopeToA2aResult(
      {
        sequence: 4,
        eventId: MSG,
        event: {
          type: 'message.completed',
          role: 'assistant',
          messageId: 'asst-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Quarterly summary ready.' }],
          },
        },
      },
      { ...ctx, lastA2aStatus: 'working' },
    );
    assert.equal(out.kind, 'status-update');
    assertA2aStreamResult(out.result);
    assert.equal(out.result.status.state, 'working');
    assert.equal(out.result.status.message.role, 'agent');
    assert.equal(out.result.status.message.messageId, 'asst-1');
    assert.equal(out.result.status.message.parts[0].text, 'Quarterly summary ready.');
  });

  it('omits artifact.description when empty and FilePart when no uri', () => {
    const out = projectEnvelopeToA2aResult(
      {
        sequence: 3,
        event: {
          type: 'artifact.ready',
          artifactId: ART,
          name: 'report.pdf',
          mimeType: 'application/pdf',
        },
      },
      ctx,
    );
    assert.equal(out.kind, 'artifact-update');
    assert.equal(out.result.artifact.description, undefined);
    assert.ok(!('description' in out.result.artifact));
    assert.ok(!out.result.artifact.parts.some((p) => p.kind === 'file'));
    assertA2aStreamResult(out.result);
  });

  it('emits FilePart only when a download uri is minted', () => {
    const out = projectEnvelopeToA2aResult(
      {
        sequence: 3,
        event: {
          type: 'artifact.ready',
          artifactId: ART,
          name: 'report.pdf',
          mimeType: 'application/pdf',
        },
      },
      {
        ...ctx,
        principal: { orgId: 'org', clientId: 'c1' },
        buildDownloadUri: () => 'https://example.test/a2a/artifacts/download?token=x',
      },
    );
    const file = out.result.artifact.parts.find((p) => p.kind === 'file');
    assert.ok(file);
    assert.equal(file.file.uri.startsWith('https://'), true);
    assertA2aStreamResult(out.result);
  });

  it('strips internal runStatus from status-update metadata', () => {
    const out = projectEnvelopeToA2aResult(
      {
        sequence: 2,
        eventId: EVT1,
        event: { type: 'run.started', status: 'RUNNING' },
        ts: Date.now(),
      },
      ctx,
    );
    assert.equal(out.result.metadata.sourceEventType, undefined);
    assert.equal(out.result.metadata.runStatus, undefined);
    assert.equal(out.result.metadata.sequence, 2);
    assertA2aStreamResult(out.result);
  });
});

describe('A2A emit-time schema', () => {
  it('rejects unknown kind (Pydantic literal_error equivalent)', () => {
    assert.throws(
      () =>
        assertA2aStreamResult({
          kind: 'statusUpdate',
          taskId: TASK,
          contextId: CONV,
          status: { state: 'working' },
          final: false,
        }),
      (e) => e instanceof A2aStreamSchemaError && /kind/.test(e.message),
    );
  });

  it('rejects Message missing messageId (Pydantic missing equivalent)', () => {
    assert.throws(
      () =>
        assertA2aStreamResult({
          kind: 'message',
          role: 'agent',
          parts: [{ kind: 'text', text: 'hi' }],
        }),
      (e) => e instanceof A2aStreamSchemaError && /messageId/.test(e.message),
    );
  });

  it('rejects FilePart without uri or bytes', () => {
    assert.throws(
      () =>
        assertA2aStreamResult({
          kind: 'artifact-update',
          taskId: TASK,
          contextId: CONV,
          artifact: {
            artifactId: ART,
            name: 'x',
            parts: [{ kind: 'file', file: { name: 'x.pdf', mimeType: 'application/pdf' } }],
          },
        }),
      (e) => e instanceof A2aStreamSchemaError && /uri or bytes/.test(e.message),
    );
  });

  it('prepareA2aStreamResult omits nulls then validates', () => {
    const prepared = prepareA2aStreamResult({
      kind: 'task',
      id: TASK,
      contextId: CONV,
      status: { state: 'working', timestamp: '2026-08-13T00:00:00.000Z' },
      artifacts: [],
      metadata: { extra: null },
    });
    assert.ok(prepared);
    assert.equal(prepared.metadata.extra, undefined);
    assert.deepEqual(A2A_STREAM_RESULT_KINDS, [
      'task',
      'message',
      'status-update',
      'artifact-update',
    ]);
  });

  it('omitNullFields drops description: null', () => {
    const cleaned = omitNullFields({
      artifactId: ART,
      description: null,
      name: 'a',
    });
    assert.deepEqual(cleaned, { artifactId: ART, name: 'a' });
  });
});

describe('A2A stream service channel + SSE shape', () => {
  const events = [
    {
      sequence: 1,
      eventId: EVT1,
      event: { type: 'run.accepted', status: 'ACCEPTED' },
      ts: 1,
    },
    {
      sequence: 2,
      eventId: EVT2,
      event: { type: 'run.started', status: 'RUNNING' },
      ts: 2,
    },
    {
      sequence: 3,
      eventId: MSG,
      event: {
        type: 'message.completed',
        role: 'assistant',
        messageId: 'asst-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      },
      ts: 3,
    },
    {
      sequence: 4,
      eventId: ART,
      event: { type: 'artifact.ready', artifactId: ART, name: 'out.csv' },
      ts: 4,
    },
    {
      sequence: 5,
      eventId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
      event: { type: 'run.succeeded', status: 'SUCCEEDED' },
      ts: 5,
    },
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
            return { events: [], status: 'SUCCEEDED', terminal: afterSequence >= 5 };
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

  it('SendStreamingMessage is an official task-lifecycle stream', async () => {
    const frames = [];
    await makeStream().openTaskStream(
      {
        principal: {},
        agentId: AGENT,
        taskId: TASK,
        rpcId: 1,
        afterSequence: 0,
        includeInitialTask: true,
        method: A2A_METHODS.SEND_STREAMING_MESSAGE,
      },
      {
        write: (chunk) => {
          frames.push(chunk);
          return true;
        },
        isClosed: () => false,
      },
    );
    assert.ok(frames.every((f) => !/^event:/m.test(f)));
    const data = parseDataLines(frames);
    const results = data.map((d) => d.result);
    assertOfficialStreamGrammar(results);
    assert.equal(results[0].kind, 'task');
    assert.ok(!results.some((r) => r.kind === 'message'));
    const statuses = results.filter((r) => r.kind === 'status-update');
    assert.deepEqual(
      statuses.map((r) => r.status.state),
      ['submitted', 'working', 'working', 'completed'],
    );
    assert.equal(
      statuses.find((r) => r.status.message)?.status.message.parts[0].text,
      'done',
    );
    assert.ok(results.some((r) => r.kind === 'artifact-update'));
    assert.equal(statuses.at(-1).final, true);
  });

  it('SubscribeToTask uses the same official 0.3 grammar', async () => {
    const frames = [];
    await makeStream().openTaskStream(
      {
        principal: {},
        agentId: AGENT,
        taskId: TASK,
        rpcId: 2,
        afterSequence: 0,
        includeInitialTask: true,
        method: A2A_METHODS.SUBSCRIBE_TO_TASK,
      },
      {
        write: (chunk) => {
          frames.push(chunk);
          return true;
        },
        isClosed: () => false,
      },
    );
    assert.ok(frames.every((f) => !/^event:/m.test(f)));
    const results = parseDataLines(frames).map((d) => d.result);
    assertOfficialStreamGrammar(results);
    assert.ok(results.some((r) => r.kind === 'status-update' && r.final));
    assert.ok(results.some((r) => r.kind === 'artifact-update'));
  });
});
