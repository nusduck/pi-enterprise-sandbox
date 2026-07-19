import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TraceSpanRepository,
  deriveSpanId,
  mapTraceSpan,
  serializeTraceAttributes,
} from '../../src/infrastructure/mysql/repositories/trace-span-repository.js';
import { RunEventRepository } from '../../src/infrastructure/mysql/repositories/run-event-repository.js';
import { createFakeKnex, createFakeState } from './fake-knex.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const TOOL_EXEC = '01K0G2PAV8FPMVC9QHJG7JPN54';
const TOOL_EXEC_2 = '01K0G2PAV8FPMVC9QHJG7JPN55';
const ARTIFACT_1 = '01K0G2PAV8FPMVC9QHJG7JPN56';
const ARTIFACT_2 = '01K0G2PAV8FPMVC9QHJG7JPN57';
const TRACE = 'a'.repeat(32);

describe('durable trace span projection', () => {
  it('keeps only bounded metadata and excludes prompt/credential payloads', () => {
    const attrs = JSON.parse(
      serializeTraceAttributes({
        eventType: 'tool.execution.started',
        prompt: 'the entire user prompt must not be persisted',
        arguments: { password: 'do-not-store' },
        apiKey: 'sk-live-never-store',
        authorization: 'Bearer never-store',
        toolName: 'shell',
        source: 'pi',
        // Allowlisted keys must remain scalar; nested values are a payload
        // side-channel and are intentionally dropped.
        provider: { prompt: 'must-not-leak' },
        attempt: { password: 'must-not-leak' },
      }),
    );
    assert.deepEqual(attrs, {
      eventType: 'tool.execution.started',
      toolName: 'shell',
      source: 'pi',
    });
  });

  it('re-applies the metadata allowlist when reading legacy rows', () => {
    const row = {
      span_id: 'd'.repeat(16),
      trace_id: TRACE,
      org_id: ORG,
      user_id: USER,
      kind: 'model',
      name: 'Model call',
      status: 'ok',
      started_at: '2026-07-19 00:00:00.000',
      finished_at: null,
      attributes_json: JSON.stringify({
        modelId: 'gpt-test',
        projectedSequence: 17,
        prompt: 'must not be returned',
        authorization: 'Bearer secret',
      }),
    };
    const { attributes } = mapTraceSpan(row);
    assert.deepEqual(attributes, { modelId: 'gpt-test' });
  });

  it('keeps the replay watermark private and avoids semantic no-op writes', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    let now = new Date('2026-07-19T00:00:00.000Z');
    const repo = new TraceSpanRepository(knex, { now: () => now });
    const input = {
      orgId: ORG,
      userId: USER,
      traceId: TRACE,
      spanId: '1'.repeat(16),
      runId: RUN,
      kind: 'run',
      name: 'Run',
      status: 'running',
      startedAt: '2026-07-19T00:00:00.000Z',
      attributes: { eventType: 'run.started' },
    };

    await repo.upsert(input);
    const firstUpdatedAt = state.tables.trace_spans[0].updated_at;
    now = new Date('2026-07-19T00:00:10.000Z');
    await repo.upsert(input);
    assert.equal(state.tables.trace_spans[0].updated_at, firstUpdatedAt);

    await repo.advanceRunProjectionWatermark(
      { runId: RUN, traceId: TRACE, createdAt: input.startedAt },
      { orgId: ORG, userId: USER },
      17,
    );
    const root = state.tables.trace_spans.find(
      (row) =>
        row.kind === 'run' &&
        row.run_id === RUN &&
        JSON.parse(row.attributes_json || '{}').projectedSequence === 17,
    );
    assert.equal(
      JSON.parse(root.attributes_json).projectedSequence,
      17,
    );
    assert.equal(
      (await repo.listByRun(RUN, TRACE, { orgId: ORG, userId: USER }))
        .find((span) => span.kind === 'run')
        .attributes.projectedSequence,
      undefined,
    );
  });

  it('derives a stable non-zero W3C span id', () => {
    const first = deriveSpanId(TRACE, 'tool', 'tool-1');
    assert.equal(first, deriveSpanId(TRACE, 'tool', 'tool-1'));
    assert.match(first, /^[0-9a-f]{16}$/);
    assert.notEqual(first, '0'.repeat(16));
  });

  it('binds event projection to the append transaction and rolls back together', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.runs = [
      {
        run_id: RUN,
        org_id: ORG,
        user_id: USER,
        trace_id: TRACE,
        next_event_sequence: 0,
      },
    ];
    state.tables.run_events = [];
    state.tables.trace_spans = [];
    let boundExecutor = null;
    const projector = {
      forExecutor(executor) {
        boundExecutor = executor;
        return {
          projectRunEvent: async () => {
            assert.equal(executor.isTransaction, true);
            throw new Error('projection failed');
          },
        };
      },
      projectRunEvent: async () => {
        throw new Error('root executor must not be used');
      },
    };
    const repo = new RunEventRepository(knex, { traceSpans: projector });

    await assert.rejects(
      repo.append({
        eventId: '01K0G2PAV8FPMVC9QHJG7JPN58',
        runId: RUN,
        orgId: ORG,
        userId: USER,
        eventType: 'run.started',
        payloadJson: {},
        traceId: TRACE,
      }),
      /projection failed/,
    );
    assert.ok(boundExecutor, 'projector must receive the transaction executor');
    assert.deepEqual(state.tables.run_events, []);
    assert.equal(state.tables.runs[0].next_event_sequence, 0);
  });

  it('advances the private watermark for timeline-only events in the append transaction', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.runs = [
      {
        run_id: RUN,
        org_id: ORG,
        user_id: USER,
        trace_id: TRACE,
        next_event_sequence: 0,
      },
    ];
    state.tables.run_events = [];
    state.tables.trace_spans = [];
    const traceSpans = new TraceSpanRepository(knex, {
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const repo = new RunEventRepository(knex, { traceSpans });

    await repo.append({
      eventId: '01K0G2PAV8FPMVC9QHJG7JPN59',
      runId: RUN,
      orgId: ORG,
      userId: USER,
      eventType: 'message.delta',
      payloadJson: { data: { text: 'delta' } },
      traceId: TRACE,
    });

    assert.equal(state.tables.trace_spans.length, 1);
    const rawAttributes = JSON.parse(state.tables.trace_spans[0].attributes_json);
    assert.equal(rawAttributes.projectedSequence, 1);
    const publicSpan = mapTraceSpan(state.tables.trace_spans[0]);
    assert.equal(publicSpan.attributes.projectedSequence, undefined);
  });

  it('upserts a span with fake knex without requiring a real MySQL driver', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    const repo = new TraceSpanRepository(knex, {
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const span = await repo.upsert({
      orgId: ORG,
      userId: USER,
      traceId: TRACE,
      spanId: 'b'.repeat(16),
      runId: RUN,
      conversationId: CONV,
      agentSessionId: SESS,
      kind: 'run',
      name: 'Run',
      status: 'running',
      attributes: { prompt: 'omit', eventType: 'run.started' },
    });
    assert.equal(span.traceId, TRACE);
    assert.equal(span.runId, RUN);
    assert.deepEqual(span.attributes, { eventType: 'run.started' });
  });

  it('returns an explicit cursor when the trace page is truncated', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    const repo = new TraceSpanRepository(knex, {
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    for (const spanId of ['1'.repeat(16), '2'.repeat(16), '3'.repeat(16)]) {
      await repo.upsert({
        orgId: ORG,
        userId: USER,
        traceId: TRACE,
        spanId,
        runId: RUN,
        kind: 'tool',
        name: 'Tool',
        status: 'ok',
        startedAt: '2026-07-19T00:00:00.000Z',
        finishedAt: '2026-07-19T00:00:01.000Z',
      });
    }

    const first = await repo.listByRun(
      RUN,
      TRACE,
      { orgId: ORG, userId: USER },
      { limit: 2, includePageInfo: true },
    );
    assert.equal(first.truncated, true);
    assert.equal(first.spans.length, 2);
    assert.equal(first.nextCursor, '2'.repeat(16));

    const second = await repo.listByRun(
      RUN,
      TRACE,
      { orgId: ORG, userId: USER },
      { limit: 2, cursor: first.nextCursor, includePageInfo: true },
    );
    assert.equal(second.truncated, false);
    assert.deepEqual(second.spans.map((span) => span.spanId), ['3'.repeat(16)]);
    assert.equal(second.nextCursor, null);
  });

  it('keeps terminal lifecycle fields monotonic across stale replays', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    const repo = new TraceSpanRepository(knex, {
      now: () => new Date('2026-07-19T00:00:10.000Z'),
    });
    const input = {
      orgId: ORG,
      userId: USER,
      traceId: TRACE,
      spanId: 'e'.repeat(16),
      runId: RUN,
      kind: 'model',
      name: 'Model call',
    };

    await repo.upsert({
      ...input,
      status: 'error',
      startedAt: '2026-07-19T00:00:01.000Z',
      finishedAt: '2026-07-19T00:00:04.000Z',
      attributes: { eventType: 'model.request.failed', errorCode: 'UPSTREAM' },
    });
    await repo.upsert({
      ...input,
      status: 'running',
      startedAt: '2026-07-19T00:00:02.000Z',
      attributes: { eventType: 'model.request.started' },
    });
    const afterRunningReplay = await repo.upsert({
      ...input,
      status: 'ok',
      finishedAt: '2026-07-19T00:00:08.000Z',
      attributes: { eventType: 'model.request.completed' },
    });

    assert.equal(afterRunningReplay.status, 'error');
    assert.equal(
      afterRunningReplay.finishedAt,
      '2026-07-19T00:00:04.000Z',
    );
    assert.equal(afterRunningReplay.durationMs, 3_000);
    assert.deepEqual(afterRunningReplay.attributes, {
      eventType: 'model.request.failed',
      errorCode: 'UPSTREAM',
    });
  });

  it('does not turn timeline-only events into trace spans', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    const repo = new TraceSpanRepository(knex, {
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const timelineOnly = [
      'message.delta',
      'message.completed',
      'process.started',
      'process.output',
      'process.completed',
      'approval.requested',
      'approval.resolved',
      'dataset.ready',
      'tool.execution.progress',
    ];

    for (const [index, eventType] of timelineOnly.entries()) {
      await repo.projectRunEvent(
        {
          eventId: `event-${index}`,
          runId: RUN,
          traceId: TRACE,
          eventType,
          payloadJson: { context: {}, data: {} },
          createdAt: new Date(`2026-07-19T00:00:${String(index).padStart(2, '0')}.000Z`),
        },
        { orgId: ORG, userId: USER },
      );
    }

    assert.deepEqual(state.tables.trace_spans, []);
  });

  it('finishes session compaction spans instead of leaving them running', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    const repo = new TraceSpanRepository(knex, {
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    await repo.projectRunEvent(
      {
        eventId: 'session-compaction-1',
        runId: RUN,
        traceId: TRACE,
        eventType: 'session.compacted',
        payloadJson: { context: {}, data: {} },
        createdAt: '2026-07-19T00:00:01.000Z',
      },
      { orgId: ORG, userId: USER },
    );
    assert.equal(state.tables.trace_spans.length, 1);
    assert.equal(state.tables.trace_spans[0].kind, 'session');
    assert.equal(state.tables.trace_spans[0].status, 'ok');
    assert.equal(state.tables.trace_spans[0].finished_at, '2026-07-19 00:00:01.000');
  });

  it('parents the synthetic Run span to the incoming W3C caller span', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    const repo = new TraceSpanRepository(knex, {
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    await repo.projectRunEvent(
      {
        eventId: 'run-accepted-1',
        runId: RUN,
        traceId: TRACE,
        spanId: 'f'.repeat(16),
        eventType: 'run.accepted',
        payloadJson: { status: 'ACCEPTED' },
        createdAt: '2026-07-19T00:00:00.000Z',
      },
      { orgId: ORG, userId: USER },
    );

    assert.equal(state.tables.trace_spans.length, 1);
    assert.equal(state.tables.trace_spans[0].kind, 'run');
    assert.equal(state.tables.trace_spans[0].parent_span_id, 'f'.repeat(16));
  });

  it('projects model request lifecycle and errors as real spans', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    const repo = new TraceSpanRepository(knex, {
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const project = (eventType, data, createdAt) =>
      repo.projectRunEvent(
        {
          eventId: `${eventType}-${createdAt}`,
          runId: RUN,
          traceId: TRACE,
          eventType,
          payloadJson: { context: {}, data },
          createdAt,
        },
        { orgId: ORG, userId: USER },
      );

    await project(
      'model.request.started',
      { correlationId: 'provider-request-1' },
      '2026-07-19T00:00:01.000Z',
    );
    await project(
      'model.request.completed',
      { correlationId: 'provider-request-1' },
      '2026-07-19T00:00:02.000Z',
    );
    await project(
      'error.occurred',
      { source: 'compaction', errorCode: 'COMPACTION_FAILED' },
      '2026-07-19T00:00:03.000Z',
    );

    assert.equal(state.tables.trace_spans.length, 2);
    const model = state.tables.trace_spans.find((row) => row.kind === 'model');
    const error = state.tables.trace_spans.find((row) => row.kind === 'error');
    assert.equal(model?.status, 'ok');
    assert.equal(model?.finished_at, '2026-07-19 00:00:02.000');
    assert.equal(error?.name, 'Error');
    assert.equal(error?.status, 'error');
    assert.deepEqual(JSON.parse(String(error?.attributes_json)), {
      eventType: 'error.occurred',
      toolCallId: null,
      toolExecutionId: null,
      toolName: null,
      source: 'compaction',
      modelId: null,
      provider: null,
      errorCode: 'COMPACTION_FAILED',
    });
  });

  it('creates one Queue span per wait and closes it when the Run leaves queue', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    const repo = new TraceSpanRepository(knex, {
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const project = (eventId, eventType, data, createdAt) =>
      repo.projectRunEvent(
        {
          eventId,
          runId: RUN,
          traceId: TRACE,
          eventType,
          payloadJson: data,
          createdAt,
        },
        { orgId: ORG, userId: USER },
      );

    await project('queue-1', 'run.queued', { status: 'QUEUED' }, '2026-07-19T00:00:01.000Z');
    await project('start-1', 'run.started', { status: 'STARTING' }, '2026-07-19T00:00:02.000Z');
    await project('retry-1', 'run.retrying', { status: 'RETRYING' }, '2026-07-19T00:00:03.000Z');
    await project('queue-2', 'run.queued', { status: 'QUEUED' }, '2026-07-19T00:00:04.000Z');
    await project('cancel-1', 'run.cancelled', { status: 'CANCELLED' }, '2026-07-19T00:00:05.000Z');

    const queues = state.tables.trace_spans
      .filter((row) => row.kind === 'queue')
      .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
    assert.equal(queues.length, 2);
    assert.deepEqual(
      queues.map((row) => [row.status, row.finished_at]),
      [
        ['ok', '2026-07-19 00:00:02.000'],
        ['cancelled', '2026-07-19 00:00:05.000'],
      ],
    );
  });

  it('keeps one Tool span across proposal, execution, and fact materialization', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    state.tables.run_events = [];
    state.tables.tool_executions = [];
    state.tables.sandbox_executions = [];
    state.tables.artifacts = [];
    state.tables.a2a_tasks = [];
    const repo = new TraceSpanRepository(knex, {
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const project = (eventType, data, createdAt) =>
      repo.projectRunEvent(
        {
          eventId: `${eventType}-${createdAt}`,
          runId: RUN,
          traceId: TRACE,
          eventType,
          payloadJson: { context: {}, data },
          createdAt,
        },
        { orgId: ORG, userId: USER },
      );

    await project(
      'tool.call.proposed',
      { toolCallId: 'call-1', toolName: 'bash' },
      '2026-07-19T00:00:01.000Z',
    );
    await project(
      'tool.execution.started',
      { toolCallId: 'call-1', toolExecutionId: TOOL_EXEC, toolName: 'bash' },
      '2026-07-19T00:00:02.000Z',
    );
    await project(
      'tool.execution.completed',
      { toolCallId: 'call-1', toolExecutionId: TOOL_EXEC, toolName: 'bash' },
      '2026-07-19T00:00:03.000Z',
    );

    assert.equal(state.tables.trace_spans.length, 1);
    assert.equal(
      state.tables.trace_spans[0].span_id,
      deriveSpanId(TRACE, 'tool', 'call-1'),
    );
    assert.equal(state.tables.trace_spans[0].status, 'ok');

    state.tables.tool_executions.push({
      tool_execution_id: TOOL_EXEC,
      tool_call_id: 'call-1',
      run_id: RUN,
      trace_id: TRACE,
      agent_session_id: SESS,
      tool_source: 'builtin',
      tool_name: 'bash',
      status: 'SUCCEEDED',
      risk_level: 'low',
      error_code: null,
      started_at: '2026-07-19 00:00:02.000',
      completed_at: '2026-07-19 00:00:03.000',
      created_at: '2026-07-19 00:00:01.000',
    });
    await repo.materializeRunFacts(
      {
        runId: RUN,
        traceId: TRACE,
        status: 'SUCCEEDED',
        conversationId: CONV,
        agentSessionId: SESS,
        createdAt: '2026-07-19T00:00:00.000Z',
        completedAt: '2026-07-19T00:00:04.000Z',
      },
      { orgId: ORG, userId: USER },
    );

    assert.equal(
      state.tables.trace_spans.filter((row) => row.kind === 'tool').length,
      1,
    );

    state.tables.tool_executions[0].status = 'UNKNOWN';
    state.tables.tool_executions[0].completed_at = null;
    await repo.materializeRunFacts(
      {
        runId: RUN,
        traceId: TRACE,
        status: 'SUCCEEDED',
        conversationId: CONV,
        agentSessionId: SESS,
        createdAt: '2026-07-19T00:00:00.000Z',
        completedAt: '2026-07-19T00:00:04.000Z',
      },
      { orgId: ORG, userId: USER },
    );
    const unknownTool = state.tables.trace_spans.find(
      (row) => row.kind === 'tool',
    );
    assert.equal(unknownTool?.status, 'error');
    assert.equal(unknownTool?.finished_at, '2026-07-19 00:00:01.000');
  });

  it('coalesces concurrent first writes for one span', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    const repo = new TraceSpanRepository(knex, {
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const input = {
      orgId: ORG,
      userId: USER,
      traceId: TRACE,
      spanId: 'c'.repeat(16),
      runId: RUN,
      kind: 'model',
      name: 'Model call',
      status: 'running',
      startedAt: '2026-07-19T00:00:00.000Z',
    };

    const [first, second] = await Promise.all([
      repo.upsert(input),
      repo.upsert(input),
    ]);
    assert.equal(state.tables.trace_spans.length, 1);
    assert.equal(first.spanId, input.spanId);
    assert.equal(second.spanId, input.spanId);
  });

  it('does not regress a newer watermark when an optimistic update races', async () => {
    const state = createFakeState();
    const baseKnex = createFakeKnex(state);
    state.tables.trace_spans = [];
    const seed = new TraceSpanRepository(baseKnex, {
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    await seed.advanceRunProjectionWatermark(
      { runId: RUN, traceId: TRACE },
      { orgId: ORG, userId: USER },
      1,
    );

    let raced = false;
    const racingKnex = (tableName) => {
      const query = baseKnex(tableName);
      if (tableName === 'trace_spans') {
        const update = query.update.bind(query);
        query.update = async (patch) => {
          const nextSequence = JSON.parse(patch.attributes_json || '{}').projectedSequence;
          if (!raced && nextSequence === 2) {
            const row = state.tables.trace_spans.find(
              (candidate) => candidate.run_id === RUN && candidate.kind === 'run',
            );
            const attrs = JSON.parse(row.attributes_json);
            attrs.projectedSequence = 3;
            row.attributes_json = JSON.stringify(attrs);
            raced = true;
          }
          return update(patch);
        };
      }
      return query;
    };
    const repo = new TraceSpanRepository(racingKnex, {
      now: () => new Date('2026-07-19T00:00:01.000Z'),
    });
    await repo.advanceRunProjectionWatermark(
      { runId: RUN, traceId: TRACE },
      { orgId: ORG, userId: USER },
      2,
    );

    const root = state.tables.trace_spans.find(
      (row) => row.run_id === RUN && row.kind === 'run',
    );
    assert.equal(JSON.parse(root.attributes_json).projectedSequence, 3);
    assert.equal(root.org_id, ORG);
    assert.equal(root.user_id, USER);
  });

  it('does not let stale replay reopen a terminal span', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    const repo = new TraceSpanRepository(knex, {
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const spanId = 'e'.repeat(16);
    await repo.upsert({
      orgId: ORG,
      userId: USER,
      traceId: TRACE,
      spanId,
      runId: RUN,
      kind: 'model',
      name: 'Model call',
      status: 'ok',
      startedAt: '2026-07-19T00:00:00.000Z',
      finishedAt: '2026-07-19T00:00:01.000Z',
      attributes: { eventType: 'model.request.completed' },
    });
    const replayed = await repo.upsert({
      orgId: ORG,
      userId: USER,
      traceId: TRACE,
      spanId,
      runId: RUN,
      kind: 'model',
      name: 'Model call',
      status: 'running',
      startedAt: '2026-07-19T00:00:00.000Z',
      attributes: { eventType: 'model.request.started' },
    });

    assert.equal(replayed.status, 'ok');
    assert.equal(replayed.finishedAt, '2026-07-19T00:00:01.000Z');
    assert.equal(replayed.attributes.eventType, 'model.request.completed');
  });

  it('rejects a parent chain that would form a cycle', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    const repo = new TraceSpanRepository(knex, {
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    const spanA = 'a'.repeat(16);
    const spanB = 'b'.repeat(16);
    await repo.upsert({
      orgId: ORG,
      userId: USER,
      traceId: TRACE,
      spanId: spanA,
      runId: RUN,
      parentSpanId: spanB,
      kind: 'tool',
      name: 'A',
      status: 'running',
    });
    await assert.rejects(
      () =>
        repo.upsert({
          orgId: ORG,
          userId: USER,
          traceId: TRACE,
          spanId: spanB,
          runId: RUN,
          parentSpanId: spanA,
          kind: 'tool',
          name: 'B',
          status: 'running',
        }),
      /cycle/i,
    );
  });

  it('replays only events after the watermark and leaves a repeated materialization unchanged', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    state.tables.run_events = [
      {
        event_id: 'model-started',
        run_id: RUN,
        org_id: ORG,
        trace_id: TRACE,
        event_type: 'model.request.started',
        sequence_no: 1,
        payload_json: JSON.stringify({ data: { correlationId: 'request-1' } }),
        created_at: '2026-07-19 00:00:01.000',
      },
      {
        event_id: 'model-completed',
        run_id: RUN,
        org_id: ORG,
        trace_id: TRACE,
        event_type: 'model.request.completed',
        sequence_no: 2,
        payload_json: JSON.stringify({ data: { correlationId: 'request-1' } }),
        created_at: '2026-07-19 00:00:02.000',
      },
    ];
    state.tables.tool_executions = [];
    state.tables.sandbox_executions = [];
    state.tables.artifacts = [];
    state.tables.a2a_tasks = [];
    let now = new Date('2026-07-19T00:00:00.000Z');
    const repo = new TraceSpanRepository(knex, { now: () => now });
    await repo.advanceRunProjectionWatermark(
      { runId: RUN, traceId: TRACE, createdAt: now },
      { orgId: ORG, userId: USER },
      1,
    );
    const projected = [];
    const projectRunEvent = repo.projectRunEvent.bind(repo);
    repo.projectRunEvent = async (event, owner) => {
      projected.push(Number(event.sequence_no ?? event.sequenceNo));
      return projectRunEvent(event, owner);
    };
    const run = {
      runId: RUN,
      traceId: TRACE,
      status: 'SUCCEEDED',
      conversationId: CONV,
      agentSessionId: SESS,
      nextEventSequence: 2,
      createdAt: '2026-07-19T00:00:00.000Z',
      completedAt: '2026-07-19T00:00:03.000Z',
    };

    await repo.materializeRunFacts(run, { orgId: ORG, userId: USER });
    assert.deepEqual(projected, [2]);
    const model = state.tables.trace_spans.find((row) => row.kind === 'model');
    assert.equal(model?.status, 'ok');
    const root = state.tables.trace_spans.find((row) => row.kind === 'run');
    assert.equal(JSON.parse(root?.attributes_json).projectedSequence, 2);
    const updatedAt = state.tables.trace_spans.map((row) => row.updated_at);

    now = new Date('2026-07-19T00:01:00.000Z');
    await repo.materializeRunFacts(run, { orgId: ORG, userId: USER });
    assert.deepEqual(projected, [2]);
    assert.deepEqual(
      state.tables.trace_spans.map((row) => row.updated_at),
      updatedAt,
    );
  });

  it('does not advance the watermark when an event projection fails', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    state.tables.run_events = [
      {
        event_id: 'model-failed-projection',
        run_id: RUN,
        org_id: ORG,
        trace_id: TRACE,
        event_type: 'model.request.completed',
        sequence_no: 2,
        payload_json: JSON.stringify({ data: { correlationId: 'request-2' } }),
        created_at: '2026-07-19 00:00:02.000',
      },
    ];
    state.tables.tool_executions = [];
    state.tables.sandbox_executions = [];
    state.tables.artifacts = [];
    state.tables.a2a_tasks = [];
    const repo = new TraceSpanRepository(knex, {
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });
    await repo.advanceRunProjectionWatermark(
      { runId: RUN, traceId: TRACE },
      { orgId: ORG, userId: USER },
      1,
    );
    repo.projectRunEvent = async () => {
      throw new Error('projection failed after watermark read');
    };

    await assert.rejects(
      repo.materializeRunFacts(
        {
          runId: RUN,
          traceId: TRACE,
          status: 'RUNNING',
          nextEventSequence: 2,
          createdAt: '2026-07-19T00:00:00.000Z',
        },
        { orgId: ORG, userId: USER },
      ),
      /projection failed/,
    );
    const root = state.tables.trace_spans.find((row) => row.kind === 'run');
    assert.equal(JSON.parse(root?.attributes_json).projectedSequence, 1);
  });

  it('parents each artifact to the Tool named by its artifact.ready event', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    state.tables.trace_spans = [];
    state.tables.run_events = [
      {
        event_id: 'artifact-event-1',
        run_id: RUN,
        trace_id: TRACE,
        event_type: 'artifact.ready',
        sequence_no: 1,
        payload_json: JSON.stringify({
          data: {
            artifactId: ARTIFACT_1,
            toolCallId: 'submit-1',
            toolExecutionId: TOOL_EXEC,
          },
        }),
        created_at: '2026-07-19 00:00:01.000',
      },
      {
        event_id: 'artifact-event-2',
        run_id: RUN,
        trace_id: TRACE,
        event_type: 'artifact.ready',
        sequence_no: 2,
        payload_json: JSON.stringify({
          data: {
            artifactId: ARTIFACT_2,
            toolCallId: 'submit-2',
            toolExecutionId: TOOL_EXEC_2,
          },
        }),
        created_at: '2026-07-19 00:00:02.000',
      },
    ];
    state.tables.tool_executions = [
      {
        tool_execution_id: TOOL_EXEC,
        tool_call_id: 'submit-1',
        run_id: RUN,
        trace_id: TRACE,
        agent_session_id: SESS,
        tool_source: 'builtin',
        tool_name: 'submit_artifact',
        status: 'SUCCEEDED',
        started_at: '2026-07-19 00:00:00.000',
        completed_at: '2026-07-19 00:00:01.000',
        created_at: '2026-07-19 00:00:00.000',
      },
      {
        tool_execution_id: TOOL_EXEC_2,
        tool_call_id: 'submit-2',
        run_id: RUN,
        trace_id: TRACE,
        agent_session_id: SESS,
        tool_source: 'builtin',
        tool_name: 'submit_artifact',
        status: 'SUCCEEDED',
        started_at: '2026-07-19 00:00:01.000',
        completed_at: '2026-07-19 00:00:02.000',
        created_at: '2026-07-19 00:00:01.000',
      },
    ];
    state.tables.sandbox_executions = [];
    state.tables.artifacts = [
      {
        artifact_id: ARTIFACT_1,
        org_id: ORG,
        user_id: USER,
        run_id: RUN,
        conversation_id: CONV,
        agent_session_id: SESS,
        status: 'READY',
        created_at: '2026-07-19 00:00:01.000',
        display_name: 'one.txt',
        mime_type: 'text/plain',
        size_bytes: 1,
        sha256: '1'.repeat(64),
      },
      {
        artifact_id: ARTIFACT_2,
        org_id: ORG,
        user_id: USER,
        run_id: RUN,
        conversation_id: CONV,
        agent_session_id: SESS,
        status: 'READY',
        created_at: '2026-07-19 00:00:02.000',
        display_name: 'two.txt',
        mime_type: 'text/plain',
        size_bytes: 1,
        sha256: '2'.repeat(64),
      },
    ];
    state.tables.a2a_tasks = [];
    const repo = new TraceSpanRepository(knex, {
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    });

    await repo.materializeRunFacts(
      {
        runId: RUN,
        traceId: TRACE,
        status: 'SUCCEEDED',
        conversationId: CONV,
        agentSessionId: SESS,
        createdAt: '2026-07-19T00:00:00.000Z',
        completedAt: '2026-07-19T00:00:03.000Z',
      },
      { orgId: ORG, userId: USER },
    );

    const artifactSpans = state.tables.trace_spans.filter(
      (row) => row.kind === 'artifact',
    );
    assert.equal(artifactSpans.length, 2);
    const byArtifact = new Map(
      artifactSpans.map((row) => [row.artifact_id, row.parent_span_id]),
    );
    assert.equal(byArtifact.get(ARTIFACT_1), deriveSpanId(TRACE, 'tool', 'submit-1'));
    assert.equal(byArtifact.get(ARTIFACT_2), deriveSpanId(TRACE, 'tool', 'submit-2'));
  });
});
