import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/shared/state/chatState.ts';
import { beginConversationRestore, finishConversationRestore, failConversationRestore, conversationDisplay } from '../src/features/chat/conversationLoading.ts';
import type { ChatMessage } from '../src/shared/state/types.ts';

const messages: ChatMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'what tools?' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'answer before replay' }] },
];

describe('conversation restoration display', () => {
  it('does not show the transcript as a legacy bubble before the run timeline is restored', () => {
    const restoring = beginConversationRestore(createState(), 'conv_a');
    const withTranscript = { ...restoring, conversationId: 'conv_a', messages };
    assert.deepEqual(conversationDisplay(withTranscript, messages), { loading: true, messages: [] });

    const ready = finishConversationRestore(withTranscript, 'conv_a');
    assert.deepEqual(conversationDisplay(ready, messages), { loading: false, messages });
  });

  it('does not reveal an older conversation when switching and ignores a late completion', () => {
    const current = { ...createState(), conversationId: 'conv_a', messages };
    const switching = beginConversationRestore(current, 'conv_b');
    assert.deepEqual(switching.messages, [], 'a failed switch must not reveal the previous conversation');
    assert.deepEqual(conversationDisplay(switching, messages), { loading: true, messages: [] });
    const stale = finishConversationRestore(switching, 'conv_a');
    assert.deepEqual(conversationDisplay(stale, messages), { loading: true, messages: [] });
    const ready = finishConversationRestore(stale, 'conv_b');
    assert.deepEqual(conversationDisplay(ready, messages), { loading: false, messages });
  });

  it('can release the transcript on restore failure or a new blank conversation', () => {
    const restoring = beginConversationRestore(createState(), 'conv_a');
    assert.equal(conversationDisplay(finishConversationRestore(restoring, 'conv_a'), messages).loading, false);
    assert.equal(conversationDisplay({ ...restoring, restoringConversationId: null }, []).loading, false);
  });

  it('returns to an empty draft on conversation fetch failure so a click can retry', () => {
    const current = { ...createState(), conversationId: 'conv_a', sessionId: 'session_a', messages };
    const pending = { ...beginConversationRestore(current, 'conv_b'), conversationId: 'conv_b' };
    const failed = failConversationRestore(pending, 'conv_b');
    assert.equal(failed.conversationId, null);
    assert.equal(failed.sessionId, null);
    assert.equal(failed.restoringConversationId, null);
    assert.deepEqual(failed.messages, []);
    assert.equal(failConversationRestore(pending, 'conv_a'), pending, 'stale failures cannot reset the next conversation');
  });
});
