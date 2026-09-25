import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createEntityStore,
  createRun,
  getRunTraceSpans,
} from '../src/entities/store.ts';
import { rehydrateTraceSpans } from '../src/features/chat/entityBridge.ts';
import type { RunTraceResponse } from '../src/shared/schemas/events.ts';

const TRACE = 'a'.repeat(32);
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const ROOT_SPAN = 'b'.repeat(16);
const TOOL_SPAN = 'c'.repeat(16);
const A2A_SPAN = 'd'.repeat(16);

/** Fixture matching Agent TraceQueryService / mapTraceSpan dual-key projection. */
function projectedTraceFixture(): RunTraceResponse {
  return {
    traceId: TRACE,
    trace_id: TRACE,
    runId: RUN,
    run_id: RUN,
    truncated: false,
    nextCursor: null,
    next_cursor: null,
    spans: [
      {
        id: ROOT_SPAN,
        spanId: ROOT_SPAN,
        span_id: ROOT_SPAN,
        traceId: TRACE,
        trace_id: TRACE,
        runId: RUN,
        run_id: RUN,
        orgId: ORG,
        org_id: ORG,
        userId: USER,
        user_id: USER,
        parentSpanId: null,
        parent_span_id: null,
        kind: 'run',
        name: 'Run',
        status: 'ok',
        startedAt: '2026-07-19T00:00:00.000Z',
        finishedAt: '2026-07-19T00:00:04.000Z',
        durationMs: 4000,
        attributes: { source: 'web', eventType: 'run.completed' },
      },
      {
        id: TOOL_SPAN,
        spanId: TOOL_SPAN,
        span_id: TOOL_SPAN,
        traceId: TRACE,
        runId: RUN,
        orgId: ORG,
        userId: USER,
        parentSpanId: ROOT_SPAN,
        parent_span_id: ROOT_SPAN,
        kind: 'tool',
        name: 'bash',
        status: 'ok',
        startedAt: '2026-07-19T00:00:01.000Z',
        finishedAt: '2026-07-19T00:00:02.000Z',
        durationMs: 1000,
        attributes: {
          toolName: 'bash',
          toolCallId: 'call-1',
          source: 'builtin',
        },
      },
      {
        id: A2A_SPAN,
        spanId: A2A_SPAN,
        span_id: A2A_SPAN,
        traceId: TRACE,
        runId: RUN,
        orgId: ORG,
        userId: USER,
        parentSpanId: ROOT_SPAN,
        kind: 'a2a',
        name: 'A2A projection',
        status: 'ok',
        startedAt: '2026-07-19T00:00:00.500Z',
        finishedAt: '2026-07-19T00:00:04.000Z',
        attributes: {
          taskId: '01K0G2PAV8FPMVC9QHJG7JPN5A',
          clientId: 'client-a',
          agentId: '01K0G2PAV8FPMVC9QHJG7JPN5D',
        },
      },
    ],
  };
}

test('rehydrates projected Agent spans with parents, owner and allowlisted metadata', () => {
  const store = createEntityStore({
    runsById: {
      [RUN]: createRun({ id: RUN, status: 'succeeded', traceId: TRACE }),
    },
  });
  const next = rehydrateTraceSpans(store, RUN, projectedTraceFixture());
  const spans = getRunTraceSpans(next, RUN);
  assert.equal(spans.length, 3);
  assert.equal(next.runsById[RUN].traceId, TRACE);

  const root = spans.find((s) => s.kind === 'run');
  assert.ok(root);
  assert.equal(root.orgId, ORG);
  assert.equal(root.userId, USER);
  const children = spans.filter((s) => s.parentId === root.id).map((s) => s.kind).sort();
  assert.deepEqual(children, ['a2a', 'tool']);
  const a2a = spans.find((s) => s.kind === 'a2a');
  assert.equal(a2a?.metadata?.clientId, 'client-a');
});
