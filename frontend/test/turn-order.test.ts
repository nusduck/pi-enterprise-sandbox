/**
 * 线性对话流的事件顺序：一轮 Run 内「思考 → 文字 → 工具 → 思考 → 文字」必须按
 * 事件 sequence 还原，实时流与刷新后的历史重放走同一个 reducer，结果一致。
 *
 * 事件形状取自真实 Run（agent 的 tbl_agsvc_run_events）：DSH 的 message/thinking
 * 事件不带 message_id，靠 reducer 隐式分段；每个模型轮次以 thinking.delta 开始，
 * 工具的 tool.execution.started 早于该轮的 message.completed。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityStore } from '../src/entities/index.ts';
import type { EntityStore } from '../src/entities/types.ts';
import { reducePlatformEventBatch, rehydrateRun } from '../src/shared/state/runReducer.ts';
import { projectTurnItems, runHasTurnEntities } from '../src/features/chat/projections/turnItems.ts';

const RUN = '01M2X8NG3Y81BMWSQ3SM7HVV60';

function ev(sequence: number, type: string, data: Record<string, unknown> = {}) {
  return {
    eventId: `01M2X8EVT${String(sequence).padStart(17, '0')}`,
    eventVersion: 1,
    sequence,
    type,
    timestamp: '2026-09-20T08:00:00.000Z',
    context: { orgId: '01M29ZHZV8VF2G344QZFM9MKDN', runId: RUN },
    data,
  };
}

/** 两个模型轮次 + 一次并行子任务，按真实顺序排列。 */
function twoTurnRun() {
  let s = 0;
  const n = () => ++s;
  return [
    ev(n(), 'run.accepted', { status: 'ACCEPTED' }),
    ev(n(), 'run.status.changed', { to: 'RUNNING', status: 'RUNNING' }),
    // turn 1
    ev(n(), 'thinking.delta', { role: 'assistant', delta: 'Plan the ' }),
    ev(n(), 'thinking.delta', { role: 'assistant', delta: 'survey.' }),
    ev(n(), 'message.delta', { role: 'assistant', delta: 'I will survey ' }),
    ev(n(), 'message.delta', { role: 'assistant', delta: 'the workspace.' }),
    ev(n(), 'thinking.completed', { role: 'assistant', text: 'Plan the survey.' }),
    ev(n(), 'tool.execution.started', {
      toolCallId: 'call_ls', toolName: 'bash', args: { command: 'ls -la' },
    }),
    ev(n(), 'message.completed', { role: 'assistant', text: 'I will survey the workspace.' }),
    ev(n(), 'tool.execution.completed', {
      toolCallId: 'call_ls', toolName: 'bash', result: { content: [{ type: 'text', text: 'total 0' }] },
    }),
    ev(n(), 'tool.execution.started', {
      toolCallId: 'call_glob', toolName: 'glob', args: { pattern: '**/*' },
    }),
    ev(n(), 'tool.execution.completed', {
      toolCallId: 'call_glob', toolName: 'glob', result: { content: [{ type: 'text', text: 'No files' }] },
    }),
    // turn 2
    ev(n(), 'thinking.delta', { role: 'assistant', delta: 'Delegate ' }),
    ev(n(), 'thinking.delta', { role: 'assistant', delta: 'to children.' }),
    ev(n(), 'message.delta', { role: 'assistant', delta: 'Dispatching two children.' }),
    ev(n(), 'thinking.completed', { role: 'assistant', text: 'Delegate to children.' }),
    ev(n(), 'tool.execution.started', {
      toolCallId: 'call_sub_a', toolName: 'subagent', args: { description: 'A', prompt: 'child A' },
    }),
    ev(n(), 'tool.execution.started', {
      toolCallId: 'call_sub_b', toolName: 'subagent', args: { description: 'B', prompt: 'child B' },
    }),
    ev(n(), 'message.completed', { role: 'assistant', text: 'Dispatching two children.' }),
    ev(n(), 'tool.execution.completed', { toolCallId: 'call_sub_a', toolName: 'subagent', result: {} }),
    ev(n(), 'tool.execution.completed', { toolCallId: 'call_sub_b', toolName: 'subagent', result: {} }),
    // turn 3 (final answer, no tools)
    ev(n(), 'thinking.delta', { role: 'assistant', delta: 'Summarize.' }),
    ev(n(), 'message.delta', { role: 'assistant', delta: 'Both children report NOT_FOUND.' }),
    ev(n(), 'thinking.completed', { role: 'assistant', text: 'Summarize.' }),
    ev(n(), 'message.completed', { role: 'assistant', text: 'Both children report NOT_FOUND.' }),
    ev(n(), 'run.completed', { to: 'SUCCEEDED', status: 'SUCCEEDED' }),
  ];
}

function replay(events: unknown[]): EntityStore {
  return reducePlatformEventBatch(createEntityStore(), events as never).store;
}

function assistantMessages(store: EntityStore) {
  return Object.values(store.messagesById)
    .filter((m) => m.runId === RUN && m.role === 'assistant')
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

describe('turn ordering in the reducer', () => {
  it('keeps each model turn in its own message segment with its own thinking', () => {
    const msgs = assistantMessages(replay(twoTurnRun()));
    assert.deepEqual(
      msgs.map((m) => [m.text, m.thinking]),
      [
        ['I will survey the workspace.', 'Plan the survey.'],
        ['Dispatching two children.', 'Delegate to children.'],
        ['Both children report NOT_FOUND.', 'Summarize.'],
      ],
    );
  });

  it('stamps the first-seen event sequence on messages and tools', () => {
    const store = replay(twoTurnRun());
    const msgs = assistantMessages(store);
    assert.deepEqual(msgs.map((m) => m.seq), [3, 13, 22]);
    assert.equal(store.toolExecutionsById.call_ls.seq, 8);
    assert.equal(store.toolExecutionsById.call_glob.seq, 11);
    assert.equal(store.toolExecutionsById.call_sub_b.seq, 18);
  });

  it('does not move the sequence when a later event updates an entity', () => {
    const store = replay(twoTurnRun());
    // call_ls was completed at sequence 10; its position stays at its start.
    assert.equal(store.toolExecutionsById.call_ls.seq, 8);
  });
});

describe('projectTurnItems', () => {
  it('interleaves thinking, text and tool groups in event order', () => {
    const items = projectTurnItems(replay(twoTurnRun()), RUN);
    assert.deepEqual(
      items.map((i) => i.kind),
      ['thinking', 'text', 'tools', 'thinking', 'text', 'subtasks', 'thinking', 'text'],
    );
    const tools = items[2];
    assert.equal(tools.kind, 'tools');
    if (tools.kind === 'tools') {
      assert.deepEqual(tools.tools.map((t) => t.id), ['call_ls', 'call_glob']);
    }
    const subs = items[5];
    assert.equal(subs.kind, 'subtasks');
    if (subs.kind === 'subtasks') {
      assert.deepEqual(subs.tools.map((t) => t.id), ['call_sub_a', 'call_sub_b']);
    }
  });

  it('folds thinking-only turns into one tool group instead of fragmenting it', () => {
    let q = 0;
    const n = () => ++q;
    // Real runs close every turn with message.completed, even when it had no text.
    const events = [
      ev(n(), 'run.accepted', { status: 'ACCEPTED' }),
      ev(n(), 'thinking.delta', { role: 'assistant', delta: 'look around' }),
      ev(n(), 'message.delta', { role: 'assistant', delta: 'Surveying.' }),
      ev(n(), 'thinking.completed', { role: 'assistant', text: 'look around' }),
      ev(n(), 'tool.execution.started', { toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } }),
      ev(n(), 'message.completed', { role: 'assistant', text: 'Surveying.' }),
      ev(n(), 'tool.execution.completed', { toolCallId: 't1', toolName: 'bash', result: {} }),
      // thinking-only turn
      ev(n(), 'thinking.delta', { role: 'assistant', delta: 'check skills' }),
      ev(n(), 'thinking.completed', { role: 'assistant', text: 'check skills' }),
      ev(n(), 'tool.execution.started', { toolCallId: 't2', toolName: 'bash', args: { command: 'ls skill' } }),
      ev(n(), 'message.completed', { role: 'assistant', text: '' }),
      ev(n(), 'tool.execution.completed', { toolCallId: 't2', toolName: 'bash', result: {} }),
      // another thinking-only turn
      ev(n(), 'thinking.delta', { role: 'assistant', delta: 'search tmp' }),
      ev(n(), 'thinking.completed', { role: 'assistant', text: 'search tmp' }),
      ev(n(), 'tool.execution.started', { toolCallId: 't3', toolName: 'glob', args: { pattern: '*' } }),
      ev(n(), 'message.completed', { role: 'assistant', text: '' }),
      ev(n(), 'tool.execution.completed', { toolCallId: 't3', toolName: 'glob', result: {} }),
      // turn with text again
      ev(n(), 'thinking.delta', { role: 'assistant', delta: 'done' }),
      ev(n(), 'message.delta', { role: 'assistant', delta: 'Nothing found.' }),
      ev(n(), 'message.completed', { role: 'assistant', text: 'Nothing found.' }),
    ];
    const items = projectTurnItems(replay(events), RUN);
    assert.deepEqual(items.map((i) => i.kind), ['thinking', 'text', 'tools', 'thinking', 'text']);
    const group = items[2];
    assert.equal(group.kind, 'tools');
    if (group.kind === 'tools') {
      assert.deepEqual(group.tools.map((t) => t.id), ['t1', 't2', 't3']);
      assert.deepEqual(
        group.steps.map((st) => (st.kind === 'tool' ? st.tool.id : `think:${st.message.thinking}`)),
        ['t1', 'think:check skills', 't2', 'think:search tmp', 't3'],
      );
    }
  });

  it('gives the same items whether events arrive live or as a sorted history page', () => {
    const events = twoTurnRun();
    const live = events.reduce<EntityStore>(
      (store, e) => reducePlatformEventBatch(store, [e] as never).store,
      createEntityStore(),
    );
    const shuffled = [...events].reverse();
    const history = replay(shuffled);
    const shape = (s: EntityStore) =>
      projectTurnItems(s, RUN).map((i) => `${i.kind}@${i.seq}`);
    assert.deepEqual(shape(live), shape(history));
  });
});

describe('runHasTurnEntities', () => {
  it('renders a turn that is only a tool call parked at an approval gate', () => {
    // Real Run shape: message.completed with no text (the content was a tool
    // call), then approval.requested before the tool starts. No assistant
    // message and no tool entity exist, only the approval.
    const events = [
      ev(1, 'run.accepted', { status: 'ACCEPTED' }),
      ev(2, 'run.status.changed', { to: 'RUNNING', status: 'RUNNING' }),
      ev(3, 'message.completed', { role: 'assistant', text: '' }),
      ev(4, 'approval.requested', {
        status: 'PENDING', toolName: 'mcp__exa__web_search_exa', riskLevel: 'high',
        approvalId: '01M3BDN2APPROVAL0000000000', toolCallId: 'call_exa',
      }),
      ev(5, 'run.status.changed', { to: 'WAITING_APPROVAL', status: 'WAITING_APPROVAL' }),
    ];
    const store = replay(events);
    assert.equal(store.runsById[RUN].toolExecutionIds.length, 0);
    assert.equal(runHasTurnEntities(store, RUN), true);
  });

  it('stays hidden for a finished run with nothing to show', () => {
    const store = replay([
      ev(1, 'run.accepted', { status: 'ACCEPTED' }),
      ev(2, 'run.completed', { to: 'SUCCEEDED', status: 'SUCCEEDED' }),
    ]);
    assert.equal(runHasTurnEntities(store, RUN), false);
  });
});

describe('rehydrateRun cursor', () => {
  it('never moves the cursor past events the store has applied', () => {
    // The run row's last_sequence is how far the server has written, not how
    // far this client has applied. Adopting it skipped every event in between
    // when a live stream was re-attached after an approval.
    const applied = replay([
      ev(1, 'run.accepted', { status: 'ACCEPTED' }),
      ev(2, 'run.status.changed', { to: 'WAITING_APPROVAL', status: 'WAITING_APPROVAL' }),
    ]);
    const next = rehydrateRun(applied, { run_id: RUN, status: 'RUNNING', last_sequence: 15 } as never);
    assert.equal(next.runsById[RUN].lastSequence, 2);
  });

  it('starts an unseen run from the beginning so the stream replays it', () => {
    const next = rehydrateRun(createEntityStore(), { run_id: RUN, status: 'RUNNING', last_sequence: 15 } as never);
    assert.equal(next.runsById[RUN].lastSequence, 0);
  });
});

describe('consecutive thinking', () => {
  it('merges back-to-back thinking-only turns into one item', () => {
    // Real shape: a turn that only thinks and then calls a non-ordinary tool
    // (job, subagent) flushes its thinking alone; several such turns in a row
    // rendered as a stack of identical "thinking" rows.
    let q = 0;
    const n = () => ++q;
    const events = [
      ev(n(), 'run.accepted', { status: 'ACCEPTED' }),
      ev(n(), 'thinking.delta', { role: 'assistant', delta: 'first' }),
      ev(n(), 'message.completed', { role: 'assistant', text: '' }),
      ev(n(), 'thinking.delta', { role: 'assistant', delta: 'second' }),
      ev(n(), 'message.completed', { role: 'assistant', text: '' }),
      ev(n(), 'thinking.delta', { role: 'assistant', delta: 'third' }),
      ev(n(), 'message.delta', { role: 'assistant', delta: 'Answer.' }),
      ev(n(), 'message.completed', { role: 'assistant', text: 'Answer.' }),
    ];
    const items = projectTurnItems(replay(events), RUN);
    assert.deepEqual(items.map((i) => i.kind), ['thinking', 'text']);
    const thinking = items[0];
    assert.equal(thinking.kind, 'thinking');
    if (thinking.kind === 'thinking') {
      assert.deepEqual(thinking.messages.map((m) => m.thinking), ['first', 'second', 'third']);
    }
  });
});
