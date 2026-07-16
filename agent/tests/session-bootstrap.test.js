/**
 * Session bootstrap ownership + hot-path conversation GET reuse.
 * Drives the shipped resolveConversationAndSession / resolveAgentSessionManager
 * helpers (not a reimplementation under test).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAgentSessionManager,
  resolveConversationAndSession,
} from '../runtime/session-bootstrap.js';

describe('session bootstrap structure', () => {
  it('returns conversation snapshot for reuse by resolveAgentSessionManager', async () => {
    let getConversationCalls = 0;
    const client = {
      async getConversation(id) {
        getConversationCalls += 1;
        return {
          id,
          sandbox_session_id: 'sandbox_1',
          agent_session_id: 'asess_1',
        };
      },
      async getSession() {
        return {
          session_id: 'sandbox_1',
          workspace_id: 'conv_c1',
          status: 'RUNNING',
        };
      },
      async resumeAgentSession(id) {
        return {
          session: {
            id,
            conversation_id: 'c1',
            header_payload: {
              type: 'session',
              version: 3,
              id: 'sdk_1',
              timestamp: '2026-07-12T00:00:00.000Z',
              cwd: '/home/sandbox/workspace',
            },
          },
          entries: [],
        };
      },
      async createAgentSession() {
        throw new Error('should not create when agent session is bound');
      },
    };

    const resolved = await resolveConversationAndSession(client, 'c1');
    assert.equal(getConversationCalls, 1);
    assert.equal(resolved.conversation?.agent_session_id, 'asess_1');
    assert.equal(resolved.reusedSession, true);

    const handle = await resolveAgentSessionManager(client, 'c1', {
      conversation: resolved.conversation,
      sessionCwd: resolved.sessionCwd,
      sandboxSessionId: resolved.sandboxSessionId,
      workspaceId: resolved.workspace_id,
    });
    try {
      // Passing the snapshot must not trigger a second getConversation.
      assert.equal(getConversationCalls, 1);
      assert.equal(handle.agentSessionId, 'asess_1');
      assert.equal(handle.restored, true);
    } finally {
      handle.cleanup();
    }
  });

  it('still fetches conversation when no snapshot is provided', async () => {
    let getConversationCalls = 0;
    const client = {
      async getConversation(id) {
        getConversationCalls += 1;
        return { id, agent_session_id: null };
      },
      async createAgentSession(body) {
        return { id: 'asess_new', sdk_session_id: body.sdk_session_id };
      },
    };

    const handle = await resolveAgentSessionManager(client, 'c_new', {
      sessionCwd: '/home/sandbox/workspace',
    });
    try {
      assert.equal(getConversationCalls, 1);
      assert.equal(handle.agentSessionId, 'asess_new');
      assert.equal(handle.restored, false);
    } finally {
      handle.cleanup();
    }
  });

  it('keeps public surface available via chat-runner facade', async () => {
    const facade = await import('../chat-runner.js');
    assert.equal(typeof facade.resolveConversationAndSession, 'function');
    assert.equal(typeof facade.resolveAgentSessionManager, 'function');
    assert.equal(typeof facade.runAgentTurn, 'function');
  });
});

describe('tool result JSON compactness (shipped helper path)', () => {
  it('sandbox tool results use compact JSON without pretty whitespace', async () => {
    const { createSandboxTools } = await import('../sandbox-tools.js');
    const tools = createSandboxTools({
      sessionId: 'sess_1',
      client: {
        async lsFiles() {
          return {
            entries: [{ name: 'a.txt', type: 'file' }],
            stats: { matched: 1 },
            truncated: false,
            stop_reason: null,
          };
        },
      },
      approvalMode: 'auto_approve',
    });
    const ls = tools.find((t) => t.name === 'ls');
    assert.ok(ls, 'ls tool must exist');
    const result = await ls.execute('tc1', { path: '.' });
    const text = result.content?.[0]?.text || '';
    assert.ok(text.includes('"entries"'), 'result text must include JSON payload');
    assert.equal(
      text.includes('\n'),
      false,
      `expected compact JSON without newlines, got: ${text.slice(0, 120)}`,
    );
    // Prove we drive the real stringify path: parse must round-trip.
    const parsed = JSON.parse(text);
    assert.equal(parsed.entries[0].name, 'a.txt');
  });
});
