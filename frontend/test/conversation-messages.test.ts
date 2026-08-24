import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityStore, createRun, upsertRun } from '../src/entities/index.ts';
import { projectConversationMessages } from '../src/features/chat/projections/conversationMessages.ts';
import type { ChatMessage } from '../src/shared/state/types.ts';

describe('conversation message projection', () => {
  it('does not project an old run after starting a new conversation', () => {
    let store = createEntityStore();
    store = upsertRun(store, createRun({
      id: 'run_old',
      conversationId: 'conv_old',
    }));

    const projected = projectConversationMessages({
      serverMessages: [],
      conversationId: null,
      store,
      activeRunId: null,
      projectRunMessages: () => [{
        role: 'assistant',
        content: [{ type: 'text', text: 'old answer' }],
      }],
    });

    assert.deepEqual(projected, []);
  });

  it('keeps distinct runs when assistant text is identical', () => {
    let store = createEntityStore();
    store = upsertRun(store, createRun({
      id: 'run_1',
      conversationId: 'conv_1',
      createdAt: '2026-07-14T00:00:01Z',
    }));
    store = upsertRun(store, createRun({
      id: 'run_2',
      conversationId: 'conv_1',
      createdAt: '2026-07-14T00:00:02Z',
    }));

    const serverMessages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'same answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'same answer' }] },
    ];
    const projected = projectConversationMessages({
      serverMessages,
      conversationId: 'conv_1',
      store,
      activeRunId: 'run_2',
      projectRunMessages: (runId) => [{
        role: 'assistant',
        content: [{ type: 'text', text: 'same answer' }],
        _runId: runId,
        _hasRuntimeSteps: true,
      }],
    });

    const assistants = projected.filter((message) => message.role === 'assistant');
    assert.equal(assistants.length, 2);
    assert.deepEqual(assistants.map((message) => message._runId), ['run_1', 'run_2']);
  });

  it('streams pure token text without waiting for tools', () => {
    let store = createEntityStore();
    store = upsertRun(store, createRun({
      id: 'run_stream',
      conversationId: 'conv_stream',
      createdAt: '2026-07-16T00:00:01Z',
    }));

    const serverMessages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];

    // First token chunk: no tools yet
    let projected = projectConversationMessages({
      serverMessages,
      conversationId: 'conv_stream',
      store,
      activeRunId: 'run_stream',
      projectRunMessages: () => [{
        role: 'assistant',
        content: [{ type: 'text', text: 'Hel' }],
        _runId: 'run_stream',
      }],
    });
    assert.equal(projected.length, 2);
    assert.equal(String((projected[1].content[0] as { text?: string }).text), 'Hel');

    // Second token chunk must replace the same assistant slot (live stream)
    projected = projectConversationMessages({
      serverMessages: projected,
      conversationId: 'conv_stream',
      store,
      activeRunId: 'run_stream',
      projectRunMessages: () => [{
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
        _runId: 'run_stream',
      }],
    });
    assert.equal(projected.length, 2);
    assert.equal(
      String((projected[1].content[0] as { text?: string }).text),
      'Hello world',
    );
  });

  it('merges a matching unlinked durable assistant row instead of duplicating it', () => {
    let store = createEntityStore();
    store = upsertRun(store, createRun({
      id: 'run_attachment_read',
      conversationId: 'conv_attachment_read',
      createdAt: '2026-07-16T00:00:01Z',
    }));

    const projected = projectConversationMessages({
      // Partial/legacy history has no linkage, so ordinal tagging is not safe.
      serverMessages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'The attached file says hello.' }],
      }],
      conversationId: 'conv_attachment_read',
      store,
      activeRunId: 'run_attachment_read',
      projectRunMessages: () => [{
        role: 'assistant',
        content: [{ type: 'text', text: 'The attached file says hello.' }],
        _runId: 'run_attachment_read',
        _messageId: 'local_projection_message',
        _hasRuntimeSteps: true,
      }],
    });

    assert.equal(projected.filter((message) => message.role === 'assistant').length, 1);
    assert.equal(projected[0]._runId, 'run_attachment_read');
    assert.equal(projected[0]._hasRuntimeSteps, true);
  });

  it('merges the assistant messages of one run into a single bubble carrying the runtime steps', () => {
    let store = createEntityStore();
    store = upsertRun(store, createRun({
      id: 'run_multi_assistant',
      conversationId: 'conv_multi_assistant',
      createdAt: '2026-07-22T13:32:47Z',
    }));

    const projected = projectConversationMessages({
      serverMessages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'send it to me' }],
          _runId: 'run_multi_assistant',
          _messageId: 'msg_user',
          sequenceNo: 1,
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'The artifact has been submitted.' }],
          _runId: 'run_multi_assistant',
          _messageId: 'msg_assistant_1',
          sequenceNo: 2,
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'You can download it from Artifacts.' }],
          _runId: 'run_multi_assistant',
          _messageId: 'msg_assistant_2',
          sequenceNo: 3,
        },
      ],
      conversationId: 'conv_multi_assistant',
      store,
      activeRunId: 'run_multi_assistant',
      // Live events use a distinct synthetic message id, so fallback matching
      // must retain the durable assistant ordinal rather than collapse rows.
      projectRunMessages: () => [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'The artifact has been submitted.' }],
          _runId: 'run_multi_assistant',
          _messageId: 'assistant:run_multi_assistant:seq1',
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'You can download it from Artifacts.' }],
          _runId: 'run_multi_assistant',
          _messageId: 'assistant:run_multi_assistant:seq2',
          _hasRuntimeSteps: true,
        },
      ],
    });

    // The run is the turn: its assistant rows collapse into one bubble whose
    // content parts stay in durable order. Exactly one bubble per run also
    // means only one can claim the steps, so the runtime timeline can never
    // render the same tools twice.
    const assistants = projected.filter((message) => message.role === 'assistant');
    assert.equal(assistants.length, 1);
    assert.equal((assistants[0].content[0] as { text: string }).text, 'The artifact has been submitted.');
    assert.equal((assistants[0].content[1] as { text: string }).text, 'You can download it from Artifacts.');
    assert.equal(assistants[0]._hasRuntimeSteps, true);
  });

  it('keeps the full persisted assistant text while adding runtime tool details', () => {
    let store = createEntityStore();
    store = upsertRun(store, createRun({
      id: 'run_full_text',
      conversationId: 'conv_full_text',
      createdAt: '2026-07-21T00:00:00Z',
    }));

    const fullText = 'A'.repeat(900);
    const projected = projectConversationMessages({
      serverMessages: [
        { role: 'user', content: [{ type: 'text', text: 'summarize this' }], _runId: 'run_full_text' },
        { role: 'assistant', content: [{ type: 'text', text: fullText }], _runId: 'run_full_text' },
      ],
      conversationId: 'conv_full_text',
      store,
      activeRunId: 'run_full_text',
      projectRunMessages: () => [{
        role: 'assistant',
        content: [{ type: 'text', text: `${'A'.repeat(512)}…` }],
        _runId: 'run_full_text',
        _hasRuntimeSteps: true,
      }],
    });

    const assistant = projected.find((message) => message.role === 'assistant');
    assert.ok(assistant);
    assert.equal((assistant.content[0] as { text: string }).text, fullText);
    assert.equal(assistant._hasRuntimeSteps, true);
  });

  it('orders persisted history by sequence number, never by role', () => {
    const projected = projectConversationMessages({
      serverMessages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'first answer' }],
          _messageId: 'msg_02',
          sequenceNo: 2,
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'first question' }],
          _messageId: 'msg_01',
          sequenceNo: 1,
        },
      ],
      conversationId: 'conv_history',
      store: createEntityStore(),
      activeRunId: null,
      projectRunMessages: () => [],
    });

    assert.deepEqual(projected.map((message) => message._messageId), [
      'msg_01',
      'msg_02',
    ]);
  });

  it('keeps unlinked legacy history in its original order', () => {
    const projected = projectConversationMessages({
      serverMessages: [
        { role: 'assistant', content: [{ type: 'text', text: 'answer one' }] },
        { role: 'user', content: [{ type: 'text', text: 'question two' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'answer two' }] },
      ],
      conversationId: 'conv_legacy',
      store: createEntityStore(),
      activeRunId: null,
      projectRunMessages: () => [],
    });

    assert.deepEqual(
      projected.map((message) => String((message.content[0] as { text?: string }).text)),
      ['answer one', 'question two', 'answer two'],
    );
  });

  it('inserts an uncommitted projection after its run user turn', () => {
    let store = createEntityStore();
    store = upsertRun(store, createRun({
      id: 'run_1',
      conversationId: 'conv_live',
      createdAt: '2026-07-18T06:00:00.000Z',
    }));

    const projected = projectConversationMessages({
      serverMessages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'first question' }],
          _runId: 'run_1',
          _messageId: 'msg_01',
          sequenceNo: 1,
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'later question' }],
          _runId: 'run_2',
          _messageId: 'msg_02',
          sequenceNo: 2,
        },
      ],
      conversationId: 'conv_live',
      store,
      activeRunId: 'run_1',
      projectRunMessages: () => [{
        role: 'assistant',
        content: [{ type: 'text', text: 'live answer' }],
        _runId: 'run_1',
      }],
    });

    assert.deepEqual(
      projected.map((message) => String((message.content[0] as { text?: string }).text)),
      ['first question', 'live answer', 'later question'],
    );
  });
});
