/**
 * Inline chat runtime steps — filtering + naming helpers via buildRunTimeline.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEntityStore,
  createRun,
  createToolExecution,
  createProcess,
  createApproval,
  upsertRun,
  upsertToolExecution,
  upsertProcess,
  upsertApproval,
} from '../src/entities/index.ts';
import { buildRunTimeline } from '../src/widgets/runtime-timeline/buildTimeline.ts';

/** Mirror InlineRuntimeSteps filter logic for unit coverage without React. */
function filterInlineItems(
  items: ReturnType<typeof buildRunTimeline>,
): ReturnType<typeof buildRunTimeline> {
  const toolIds = new Set(
    items.filter((i) => i.kind === 'tool').map((i) => i.tool.id),
  );
  return items.filter((item) => {
    if (item.kind === 'session') return false;
    if (
      item.kind === 'process' &&
      item.process.toolExecutionId &&
      toolIds.has(item.process.toolExecutionId)
    ) {
      return false;
    }
    return true;
  });
}

function formatToolName(name: string, source?: string): string {
  const raw = (name || 'tool').trim();
  if (raw.startsWith('mcp__')) {
    const parts = raw.slice(5).split('__').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]} / ${parts.slice(1).join(' / ')}`;
    if (parts.length === 1) return parts[0];
  }
  if (source === 'mcp') return `mcp · ${raw}`;
  return raw;
}

describe('inline runtime step filtering', () => {
  it('drops session events and process rows already linked to a tool', () => {
    let store = createEntityStore();
    const run = createRun({ id: 'run_1', conversationId: 'c1' });
    store = upsertRun(store, run);

    const tool = createToolExecution({
      id: 'tool_1',
      runId: 'run_1',
      name: 'bash',
      status: 'running',
      processId: 'proc_1',
    });
    store = upsertToolExecution(store, tool);

    const linked = createProcess({
      id: 'proc_1',
      runId: 'run_1',
      toolExecutionId: 'tool_1',
      status: 'running',
      command: 'echo hi',
    });
    store = upsertProcess(store, linked);

    const orphan = createProcess({
      id: 'proc_2',
      runId: 'run_1',
      toolExecutionId: null,
      status: 'running',
      command: 'sleep 1',
    });
    store = upsertProcess(store, orphan);

    const approval = createApproval({
      id: 'appr_1',
      runId: 'run_1',
      status: 'pending',
      reason: 'needs review',
    });
    store = upsertApproval(store, approval);

    // Need run timestamps for session items
    store = upsertRun(store, {
      ...store.runsById.run_1!,
      startedAt: '2026-01-01T00:00:00.000Z',
    });

    const all = buildRunTimeline(store, 'run_1');
    assert.ok(all.some((i) => i.kind === 'session'));
    assert.ok(all.some((i) => i.kind === 'process' && i.process.id === 'proc_1'));

    const inline = filterInlineItems(all);
    assert.equal(
      inline.some((i) => i.kind === 'session'),
      false,
      'session events stay out of chat',
    );
    assert.equal(
      inline.some((i) => i.kind === 'process' && i.process.id === 'proc_1'),
      false,
      'tool-linked process is folded into tool step',
    );
    assert.ok(
      inline.some((i) => i.kind === 'process' && i.process.id === 'proc_2'),
      'orphan process remains visible',
    );
    assert.ok(inline.some((i) => i.kind === 'tool'));
    assert.ok(inline.some((i) => i.kind === 'approval'));
  });

  it('formats MCP tool names for display', () => {
    assert.equal(
      formatToolName('mcp__risk_db__query'),
      'risk_db / query',
    );
    assert.equal(formatToolName('bash'), 'bash');
    assert.equal(formatToolName('search', 'mcp'), 'mcp · search');
  });
});
