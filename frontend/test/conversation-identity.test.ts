import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/shared/state/chatState.ts';
import { bindCreatedRunIdentity } from '../src/features/chat/conversationIdentity.ts';

describe('create-run conversation identity', () => {
  it('binds a first turn to the returned conversation and session with an initial title', () => {
    const prior = createState();
    const next = bindCreatedRunIdentity(prior, prior, 'conv_created', 'session_created', 'Hello sandbox');
    assert.equal(next.conversationId, 'conv_created');
    assert.equal(next.sessionId, 'session_created');
    assert.equal(next.conversations[0].title, 'Hello sandbox');
  });

  it('keeps a non-placeholder title and all other conversations', () => {
    const prior = createState({
      conversationId: 'conv_existing',
      conversations: [
        { id: 'conv_existing', title: 'My saved title', created_at: '2026-01-01', updated_at: '2026-01-01' },
        { id: 'conv_other', title: 'Other', created_at: '2026-01-01', updated_at: '2026-01-01' },
      ],
    });
    const next = bindCreatedRunIdentity(prior, prior, 'conv_existing', 'session_existing', 'Second turn');
    assert.equal(next.sessionId, 'session_existing');
    assert.deepEqual(next.conversations, prior.conversations);
  });
});
