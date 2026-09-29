import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEntityStore,
  createMessage,
  createRun,
  upsertMessage,
  upsertRun,
  type EntityStore,
} from '../src/entities/index.ts';
import {
  projectConversationMessages,
  runFailureReason,
} from '../src/features/chat/projections/conversationMessages.ts';
import type { ChatMessage } from '../src/shared/state/types.ts';

const user = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ...extra,
});

function storeWith(
  runs: Array<{ id: string; createdAt: string; status?: string; error?: string; text?: string; userText?: string }>,
): EntityStore {
  let store = createEntityStore();
  for (const r of runs) {
    store = upsertRun(store, createRun({
      id: r.id,
      conversationId: 'conv_1',
      createdAt: r.createdAt,
      status: (r.status ?? 'succeeded') as never,
      error: r.error ?? null,
    }));
    if (r.text) {
      store = upsertMessage(store, createMessage({
        id: `${r.id}_a`, runId: r.id, role: 'assistant', text: r.text, status: 'completed',
      }));
    }
    if (r.userText) {
      store = upsertMessage(store, createMessage({
        id: `${r.id}_u`, runId: r.id, role: 'user', text: r.userText, status: 'completed',
      }));
    }
  }
  return store;
}

const project = (userMessages: ChatMessage[], store: EntityStore, activeRunId: string | null = null) =>
  projectConversationMessages({ userMessages, conversationId: 'conv_1', store, activeRunId });

describe('conversation message projection', () => {
  it('does not project an old run after starting a new conversation', () => {
    const projected = projectConversationMessages({
      userMessages: [],
      conversationId: null,
      store: storeWith([{ id: 'run_old', createdAt: '2026-07-14T00:00:01Z', text: 'old answer' }]),
      activeRunId: null,
    });
    assert.deepEqual(projected, []);
  });

  it('gives every run exactly one assistant row right after its user turn', () => {
    const store = storeWith([
      { id: 'run_1', createdAt: '2026-07-14T00:00:01Z', text: 'same answer' },
      { id: 'run_2', createdAt: '2026-07-14T00:00:02Z', text: 'same answer' },
    ]);
    const rows = project([
      user('first', { _runId: 'run_1', sequenceNo: 1 }),
      user('second', { _runId: 'run_2', sequenceNo: 3 }),
    ], store);
    assert.deepEqual(rows.map((m) => [m.role, m._runId]), [
      ['user', 'run_1'], ['assistant', 'run_1'],
      ['user', 'run_2'], ['assistant', 'run_2'],
    ]);
  });

  it('carries the joined answer text of the run for copy, not the transcript', () => {
    const store = storeWith([{ id: 'run_1', createdAt: '2026-07-14T00:00:01Z', text: 'the answer' }]);
    const [, assistant] = project([user('q', { _runId: 'run_1', sequenceNo: 1 })], store);
    assert.equal(assistant.content[0] && 'text' in assistant.content[0] ? assistant.content[0].text : '', 'the answer');
  });

  it('orders persisted user turns by sequence number and keeps unsequenced sends last', () => {
    const rows = project([
      user('optimistic', { sequenceNo: Number.NaN }),
      user('second', { sequenceNo: 3 }),
      user('first', { sequenceNo: 1 }),
    ], createEntityStore());
    assert.deepEqual(rows.map((m) => (m.content[0] as { text: string }).text), ['first', 'second', 'optimistic']);
  });

  it('shows the host row of an active run before any entity arrived', () => {
    const store = storeWith([{ id: 'run_1', createdAt: '2026-07-14T00:00:01Z', status: 'running' }]);
    const rows = project([user('q', { _runId: 'run_1' })], store, 'run_1');
    assert.deepEqual(rows.map((m) => m.role), ['user', 'assistant']);
  });

  it('shows nothing for a finished run that produced no output', () => {
    const store = storeWith([{ id: 'run_1', createdAt: '2026-07-14T00:00:01Z' }]);
    const rows = project([user('q', { _runId: 'run_1' })], store);
    assert.deepEqual(rows.map((m) => m.role), ['user']);
  });

  it('keeps a host row for a failed run so its reason can render', () => {
    const store = storeWith([{ id: 'run_1', createdAt: '2026-07-14T00:00:01Z', status: 'failed', error: 'model down' }]);
    const rows = project([user('q', { _runId: 'run_1' })], store);
    assert.deepEqual(rows.map((m) => m.role), ['user', 'assistant']);
    assert.equal(runFailureReason(store.runsById.run_1), 'model down');
  });

  it('flags cancelled and interrupted runs on the assistant row', () => {
    const store = storeWith([{ id: 'run_1', createdAt: '2026-07-14T00:00:01Z', status: 'cancelled', text: 'partial' }]);
    const [, assistant] = project([user('q', { _runId: 'run_1' })], store);
    assert.equal(assistant.interrupted, true);
  });

  it('appends a run whose user turn is not in the transcript, using its own prompt', () => {
    const store = storeWith([
      { id: 'run_1', createdAt: '2026-07-14T00:00:01Z', text: 'a1' },
      { id: 'run_2', createdAt: '2026-07-14T00:00:02Z', text: 'a2', userText: 'from another tab' },
    ]);
    const rows = project([user('first', { _runId: 'run_1', sequenceNo: 1 })], store);
    assert.deepEqual(rows.map((m) => [m.role, m._runId]), [
      ['user', 'run_1'], ['assistant', 'run_1'],
      ['user', 'run_2'], ['assistant', 'run_2'],
    ]);
  });

  it('never surfaces assistant transcript rows — only user rows survive', () => {
    const rows = project([
      user('q', { _runId: 'run_1', sequenceNo: 1 }),
      { role: 'assistant', content: [{ type: 'text', text: 'server copy' }], _runId: 'run_1', sequenceNo: 2 },
    ], storeWith([{ id: 'run_1', createdAt: '2026-07-14T00:00:01Z', text: 'entity copy' }]));
    assert.equal(rows.filter((m) => m.role === 'assistant').length, 1);
    assert.equal(
      (rows[1].content[0] as { text: string }).text,
      'entity copy',
    );
  });
});
