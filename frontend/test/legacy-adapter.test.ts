/**
 * Legacy /chat SSE → RuntimeEvent adapter tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptLegacyStream,
  createLegacyAdapterState,
  legacyEventToRuntime,
} from '../src/shared/sse/legacyAdapter.ts';
import { createEntityStore } from '../src/entities/index.ts';
import { reduceRuntimeEventBatch } from '../src/shared/state/runReducer.ts';
import { createEntityBridge } from '../src/features/chat/entityBridge.ts';

describe('legacy SSE adapter', () => {
  it('maps token stream to message.started + message.delta', () => {
    const { events } = adaptLegacyStream('run_leg', [
      { type: 'session', session_id: 'sess1', conversation_id: 'c1' },
      { type: 'token', text: 'Hel' },
      { type: 'token', text: 'lo' },
      { type: 'done' },
    ]);

    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      'run.started',
      'message.started',
      'message.delta',
      'message.delta',
      'message.completed',
      'run.completed',
    ]);
    assert.equal(events[0].session_id, 'sess1');
    assert.equal(events[2].payload.text, 'Hel');
    assert.equal(events[3].payload.text, 'lo');
    // Sequences are monotonic
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].sequence > events[i - 1].sequence);
    }
  });

  it('maps tools, approvals, artifacts', () => {
    const { events } = adaptLegacyStream('run_t', [
      { type: 'tool_start', id: 't1', name: 'bash', args: { cmd: 'ls' } },
      { type: 'approval_required', approval_id: 'ap1', reason: 'sudo' },
      { type: 'tool_end', id: 't1', result: 'ok', isError: false },
      {
        type: 'file_ready',
        artifact_id: 'art1',
        name: 'out.txt',
        path: '/tmp/out.txt',
      },
    ]);
    const types = events.map((e) => e.type);
    assert.ok(types.includes('tool.started'));
    assert.ok(types.includes('tool.approval_required'));
    assert.ok(types.includes('tool.completed'));
    assert.ok(types.includes('artifact.created'));
  });

  it('feeds adapter output into reducer without currentMsg', () => {
    const { events } = adaptLegacyStream('run_full', [
      { type: 'session', session_id: 's1' },
      { type: 'token', text: 'Hi' },
      { type: 'tool_start', name: 'read', id: 'tc' },
      { type: 'tool_end', id: 'tc', result: 'data' },
      { type: 'done' },
    ]);
    const { store } = reduceRuntimeEventBatch(createEntityStore(), events);
    assert.equal(store.runsById.run_full.status, 'succeeded');
    assert.ok(store.runsById.run_full.messageIds.length >= 1);
    assert.ok(store.runsById.run_full.toolExecutionIds.includes('tc'));
    const msgId = store.runsById.run_full.messageIds[0];
    assert.equal(store.messagesById[msgId].text, 'Hi');
  });

  it('entity bridge reduces multi-run events once without cross-talk', () => {
    const bridge = createEntityBridge();
    const r1 = bridge.beginRun({ conversationId: 'c1' });
    const r2 = bridge.beginRun({ conversationId: 'c2' });

    bridge.ingestLegacyEvent(r1, { type: 'token', text: 'A' });
    bridge.ingestLegacyEvent(r2, { type: 'token', text: 'B' });
    bridge.ingestLegacyEvent(r1, { type: 'token', text: 'A2' });

    // Switch conversation focus — must not clear runs
    bridge.focusConversation('c2');
    const store = bridge.getStore();
    assert.equal(store.activeConversationId, 'c2');
    assert.ok(store.runsById[r1]);
    assert.ok(store.runsById[r2]);

    const msgs1 = bridge.projectRunMessages(r1);
    const msgs2 = bridge.projectRunMessages(r2);
    assert.equal(msgs1[0]?.content[0] && 'text' in msgs1[0].content[0]
      ? msgs1[0].content[0].text
      : '', 'AA2');
    assert.equal(msgs2[0]?.content[0] && 'text' in msgs2[0].content[0]
      ? msgs2[0].content[0].text
      : '', 'B');

    bridge.dispose();
  });

  it('keeps legacy fetch controllers isolated per background run', () => {
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

  it('keeps successful terminal status when session_closed follows done', () => {
    const { events } = adaptLegacyStream('run_terminal', [
      { type: 'session', session_id: 's1', conversation_id: 'c1' },
      { type: 'token', text: 'ok' },
      { type: 'done' },
      { type: 'session_closed', session_id: 's1' },
    ]);
    const { store } = reduceRuntimeEventBatch(createEntityStore(), events);
    assert.equal(store.runsById.run_terminal.status, 'succeeded');
    assert.equal(
      events.filter((event) => event.type === 'run.status_changed').length,
      0,
    );
  });

  it('does not let done overwrite a preceding failure', () => {
    const { events } = adaptLegacyStream('run_failed', [
      { type: 'error', message: 'boom' },
      { type: 'done' },
      { type: 'session_closed' },
    ]);
    const { store } = reduceRuntimeEventBatch(createEntityStore(), events);
    assert.equal(store.runsById.run_failed.status, 'failed');
    assert.equal(store.runsById.run_failed.error, 'boom');
  });

  it('maps trace and agent session into the normalized store', () => {
    const bridge = createEntityBridge();
    const runId = bridge.beginRun({ conversationId: 'c1', sessionId: 's1' });
    bridge.ingestLegacyEvent(runId, { type: 'trace', trace_id: 'trace_1' });
    bridge.ingestLegacyEvent(runId, {
      type: 'agent_session',
      agent_session_id: 'asess_1',
      conversation_id: 'c1',
      workspace_id: 'conv_c1',
      restored: true,
    });
    const store = bridge.getStore();
    assert.equal(store.runsById[runId].traceId, 'trace_1');
    assert.equal(store.runsById[runId].agentSessionId, 'asess_1');
    assert.equal(store.agentSessionsById.asess_1.workspaceId, 'conv_c1');
    bridge.dispose();
  });

  it('createLegacyAdapterState seeds conversation/session', () => {
    const st = createLegacyAdapterState({
      runId: 'r',
      conversationId: 'c',
      sessionId: 's',
    });
    const out = legacyEventToRuntime(st, { type: 'token', text: 'x' });
    assert.ok(out.some((e) => e.type === 'message.delta'));
    assert.equal(st.sessionId, 's');
  });
});
