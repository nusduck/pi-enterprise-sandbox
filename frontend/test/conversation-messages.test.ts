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
        content: [
          { type: 'text', text: 'same answer' },
          { type: 'tool_use', name: runId === 'run_1' ? 'read' : 'bash' },
        ],
      }],
    });

    const assistants = projected.filter((message) => message.role === 'assistant');
    assert.equal(assistants.length, 2);
    assert.equal(assistants[0].content.find((part) => part.type === 'tool_use')?.name, 'read');
    assert.equal(assistants[1].content.find((part) => part.type === 'tool_use')?.name, 'bash');
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
});
