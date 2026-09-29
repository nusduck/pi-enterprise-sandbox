/**
 * Entity bridge ingest: the Agent stream carries platform events only, so a
 * wire frame has exactly one path — normalize → reducer → EntityStore.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityBridge } from '../src/features/chat/entityBridge.ts';
import { runHasTurnEntities } from '../src/features/chat/projections/turnItems.ts';
import {
  frame,
  ingestAll,
  messageCompleted,
  messageDelta,
  runCompleted,
  runFailed,
  runStarted,
  toolCompleted,
  toolStarted,
} from './support/platformEvents.ts';

const textOf = (bridge: ReturnType<typeof createEntityBridge>, runId: string) => {
  const store = bridge.getStore();
  return store.runsById[runId].messageIds.map((id) => store.messagesById[id].text).join('');
};

describe('entity bridge event ingest', () => {
  it('reduces a full turn — text, tool, completion — into one Run', () => {
    const bridge = createEntityBridge();
    const runId = bridge.beginRun({ conversationId: 'c1' });
    ingestAll(bridge, runId, [
      runStarted(1),
      messageDelta(2, 'Hi'),
      toolStarted(3, 'tc', 'read'),
      toolCompleted(4, 'tc', 'data'),
      messageCompleted(5),
      runCompleted(6),
    ]);
    const run = bridge.getStore().runsById[runId];
    assert.equal(run.status, 'succeeded');
    assert.ok(run.toolExecutionIds.includes('tc'));
    assert.equal(textOf(bridge, runId), 'Hi');
    bridge.dispose();
  });

  it('reduces multi-run events once without cross-talk', () => {
    const bridge = createEntityBridge();
    const r1 = bridge.beginRun({ conversationId: 'c1' });
    const r2 = bridge.beginRun({ conversationId: 'c2' });

    ingestAll(bridge, r1, [messageDelta(1, 'A', 'm_r1')]);
    ingestAll(bridge, r2, [messageDelta(1, 'B', 'm_r2')]);
    ingestAll(bridge, r1, [messageDelta(2, 'A2', 'm_r1')]);

    // Switch conversation focus — must not clear runs
    bridge.focusConversation('c2');
    const store = bridge.getStore();
    assert.equal(store.activeConversationId, 'c2');
    assert.ok(store.runsById[r1]);
    assert.ok(store.runsById[r2]);
    assert.equal(textOf(bridge, r1), 'AA2');
    assert.equal(textOf(bridge, r2), 'B');
    bridge.dispose();
  });

  it('keeps background create-run and run.started from stealing a newer selection', () => {
    const bridge = createEntityBridge();
    bridge.focusConversation('conv_b');
    bridge.beginRun({ runId: 'run_a', conversationId: 'conv_a', focus: false });
    ingestAll(bridge, 'run_a', [frame(1, 'run.started', { conversation_id: 'conv_a' })]);
    assert.equal(bridge.getStore().activeConversationId, 'conv_b');
    assert.equal(bridge.getStore().activeRunId, null);
    assert.equal(bridge.getStore().runsById.run_a?.conversationId, 'conv_a');
    bridge.dispose();
  });

  it('keeps tool calls in the EntityStore, never as message text', () => {
    const bridge = createEntityBridge();
    const runId = bridge.beginRun({ conversationId: 'c-tools' });
    // Text → tool → text: the turn the duplicate-rendering bug came from.
    ingestAll(bridge, runId, [
      messageDelta(1, 'Let me search.'),
      toolStarted(2, 't1', 'web_search'),
      toolCompleted(3, 't1', 'ok'),
      runCompleted(4),
    ]);
    assert.deepEqual(bridge.getStore().runsById[runId].toolExecutionIds, ['t1']);
    assert.equal(textOf(bridge, runId), 'Let me search.');
    bridge.dispose();
  });

  it('keeps a run that only ran tools renderable through its tool entities', () => {
    const bridge = createEntityBridge();
    const runId = bridge.beginRun({ conversationId: 'c-tool-only' });
    ingestAll(bridge, runId, [toolStarted(1, 't1', 'bash'), toolCompleted(2, 't1', 'ok')]);
    assert.equal(runHasTurnEntities(bridge.getStore(), runId), true);
    bridge.dispose();
  });

  it('keeps fetch controllers isolated per background run', () => {
    const bridge = createEntityBridge();
    const r1 = bridge.beginRun({ conversationId: 'c1' });
    const r2 = bridge.beginRun({ conversationId: 'c2' });
    const c1 = new AbortController();
    const c2 = new AbortController();
    bridge.attachTransport(r1, c1);
    bridge.attachTransport(r2, c2);

    bridge.focusConversation('c1');
    bridge.abortRun(r1);
    assert.equal(c1.signal.aborted, true);
    assert.equal(c2.signal.aborted, false);
    bridge.dispose();
    assert.equal(c2.signal.aborted, true);
  });

  it('keeps a failed terminal status and its reason', () => {
    const bridge = createEntityBridge();
    const runId = bridge.beginRun({ conversationId: 'c1' });
    ingestAll(bridge, runId, [runFailed(1, 'boom')]);
    const run = bridge.getStore().runsById[runId];
    assert.equal(run.status, 'failed');
    assert.equal(run.error, 'boom');
    bridge.dispose();
  });

  it('records the trace id of the run', () => {
    const bridge = createEntityBridge();
    const runId = bridge.beginRun({ conversationId: 'c1', sessionId: 's1' });
    ingestAll(bridge, runId, [frame(1, 'run.trace', { trace_id: 'trace_1' })]);
    assert.equal(bridge.getStore().runsById[runId].traceId, 'trace_1');
    bridge.dispose();
  });

  it('ingests a durable artifact.ready event with camelCase fields', () => {
    const bridge = createEntityBridge();
    const runId = bridge.beginRun({ conversationId: 'c1' });
    ingestAll(bridge, runId, [
      frame(1, 'artifact.ready', {
        artifactId: '01M1HB102F1WTANKD5Y0C4W17X',
        name: 'report.txt',
        path: '/artifacts/01M1HB102F1WTANKD5Y0C4W17X/report.txt',
        mimeType: 'text/plain',
        sizeBytes: 123,
        sha256: 'deadbeef',
        targetSessionId: 'sess_1',
      }),
    ]);
    const artifact = bridge.getStore().artifactsById['01M1HB102F1WTANKD5Y0C4W17X'];
    assert.ok(artifact);
    assert.equal(artifact.name, 'report.txt');
    assert.equal(artifact.mimeType, 'text/plain');
    assert.equal(artifact.size, 123);
    bridge.dispose();
  });

  it('drops a frame that cannot be normalized instead of guessing a meaning', () => {
    const bridge = createEntityBridge();
    const runId = bridge.beginRun({ conversationId: 'c1' });
    // Pre-platform vocabulary: no durable id or sequence, undotted type.
    bridge.ingestAgentEvent(runId, { type: 'token', text: 'ghost' } as never);
    bridge.ingestAgentEvent(runId, { type: 'done' } as never);
    const run = bridge.getStore().runsById[runId];
    assert.equal(run.messageIds.length, 0);
    assert.equal(run.status, 'queued');
    bridge.dispose();
  });

  it('stamps client-side interrupt markers after the last durable sequence', () => {
    const bridge = createEntityBridge();
    const runId = bridge.beginRun({ conversationId: 'c1' });
    ingestAll(bridge, runId, [runStarted(1), messageDelta(2, 'partial')]);
    bridge.interruptRun(runId, 'User stopped the run');
    const run = bridge.getStore().runsById[runId];
    assert.equal(run.status, 'interrupted');
    assert.ok((run.lastSequence ?? 0) > 2);
    bridge.dispose();
  });
});
