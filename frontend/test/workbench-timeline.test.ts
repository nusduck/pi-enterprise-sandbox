/**
 * F3 Runtime Workbench — timeline builders + selection helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEntityStore,
  createRun,
  createToolExecution,
  createProcess,
  createApproval,
  createArtifact,
  createConversation,
  upsertRun,
  upsertToolExecution,
  upsertProcess,
  upsertApproval,
  upsertArtifact,
  upsertConversation,
  setActiveConversation,
} from '../src/entities/index.ts';
import {
  buildRunTimeline,
  conversationRunMarkers,
  formatDuration,
  formatRunStatusLabel,
  listPendingApprovals,
  listPendingApprovalsForConversation,
  runStatusTone,
  selectionToInspectorTab,
  summarizeToolInput,
} from '../src/widgets/runtime-timeline/buildTimeline.ts';

describe('buildTimeline helpers', () => {
  it('formatDuration handles ms / s / m', () => {
    const start = '2026-01-01T00:00:00.000Z';
    assert.equal(
      formatDuration(start, '2026-01-01T00:00:00.120Z'),
      '120 ms',
    );
    assert.equal(
      formatDuration(start, '2026-01-01T00:00:05.000Z'),
      '5s',
    );
    assert.equal(
      formatDuration(start, '2026-01-01T00:03:05.000Z'),
      '3m 05s',
    );
    assert.equal(formatDuration(null), '—');
  });

  it('formatRunStatusLabel and runStatusTone map known statuses', () => {
    assert.equal(formatRunStatusLabel('waiting_approval'), 'Waiting approval');
    assert.equal(runStatusTone('running'), 'active');
    assert.equal(runStatusTone('waiting_approval'), 'warning');
    assert.equal(runStatusTone('failed'), 'danger');
    assert.equal(runStatusTone('succeeded'), 'success');
    assert.equal(runStatusTone(null), 'idle');
  });

  it('summarizeToolInput prefers path/command fields', () => {
    assert.equal(
      summarizeToolInput({ path: 'src/config.js', other: 1 }),
      'src/config.js',
    );
    assert.equal(
      summarizeToolInput({ command: 'npm test' }),
      'npm test',
    );
    assert.equal(summarizeToolInput(null), '');
  });

  it('selectionToInspectorTab maps card kinds to tabs', () => {
    assert.equal(selectionToInspectorTab('tool'), 'tools');
    assert.equal(selectionToInspectorTab('process'), 'processes');
    assert.equal(selectionToInspectorTab('artifact'), 'artifacts');
    assert.equal(selectionToInspectorTab('approval'), 'overview');
    assert.equal(selectionToInspectorTab('session'), 'session');
    assert.equal(selectionToInspectorTab(null), 'overview');
  });
});

describe('buildRunTimeline', () => {
  it('orders tool / process / approval / artifact / session items', () => {
    let s = createEntityStore();
    s = upsertConversation(s, createConversation({ id: 'c1' }));
    s = upsertRun(
      s,
      createRun({
        id: 'r1',
        conversationId: 'c1',
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    s = upsertToolExecution(
      s,
      createToolExecution({
        id: 't1',
        runId: 'r1',
        name: 'read',
        status: 'completed',
        input: { path: 'a.js' },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
    );
    s = upsertProcess(
      s,
      createProcess({
        id: 'p1',
        runId: 'r1',
        status: 'running',
        command: 'python app.py',
        startedAt: '2026-01-01T00:00:02.000Z',
      }),
    );
    s = upsertApproval(
      s,
      createApproval({
        id: 'a1',
        runId: 'r1',
        status: 'pending',
        reason: 'Destructive',
        command: 'rm -rf /tmp/x',
        createdAt: '2026-01-01T00:00:03.000Z',
      }),
    );
    s = upsertArtifact(
      s,
      createArtifact({
        id: 'art1',
        runId: 'r1',
        name: 'Report.xlsx',
        createdAt: '2026-01-01T00:00:04.000Z',
      }),
    );

    const items = buildRunTimeline(s, 'r1');
    const kinds = items.map((i) => i.kind);
    assert.ok(kinds.includes('tool'));
    assert.ok(kinds.includes('process'));
    assert.ok(kinds.includes('approval'));
    assert.ok(kinds.includes('artifact'));
    assert.ok(kinds.includes('session')); // run started

    // Chronological: session started first (sortAt = startedAt - 1)
    assert.equal(items[0].kind, 'session');
    assert.equal(items.find((i) => i.kind === 'tool')?.kind, 'tool');
    const tool = items.find((i) => i.kind === 'tool');
    assert.ok(tool && tool.kind === 'tool');
    if (tool && tool.kind === 'tool') {
      assert.equal(tool.tool.name, 'read');
    }

    // Artifact traces to run
    const art = items.find((i) => i.kind === 'artifact');
    assert.ok(art && art.kind === 'artifact');
    if (art && art.kind === 'artifact') {
      assert.equal(art.artifact.runId, 'r1');
    }
  });

  it('returns empty for missing run', () => {
    const s = createEntityStore();
    assert.deepEqual(buildRunTimeline(s, null), []);
    assert.deepEqual(buildRunTimeline(s, 'missing'), []);
  });
});

describe('conversation run markers + pending approvals', () => {
  it('marks conversations with active runs and pending approvals', () => {
    let s = createEntityStore();
    s = upsertRun(
      s,
      createRun({
        id: 'r1',
        conversationId: 'c1',
        status: 'running',
      }),
    );
    s = upsertRun(
      s,
      createRun({
        id: 'r2',
        conversationId: 'c2',
        status: 'waiting_approval',
      }),
    );
    s = upsertApproval(
      s,
      createApproval({
        id: 'ap1',
        runId: 'r2',
        status: 'pending',
        reason: 'need ok',
      }),
    );

    const markers = conversationRunMarkers(s);
    assert.equal(markers.c1?.runStatus, 'running');
    assert.equal(markers.c1?.hasPendingApproval, false);
    assert.equal(markers.c2?.runStatus, 'waiting_approval');
    assert.equal(markers.c2?.hasPendingApproval, true);

    const pending = listPendingApprovals(s);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, 'ap1');

    // Approvals persist for conversation even after focus switch
    s = setActiveConversation(s, 'c1');
    assert.equal(listPendingApprovals(s).length, 1);
    assert.equal(listPendingApprovalsForConversation(s, 'c2').length, 1);
    assert.equal(listPendingApprovalsForConversation(s, 'c1').length, 0);
  });
});
