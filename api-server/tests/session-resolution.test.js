import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveConversationAndSession } from '../routes/chat.js';

describe('resolveConversationAndSession', () => {
  it('creates and binds a sandbox session for a new conversation', async () => {
    const updates = [];
    const client = {
      async createConversation() {
        return { id: 'conversation-new' };
      },
      async createSession(agentName, metadata) {
        assert.equal(agentName, 'pi-coding-agent');
        assert.equal(metadata.conversation_id, 'conversation-new');
        return { session_id: 'sandbox-new' };
      },
      async updateConversation(id, body) {
        updates.push([id, body]);
      },
    };

    const resolved = await resolveConversationAndSession(client, null);
    assert.deepEqual(resolved, {
      activeConversationId: 'conversation-new',
      workspace_id: 'conv_conversation-new',
      sandboxSessionId: 'sandbox-new',
      reusedSession: false,
    });
    assert.deepEqual(updates, [
      ['conversation-new', { sandbox_session_id: 'sandbox-new' }],
    ]);
  });

  it('reuses the running session already bound to a conversation', async () => {
    let created = false;
    const client = {
      async getConversation() {
        return { id: 'conversation-1', sandbox_session_id: 'sandbox-1' };
      },
      async getSession() {
        return { session_id: 'sandbox-1', status: 'RUNNING' };
      },
      async createSession() {
        created = true;
      },
    };

    const resolved = await resolveConversationAndSession(client, 'conversation-1');
    assert.equal(resolved.sandboxSessionId, 'sandbox-1');
    assert.equal(resolved.reusedSession, true);
    assert.equal(created, false);
  });
});
