import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createEntityStore,
  createRun,
  createTraceSpan,
  getRunTraceSpans,
} from '../src/entities/store.ts';
import { rehydrateTraceSpans } from '../src/features/chat/entityBridge.ts';
import type { RunTraceResponse } from '../src/shared/schemas/events.ts';
import {
  buildTraceTree,
  TracePanel,
  traceMetadataEntries,
} from '../src/widgets/trace-panel/TracePanel.tsx';

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

test('trace tree preserves parent-child order and owner-bearing spans', () => {
  const root = createTraceSpan({
    id: 'trace:root',
    runId: 'run-1',
    orgId: 'org-1',
    userId: 'user-1',
    spanId: 'root',
    kind: 'run',
    name: 'Run',
    startedAt: '2026-07-19T00:00:00.000Z',
  });
  const child = createTraceSpan({
    id: 'trace:tool',
    runId: 'run-1',
    parentId: root.id,
    spanId: 'tool',
    kind: 'tool',
    name: 'bash',
    startedAt: '2026-07-19T00:00:00.100Z',
  });

  const tree = buildTraceTree([child, root]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].span.orgId, 'org-1');
  assert.equal(tree[0].children[0].span.id, child.id);
});

test('trace metadata exposes only supported scalar Tool and Model fields', () => {
  assert.deepEqual(
    traceMetadataEntries({
      toolName: 'bash',
      modelId: 'gpt-5',
      provider: 'openai',
      exitCode: 0,
      nested: { secret: 'not rendered' },
      prompt: 'not rendered',
    }),
    [
      { key: 'modelId', label: 'Model', value: 'gpt-5' },
      { key: 'provider', label: 'Provider', value: 'openai' },
      { key: 'toolName', label: 'Tool', value: 'bash' },
      { key: 'exitCode', label: 'Exit', value: '0' },
    ],
  );
});

test('rehydrates projected Agent spans and TracePanel renders org/client/trace', () => {
  const store = createEntityStore({
    runsById: {
      [RUN]: createRun({ id: RUN, status: 'succeeded', traceId: TRACE }),
    },
  });
  const next = rehydrateTraceSpans(store, RUN, projectedTraceFixture());
  const spans = getRunTraceSpans(next, RUN);
  assert.equal(spans.length, 3);
  assert.equal(next.runsById[RUN].traceId, TRACE);

  const tree = buildTraceTree(spans);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].span.kind, 'run');
  assert.equal(tree[0].span.orgId, ORG);
  assert.equal(tree[0].span.userId, USER);
  const childKinds = tree[0].children.map((n) => n.span.kind).sort();
  assert.deepEqual(childKinds, ['a2a', 'tool']);

  const a2a = tree[0].children.find((n) => n.span.kind === 'a2a');
  assert.ok(a2a);
  assert.deepEqual(traceMetadataEntries(a2a.span.metadata), [
    { key: 'taskId', label: 'A2A task', value: '01K0G2PAV8FPMVC9QHJG7JPN5A' },
    { key: 'clientId', label: 'Client', value: 'client-a' },
    { key: 'agentId', label: 'Agent', value: '01K0G2PAV8FPMVC9QHJG7JPN5D' },
  ]);

  const html = renderToStaticMarkup(
    createElement(TracePanel, { spans, traceId: TRACE }),
  );
  assert.match(html, /aria-label="Trace"/);
  assert.match(html, new RegExp(TRACE));
  assert.match(html, new RegExp(ORG));
  assert.match(html, /client-a/);
  assert.match(html, />bash</);
  assert.match(html, /A2A projection/);
  assert.match(html, /data-kind="tool"/);
  assert.match(html, /data-kind="a2a"/);
});
