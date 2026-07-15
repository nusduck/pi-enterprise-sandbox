/**
 * Entity store + Run Event Reducer + multi-run tests (F2).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEntityStore,
  createRun,
  createConversation,
  upsertRun,
  upsertConversation,
  setActiveConversation,
  listActiveRuns,
  listRunsForConversation,
  getRunMessages,
  getRunToolExecutions,
  isTerminalRunStatus,
} from '../src/entities/index.ts';
import {
  reduceRuntimeEvent,
  reduceRuntimeEventBatch,
  rehydrateRun,
  classifyEvent,
} from '../src/shared/state/runReducer.ts';
import { makeRuntimeEvent } from '../src/shared/schemas/events.ts';

function ev(
  partial: Parameters<typeof makeRuntimeEvent>[0],
) {
  return makeRuntimeEvent(partial);
}

describe('entity store', () => {
  it('creates empty normalized maps', () => {
    const s = createEntityStore();
    assert.deepEqual(s.conversationsById, {});
    assert.deepEqual(s.runsById, {});
    assert.equal(s.activeConversationId, null);
  });

  it('links run IDs onto conversation without nesting payloads', () => {
    let s = createEntityStore();
    s = upsertConversation(s, createConversation({ id: 'c1', title: 'Hi' }));
    s = upsertRun(
      s,
      createRun({ id: 'r1', conversationId: 'c1', status: 'running' }),
    );
    assert.ok(s.runsById.r1);
    assert.deepEqual(s.conversationsById.c1.runIds, ['r1']);
    assert.equal(s.runsById.r1.messageIds.length, 0);
  });

  it('setActiveConversation does not remove background runs', () => {
    let s = createEntityStore();
    s = upsertRun(
      s,
      createRun({ id: 'r1', conversationId: 'c1', status: 'running' }),
    );
    s = upsertRun(
      s,
      createRun({ id: 'r2', conversationId: 'c2', status: 'running' }),
    );
    s = setActiveConversation(s, 'c2');
    assert.equal(s.activeConversationId, 'c2');
    assert.equal(s.activeRunId, 'r2');
    // Both runs still in store
    assert.equal(listActiveRuns(s).length, 2);
    assert.equal(listRunsForConversation(s, 'c1').length, 1);
  });
});

describe('run event reducer', () => {
  it('applies run lifecycle and message deltas immutably', () => {
    let s = createEntityStore();
    let r = reduceRuntimeEvent(
      s,
      ev({
        event_id: 'e1',
        sequence: 1,
        run_id: 'run_a',
        type: 'run.created',
        payload: { conversation_id: 'c1' },
      }),
    );
    assert.equal(r.outcome, 'applied');
    s = r.store;
    assert.equal(s.runsById.run_a.status, 'queued');
    assert.equal(s.runsById.run_a.conversationId, 'c1');

    r = reduceRuntimeEvent(
      s,
      ev({
        event_id: 'e2',
        sequence: 2,
        run_id: 'run_a',
        type: 'run.started',
      }),
    );
    s = r.store;
    assert.equal(s.runsById.run_a.status, 'running');

    r = reduceRuntimeEvent(
      s,
      ev({
        event_id: 'e3',
        sequence: 3,
        run_id: 'run_a',
        type: 'message.started',
        payload: { message_id: 'm1', role: 'assistant' },
      }),
    );
    s = r.store;

    r = reduceRuntimeEvent(
      s,
      ev({
        event_id: 'e4',
        sequence: 4,
        run_id: 'run_a',
        type: 'message.delta',
        payload: { message_id: 'm1', text: 'Hello' },
      }),
    );
    s = r.store;
    const before = s.messagesById.m1;

    r = reduceRuntimeEvent(
      s,
      ev({
        event_id: 'e5',
        sequence: 5,
        run_id: 'run_a',
        type: 'message.delta',
        payload: { message_id: 'm1', text: ' world' },
      }),
    );
    s = r.store;

    // New message entity snapshot — no in-place mutation
    assert.notEqual(s.messagesById.m1, before);
    assert.equal(s.messagesById.m1.text, 'Hello world');
    assert.equal(getRunMessages(s, 'run_a').length, 1);

    r = reduceRuntimeEvent(
      s,
      ev({
        event_id: 'e6',
        sequence: 6,
        run_id: 'run_a',
        type: 'run.completed',
      }),
    );
    s = r.store;
    assert.equal(s.runsById.run_a.status, 'succeeded');
    assert.equal(s.messagesById.m1.status, 'complete');
    assert.ok(isTerminalRunStatus(s.runsById.run_a.status));
  });

  it('dedupes by event_id and sequence', () => {
    let s = createEntityStore();
    const event = ev({
      event_id: 'dup1',
      sequence: 1,
      run_id: 'run_d',
      type: 'run.started',
    });
    s = reduceRuntimeEvent(s, event).store;
    const again = reduceRuntimeEvent(s, event);
    assert.equal(again.outcome, 'duplicate');
    assert.equal(again.store.runsById.run_d.lastSequence, 1);

    // Same sequence, different id still treated as duplicate (already past)
    const sameSeq = reduceRuntimeEvent(
      s,
      ev({
        event_id: 'dup2',
        sequence: 1,
        run_id: 'run_d',
        type: 'run.started',
      }),
    );
    assert.equal(sameSeq.outcome, 'duplicate');
  });

  it('detects out-of-order and gap sequences', () => {
    let s = createEntityStore();
    s = reduceRuntimeEvent(
      s,
      ev({
        event_id: 'o1',
        sequence: 1,
        run_id: 'run_o',
        type: 'run.created',
      }),
    ).store;
    s = reduceRuntimeEvent(
      s,
      ev({
        event_id: 'o2',
        sequence: 2,
        run_id: 'run_o',
        type: 'run.started',
      }),
    ).store;

    // Out of order (behind)
    const behind = classifyEvent(
      s,
      ev({
        event_id: 'o0',
        sequence: 1,
        run_id: 'run_o',
        type: 'run.created',
      }),
    );
    assert.equal(behind, 'out_of_order');

    // Gap (jump ahead)
    const gap = reduceRuntimeEvent(
      s,
      ev({
        event_id: 'o5',
        sequence: 5,
        run_id: 'run_o',
        type: 'message.delta',
        payload: { text: 'x' },
      }),
    );
    assert.equal(gap.outcome, 'gap');
    assert.equal(gap.sequenceGap, true);
    // Still applied (cursor advances) so resume can continue
    assert.equal(gap.store.runsById.run_o.lastSequence, 5);
  });

  it('tracks tool, approval, process, artifact via IDs on run', () => {
    let s = createEntityStore();
    const batch = reduceRuntimeEventBatch(s, [
      ev({
        event_id: 't1',
        sequence: 1,
        run_id: 'run_t',
        type: 'run.started',
      }),
      ev({
        event_id: 't2',
        sequence: 2,
        run_id: 'run_t',
        type: 'tool.started',
        payload: { tool_call_id: 'tc1', name: 'bash', args: { cmd: 'ls' } },
      }),
      ev({
        event_id: 't3',
        sequence: 3,
        run_id: 'run_t',
        type: 'tool.approval_required',
        payload: {
          approval_id: 'ap1',
          idempotency_key: 'approval_scope_1',
          tool_call_id: 'tc1',
          reason: 'network',
        },
      }),
      ev({
        event_id: 't4',
        sequence: 4,
        run_id: 'run_t',
        type: 'process.started',
        payload: { process_id: 'p1', command: 'ls' },
      }),
      ev({
        event_id: 't5',
        sequence: 5,
        run_id: 'run_t',
        type: 'process.stdout',
        payload: { process_id: 'p1', text: 'file.txt\n' },
      }),
      ev({
        event_id: 't6',
        sequence: 6,
        run_id: 'run_t',
        type: 'artifact.created',
        payload: { artifact_id: 'a1', name: 'out.pdf' },
      }),
      ev({
        event_id: 't7',
        sequence: 7,
        run_id: 'run_t',
        type: 'tool.completed',
        payload: { tool_call_id: 'tc1', result: { ok: true } },
      }),
    ]);
    s = batch.store;
    assert.equal(batch.applied, 7);
    const run = s.runsById.run_t;
    assert.deepEqual(run.toolExecutionIds, ['tc1']);
    assert.deepEqual(run.approvalIds, ['ap1']);
    assert.deepEqual(run.processIds, ['p1']);
    assert.deepEqual(run.artifactIds, ['a1']);
    assert.equal(s.approvalsById.ap1.status, 'pending');
    assert.equal(s.approvalsById.ap1.idempotencyKey, 'approval_scope_1');
    assert.equal(s.toolExecutionsById.tc1.status, 'completed');
    assert.equal(s.processesById.p1.stdout, 'file.txt\n');
    assert.equal(getRunToolExecutions(s, 'run_t')[0].name, 'bash');

    // A repeated SSE notification for the same durable approval is an update,
    // not a second UI card (backend idempotency remains authoritative).
    s = reduceRuntimeEvent(
      s,
      ev({
        event_id: 't8',
        sequence: 8,
        run_id: 'run_t',
        type: 'tool.approval_required',
        payload: {
          approval_id: 'ap1',
          tool_call_id: 'tc2',
          reason: 'same operation after resume',
        },
      }),
    ).store;
    assert.deepEqual(s.runsById.run_t.approvalIds, ['ap1']);
    assert.equal(Object.keys(s.approvalsById).length, 1);
  });

  it('updates multiple runs independently', () => {
    let s = createEntityStore();
    s = reduceRuntimeEventBatch(s, [
      ev({
        event_id: 'm1',
        sequence: 1,
        run_id: 'run_x',
        type: 'run.started',
      }),
      ev({
        event_id: 'm2',
        sequence: 1,
        run_id: 'run_y',
        type: 'run.started',
      }),
      ev({
        event_id: 'm3',
        sequence: 2,
        run_id: 'run_x',
        type: 'message.delta',
        payload: { message_id: 'mx', text: 'from X' },
      }),
      ev({
        event_id: 'm4',
        sequence: 2,
        run_id: 'run_y',
        type: 'message.delta',
        payload: { message_id: 'my', text: 'from Y' },
      }),
      ev({
        event_id: 'm5',
        sequence: 3,
        run_id: 'run_x',
        type: 'run.completed',
      }),
    ]).store;

    assert.equal(s.runsById.run_x.status, 'succeeded');
    assert.equal(s.runsById.run_y.status, 'running');
    assert.equal(s.messagesById.mx.text, 'from X');
    assert.equal(s.messagesById.my.text, 'from Y');
    assert.equal(s.runsById.run_x.lastSequence, 3);
    assert.equal(s.runsById.run_y.lastSequence, 2);
  });

  it('rehydrates in-progress run and resumes sequence', () => {
    let s = createEntityStore();
    s = rehydrateRun(s, {
      run_id: 'run_rh',
      conversation_id: 'c9',
      status: 'running',
      last_sequence: 10,
      last_event_id: 'evt_10',
    });
    assert.equal(s.runsById.run_rh.lastSequence, 10);
    assert.equal(s.runsById.run_rh.status, 'running');

    // Events at or below last_sequence are duplicates
    const dup = reduceRuntimeEvent(
      s,
      ev({
        event_id: 'evt_10',
        sequence: 10,
        run_id: 'run_rh',
        type: 'message.delta',
        payload: { text: 'skip' },
      }),
    );
    assert.equal(dup.outcome, 'duplicate');

    // Resume from 11
    const next = reduceRuntimeEvent(
      s,
      ev({
        event_id: 'evt_11',
        sequence: 11,
        run_id: 'run_rh',
        type: 'message.delta',
        payload: { message_id: 'm_rh', text: 'resumed' },
      }),
    );
    assert.equal(next.outcome, 'applied');
    assert.equal(next.store.runsById.run_rh.lastSequence, 11);
    assert.equal(next.store.messagesById.m_rh.text, 'resumed');
  });
});
