/**
 * PR-11 high-value tests: unified platform reducer, recovery, permission/display
 * boundaries (bash ≠ approval, artifact = submit only), memory caps, replay merge.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityStore } from '../src/entities/index.ts';
import {
  reducePlatformEvent,
  reducePlatformEventBatch,
  reduceRuntimeEvent,
  rehydrateRun,
  rehydrateToolExecutions,
} from '../src/shared/state/runReducer.ts';
import {
  PROCESS_LOG_CHAR_CAP,
  appendCappedLog,
  inferToolSource,
  isExternalRiskApproval,
  normalizeToRuntimeEvent,
} from '../src/shared/state/platformEventNormalize.ts';
import { makeRuntimeEvent } from '../src/shared/schemas/events.ts';
import { createEntityBridge } from '../src/features/chat/entityBridge.ts';

function platform(
  partial: {
    eventId: string;
    sequence: number;
    type: string;
    runId?: string;
    data?: Record<string, unknown>;
    timestamp?: string;
  },
) {
  return {
    eventId: partial.eventId,
    eventVersion: 1,
    sequence: partial.sequence,
    type: partial.type,
    timestamp: partial.timestamp || '2026-07-18T00:00:00.000Z',
    context: {
      orgId: '01HZORG0000000000000000000',
      userId: '01HZUSER000000000000000000',
      runId: partial.runId || '01HZRUN0000000000000000000',
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
    },
    data: partial.data || {},
  };
}

describe('normalizeToRuntimeEvent', () => {
  it('maps platform tool.execution.* and artifact.ready', () => {
    const ev = normalizeToRuntimeEvent(
      platform({
        eventId: '01HZEVT0000000000000000001',
        sequence: 3,
        type: 'tool.execution.started',
        data: { toolCallId: 'tc1', name: 'bash', args: { command: 'ls' } },
      }),
    );
    assert.ok(ev);
    assert.equal(ev!.type, 'tool.started');
    assert.equal(ev!.payload.tool_call_id, 'tc1');

    const art = normalizeToRuntimeEvent(
      platform({
        eventId: '01HZEVT0000000000000000002',
        sequence: 4,
        type: 'artifact.ready',
        data: { artifactId: 'art1', name: 'out.pdf', sha256: 'abc' },
      }),
    );
    assert.ok(art);
    assert.equal(art!.type, 'artifact.created');
    assert.equal(art!.payload.source, 'submit_artifact');
    assert.equal(art!.payload.artifact_id, 'art1');
  });

  it('unwraps BFF relay { sequence, event }', () => {
    const ev = normalizeToRuntimeEvent({
      sequence: 9,
      event: {
        event_id: 'relay_9',
        run_id: 'run_r',
        type: 'run.started',
        payload: {},
      },
    });
    assert.ok(ev);
    assert.equal(ev!.sequence, 9);
    assert.equal(ev!.event_id, 'relay_9');
  });
});

describe('unified platform reducer', () => {
  it('applies platform tool/process/approval/dataset/artifact chain', () => {
    const runId = '01HZRUN0000000000000000001';
    const { store, applied } = reducePlatformEventBatch(createEntityStore(), [
      platform({
        eventId: '01HZEVT0000000000000000010',
        sequence: 1,
        type: 'run.started',
        runId,
        data: { conversation_id: 'conv1' },
      }),
      platform({
        eventId: '01HZEVT0000000000000000011',
        sequence: 2,
        type: 'tool.execution.started',
        runId,
        data: { toolCallId: 'tc_bash', name: 'bash', args: { command: 'pwd' } },
      }),
      platform({
        eventId: '01HZEVT0000000000000000012',
        sequence: 3,
        type: 'process.started',
        runId,
        data: { processId: 'p1', command: 'pwd', toolCallId: 'tc_bash' },
      }),
      platform({
        eventId: '01HZEVT0000000000000000013',
        sequence: 4,
        type: 'process.output',
        runId,
        data: { processId: 'p1', stream: 'stdout', text: '/workspace\n', cursor: 11 },
      }),
      platform({
        eventId: '01HZEVT0000000000000000014',
        sequence: 5,
        type: 'process.completed',
        runId,
        data: { processId: 'p1', exitCode: 0 },
      }),
      platform({
        eventId: '01HZEVT0000000000000000015',
        sequence: 6,
        type: 'tool.execution.completed',
        runId,
        data: { toolCallId: 'tc_bash', result: { ok: true } },
      }),
      platform({
        eventId: '01HZEVT0000000000000000016',
        sequence: 7,
        type: 'approval.requested',
        runId,
        data: {
          approvalId: 'ap_net',
          toolCallId: 'tc_http',
          tool_name: 'http_request',
          reason: 'external network',
          risk: 'high',
        },
      }),
      platform({
        eventId: '01HZEVT0000000000000000017',
        sequence: 8,
        type: 'dataset.ready',
        runId,
        data: {
          datasetId: 'ds1',
          name: 'sales.csv',
          path: 'datasets/sales.csv',
          sizeBytes: 1200,
        },
      }),
      platform({
        eventId: '01HZEVT0000000000000000018',
        sequence: 9,
        type: 'artifact.ready',
        runId,
        data: {
          artifactId: 'art1',
          name: 'report.xlsx',
          sha256: 'deadbeef',
          description: 'Q1 report',
        },
      }),
    ]);

    assert.ok(applied >= 9);
    assert.equal(store.toolExecutionsById.tc_bash.status, 'completed');
    assert.equal(store.toolExecutionsById.tc_bash.source, 'sandbox');
    assert.equal(store.processesById.p1.stdout, '/workspace\n');
    assert.equal(store.processesById.p1.status, 'completed');
    assert.equal(store.approvalsById.ap_net.status, 'pending');
    assert.equal(store.approvalsById.ap_net.risk, 'high');
    assert.equal(store.datasetsById.ds1.status, 'ready');
    assert.equal(store.datasetsById.ds1.path, 'datasets/sales.csv');
    assert.equal(store.artifactsById.art1.source, 'submit_artifact');
    assert.equal(store.artifactsById.art1.sha256, 'deadbeef');
    assert.equal(store.artifactsById.art1.description, 'Q1 report');
    assert.ok(store.runsById[runId].traceSpanIds.length >= 1);
  });

  it('dedupes replay + live overlap; gap does not advance cursor', () => {
    const runId = 'run_merge';
    let s = createEntityStore();
    const seen = new Set<string>();
    const events = [
      makeRuntimeEvent({
        event_id: 'e1',
        sequence: 1,
        run_id: runId,
        type: 'run.started',
      }),
      makeRuntimeEvent({
        event_id: 'e2',
        sequence: 2,
        run_id: runId,
        type: 'tool.started',
        payload: { tool_call_id: 't1', name: 'read' },
      }),
      makeRuntimeEvent({
        event_id: 'e3',
        sequence: 3,
        run_id: runId,
        type: 'tool.completed',
        payload: { tool_call_id: 't1', result: 'ok' },
      }),
    ];
    // Historical replay
    s = reducePlatformEventBatch(s, events, { seenEventIds: seen }).store;
    // Live re-delivery of same events (SSE catch-up overlap)
    const live = reducePlatformEventBatch(s, events, { seenEventIds: seen });
    assert.equal(live.applied, 0);
    assert.equal(live.skipped, 3);
    assert.equal(s.toolExecutionsById.t1.status, 'completed');

    // Gap: do NOT apply, cursor stays at 3
    const gap = reducePlatformEvent(
      live.store,
      makeRuntimeEvent({
        event_id: 'e5',
        sequence: 5,
        run_id: runId,
        type: 'message.delta',
        payload: { message_id: 'm1', text: 'hi' },
      }),
      { seenEventIds: seen },
    );
    assert.equal(gap.outcome, 'gap');
    assert.equal(gap.sequenceGap, true);
    assert.equal(gap.store.runsById[runId].lastSequence, 3);
    assert.equal(gap.appliedSequence, null);
    assert.equal(gap.store.messagesById.m1, undefined);

    // Next contiguous event still applies after gap was skipped
    const next = reducePlatformEvent(
      gap.store,
      makeRuntimeEvent({
        event_id: 'e4',
        sequence: 4,
        run_id: runId,
        type: 'message.delta',
        payload: { message_id: 'm1', text: 'late' },
      }),
      { seenEventIds: seen },
    );
    assert.equal(next.outcome, 'applied');
    assert.equal(next.store.runsById[runId].lastSequence, 4);
    assert.equal(next.store.messagesById.m1.text, 'late');
  });

  it('sequence order 1,3,2: gap at 3 leaves cursor at 1; then 2 and 3 apply', () => {
    const runId = 'run_gap_order';
    let s = createEntityStore();
    s = reducePlatformEvent(
      s,
      makeRuntimeEvent({
        event_id: 'g1',
        sequence: 1,
        run_id: runId,
        type: 'run.started',
      }),
    ).store;
    assert.equal(s.runsById[runId].lastSequence, 1);

    const g3 = reducePlatformEvent(
      s,
      makeRuntimeEvent({
        event_id: 'g3',
        sequence: 3,
        run_id: runId,
        type: 'message.delta',
        payload: { message_id: 'm', text: 'three' },
      }),
    );
    assert.equal(g3.outcome, 'gap');
    assert.equal(g3.store.runsById[runId].lastSequence, 1);
    assert.equal(g3.store.messagesById.m, undefined);

    const g2 = reducePlatformEvent(
      g3.store,
      makeRuntimeEvent({
        event_id: 'g2',
        sequence: 2,
        run_id: runId,
        type: 'message.delta',
        payload: { message_id: 'm', text: 'two' },
      }),
    );
    assert.equal(g2.outcome, 'applied');
    assert.equal(g2.store.runsById[runId].lastSequence, 2);
    assert.equal(g2.store.messagesById.m.text, 'two');

    const g3b = reducePlatformEvent(
      g2.store,
      makeRuntimeEvent({
        event_id: 'g3',
        sequence: 3,
        run_id: runId,
        type: 'message.delta',
        payload: { message_id: 'm', text: 'three' },
      }),
    );
    assert.equal(g3b.outcome, 'applied');
    assert.equal(g3b.store.runsById[runId].lastSequence, 3);
    assert.equal(g3b.store.messagesById.m.text, 'twothree');
  });

  it('new run with sequence > 1 is a gap; batch only applies contiguous prefix', () => {
    const runId = 'run_new_gap';
    const cold = reducePlatformEvent(
      createEntityStore(),
      makeRuntimeEvent({
        event_id: 'n5',
        sequence: 5,
        run_id: runId,
        type: 'run.started',
      }),
    );
    assert.equal(cold.outcome, 'gap');
    assert.equal(cold.store.runsById[runId], undefined);

    // Unsorted hole: 1,2,4,5 → only 1,2 apply after sort
    const batch = reducePlatformEventBatch(createEntityStore(), [
      makeRuntimeEvent({
        event_id: 'b4',
        sequence: 4,
        run_id: runId,
        type: 'message.delta',
        payload: { message_id: 'm', text: '4' },
      }),
      makeRuntimeEvent({
        event_id: 'b1',
        sequence: 1,
        run_id: runId,
        type: 'run.started',
      }),
      makeRuntimeEvent({
        event_id: 'b2',
        sequence: 2,
        run_id: runId,
        type: 'message.delta',
        payload: { message_id: 'm', text: '2' },
      }),
      makeRuntimeEvent({
        event_id: 'b5',
        sequence: 5,
        run_id: runId,
        type: 'message.delta',
        payload: { message_id: 'm', text: '5' },
      }),
    ]);
    assert.equal(batch.applied, 2);
    assert.ok(batch.gaps >= 1);
    assert.equal(batch.store.runsById[runId].lastSequence, 2);
    assert.equal(batch.store.messagesById.m?.text, '2');
  });

  it('missing durable artifact_id does not create downloadable Artifact; cursor still advances', () => {
    const runId = 'run_art_nodurable';
    let s = createEntityStore();
    s = reducePlatformEvent(
      s,
      makeRuntimeEvent({
        event_id: 'a1',
        sequence: 1,
        run_id: runId,
        type: 'run.started',
      }),
    ).store;
    // Path-only / synthetic id (adapter art_<runId>_<seq>)
    s = reducePlatformEvent(
      s,
      makeRuntimeEvent({
        event_id: 'a2',
        sequence: 2,
        run_id: runId,
        type: 'artifact.created',
        payload: {
          artifact_id: `art_${runId}_2`,
          path: 'workspace/out.txt',
          name: 'out.txt',
        },
      }),
    ).store;
    assert.equal(s.runsById[runId].lastSequence, 2);
    assert.equal(Object.keys(s.artifactsById).length, 0);
    assert.deepEqual(s.runsById[runId].artifactIds, []);

    // Missing id entirely
    s = reducePlatformEvent(
      s,
      makeRuntimeEvent({
        event_id: 'a3',
        sequence: 3,
        run_id: runId,
        type: 'artifact.created',
        payload: { path: 'workspace/x.txt', name: 'x.txt' },
      }),
    ).store;
    assert.equal(s.runsById[runId].lastSequence, 3);
    assert.equal(Object.keys(s.artifactsById).length, 0);

    // Explicit server artifact_id is fine
    s = reducePlatformEvent(
      s,
      makeRuntimeEvent({
        event_id: 'a4',
        sequence: 4,
        run_id: runId,
        type: 'artifact.created',
        payload: { artifact_id: 'art_server_1', name: 'report.pdf' },
      }),
    ).store;
    assert.equal(s.runsById[runId].lastSequence, 4);
    assert.ok(s.artifactsById.art_server_1);
    assert.equal(s.artifactsById.art_server_1.source, 'submit_artifact');
  });
});

describe('permission / display boundaries', () => {
  it('ordinary bash tool start/complete does not create approval', () => {
    const { store } = reducePlatformEventBatch(createEntityStore(), [
      makeRuntimeEvent({
        event_id: 'b1',
        sequence: 1,
        run_id: 'run_bash',
        type: 'run.started',
      }),
      makeRuntimeEvent({
        event_id: 'b2',
        sequence: 2,
        run_id: 'run_bash',
        type: 'tool.started',
        payload: { tool_call_id: 'bash1', name: 'bash', args: { command: 'ls' } },
      }),
      makeRuntimeEvent({
        event_id: 'b3',
        sequence: 3,
        run_id: 'run_bash',
        type: 'tool.completed',
        payload: { tool_call_id: 'bash1', result: 'ok' },
      }),
    ]);
    assert.equal(Object.keys(store.approvalsById).length, 0);
    assert.equal(store.runsById.run_bash.status, 'running');
    assert.equal(store.toolExecutionsById.bash1.status, 'completed');
  });

  it('write tool result does not create artifact; submit_artifact does', () => {
    const { store } = reducePlatformEventBatch(createEntityStore(), [
      makeRuntimeEvent({
        event_id: 'w1',
        sequence: 1,
        run_id: 'run_w',
        type: 'run.started',
      }),
      makeRuntimeEvent({
        event_id: 'w2',
        sequence: 2,
        run_id: 'run_w',
        type: 'tool.started',
        payload: {
          tool_call_id: 'write1',
          name: 'write',
          args: { path: 'tmp/out.txt', content: 'x' },
        },
      }),
      makeRuntimeEvent({
        event_id: 'w3',
        sequence: 3,
        run_id: 'run_w',
        type: 'tool.completed',
        payload: {
          tool_call_id: 'write1',
          result: { path: 'tmp/out.txt', bytes: 1 },
        },
      }),
      makeRuntimeEvent({
        event_id: 'w4',
        sequence: 4,
        run_id: 'run_w',
        type: 'artifact.created',
        payload: {
          artifact_id: 'art_submit',
          name: 'out.txt',
          path: 'artifacts/out.txt',
        },
      }),
    ]);
    assert.equal(Object.keys(store.artifactsById).length, 1);
    assert.ok(store.artifactsById.art_submit);
    assert.equal(store.artifactsById.art_submit.source, 'submit_artifact');
    assert.equal(store.runsById.run_w.artifactIds.length, 1);
  });

  it('isExternalRiskApproval requires durable approval id', () => {
    assert.equal(isExternalRiskApproval({}), false);
    assert.equal(isExternalRiskApproval({ approval_id: 'synth_1' }), false);
    assert.equal(isExternalRiskApproval({ approval_id: 'ap_real' }), true);
  });

  it('inferToolSource classifies sandbox / mcp', () => {
    assert.equal(inferToolSource('bash', {}), 'sandbox');
    assert.equal(inferToolSource('mcp_db_query', {}), 'mcp');
    assert.equal(inferToolSource('custom', { source: 'internal' }), 'internal');
  });
});

describe('process log memory cap', () => {
  it('appendCappedLog keeps tail under PROCESS_LOG_CHAR_CAP', () => {
    const chunk = 'x'.repeat(PROCESS_LOG_CHAR_CAP + 5000);
    const { text, truncated } = appendCappedLog('', chunk);
    assert.equal(truncated, true);
    assert.ok(text.length <= PROCESS_LOG_CHAR_CAP + 64);
    assert.match(text, /truncated/);
  });

  it('reducer truncates huge process.output streams', () => {
    const huge = 'y'.repeat(PROCESS_LOG_CHAR_CAP + 2000);
    let s = createEntityStore();
    s = reduceRuntimeEvent(
      s,
      makeRuntimeEvent({
        event_id: 'p1',
        sequence: 1,
        run_id: 'run_p',
        type: 'process.started',
        payload: { process_id: 'proc1', command: 'yes' },
      }),
    ).store;
    s = reduceRuntimeEvent(
      s,
      makeRuntimeEvent({
        event_id: 'p2',
        sequence: 2,
        run_id: 'run_p',
        type: 'process.output',
        payload: { process_id: 'proc1', stream: 'stdout', text: huge },
      }),
    ).store;
    assert.equal(s.processesById.proc1.logTruncated, true);
    assert.ok(s.processesById.proc1.stdout.length < huge.length);
  });
});

describe('refresh recovery', () => {
  it('rehydrateRun + missed events restore tools and resume sequence', () => {
    let s = rehydrateRun(createEntityStore(), {
      run_id: 'run_rh',
      conversation_id: 'c1',
      status: 'running',
      last_sequence: 2,
      last_event_id: 'e2',
      session_id: 'sess1',
    });
    s = reducePlatformEventBatch(s, [
      makeRuntimeEvent({
        event_id: 'e3',
        sequence: 3,
        run_id: 'run_rh',
        type: 'tool.started',
        payload: { tool_call_id: 'tc', name: 'bash' },
      }),
    ]).store;
    s = rehydrateToolExecutions(s, 'run_rh', [
      {
        tool_call_id: 'tc',
        run_id: 'run_rh',
        status: 'executing',
        tool_name: 'bash',
        arguments: { command: 'ls' },
      },
    ]);
    assert.equal(s.runsById.run_rh.lastSequence, 3);
    assert.equal(s.toolExecutionsById.tc.status, 'running');
    assert.equal(s.toolExecutionsById.tc.source, 'sandbox');
  });

  it('replays WAITING_INPUT details after refresh with camelCase payload fields', () => {
    const runId = 'run_waiting_input';
    const result = reducePlatformEvent(
      createEntityStore(),
      platform({
        eventId: 'evt_waiting_input',
        sequence: 1,
        runId,
        type: 'run.status.changed',
        data: {
          status: 'WAITING_INPUT',
          interactionId: 'interaction_1',
          interactionType: 'select',
          title: 'Choose a region',
          message: 'Deployment target',
          options: ['eu', 'us'],
        },
      }),
    );

    assert.equal(result.store.runsById[runId].status, 'waiting_input');
    assert.deepEqual(result.store.runsById[runId].pendingInput, {
      interactionId: 'interaction_1',
      interactionType: 'select',
      title: 'Choose a region',
      message: 'Deployment target',
      options: ['eu', 'us'],
    });
  });

  it('rehydrateConversation restores tools after refresh', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('/conversations/conv_r/events')) {
        return new Response(
          JSON.stringify({
            runs: [
              {
                run_id: 'run_r',
                conversation_id: 'conv_r',
                sandbox_session_id: 'sess_r',
                status: 'completed',
              },
            ],
            events: [
              {
                run_id: 'run_r',
                sequence: 1,
                event_id: 'e1',
                type: 'tool_start',
                payload: { id: 't1', name: 'bash', args: { command: 'pwd' } },
              },
              {
                run_id: 'run_r',
                sequence: 2,
                event_id: 'e2',
                type: 'tool_end',
                payload: { id: 't1', result: '/w' },
              },
              {
                run_id: 'run_r',
                sequence: 3,
                event_id: 'e3',
                type: 'file_ready',
                payload: { artifact_id: 'a1', name: 'x.md' },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/datasets')) {
        return new Response(JSON.stringify({ datasets: [] }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    try {
      const bridge = createEntityBridge();
      await bridge.rehydrateConversation('conv_r');
      const store = bridge.getStore();
      assert.equal(store.toolExecutionsById.t1.status, 'completed');
      assert.equal(store.artifactsById.a1.source, 'submit_artifact');
      assert.equal(store.runsById.run_r.status, 'succeeded');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
