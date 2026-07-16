import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCreateAgentSessionOptions,
  resolveAgentSessionManager,
  resolveConversationAndSession,
} from '../runtime/agent-runtime.js';
import { config } from '../config.js';
import { createInMemorySession } from '../services/session-persistence.js';

const LOGICAL_CWD = '/home/sandbox/workspace';

describe('Sandbox session cwd contract', () => {
  it('returns the logical Sandbox workspace cwd for a newly created session', async () => {
    const client = {
      async createConversation() {
        return { id: 'conv_new' };
      },
      async createSession() {
        return { session_id: 'sandbox_new', workspace_id: 'conv_conv_new' };
      },
      async updateConversation() {},
    };

    const resolved = await resolveConversationAndSession(client, null);
    assert.equal(resolved.sessionCwd, LOGICAL_CWD);
    assert.equal(resolved.sessionCwd, config.SESSION_WORKSPACE_CWD);
    assert.equal(resolved.sandboxSessionId, 'sandbox_new');
    assert.equal(resolved.workspace_id, 'conv_conv_new');
  });

  it('keeps the same cwd when reusing an existing Sandbox session', async () => {
    const client = {
      async getConversation() {
        return { id: 'conv_existing', sandbox_session_id: 'sandbox_existing' };
      },
      async getSession() {
        return {
          session_id: 'sandbox_existing',
          workspace_id: 'conv_conv_existing',
          status: 'RUNNING',
        };
      },
    };

    const resolved = await resolveConversationAndSession(client, 'conv_existing');
    assert.equal(resolved.sessionCwd, LOGICAL_CWD);
    assert.equal(resolved.reusedSession, true);
    assert.equal(resolved.workspace_id, 'conv_conv_existing');
  });

  it('records the Sandbox cwd in a newly persisted Pi SDK session header', async () => {
    let createdBody = null;
    const client = {
      async getConversation() {
        return { agent_session_id: null };
      },
      async createAgentSession(body) {
        createdBody = body;
        return { id: 'asess_new', sdk_session_id: body.sdk_session_id };
      },
    };

    const handle = await resolveAgentSessionManager(client, 'conv_new', {
      sessionCwd: LOGICAL_CWD,
      sandboxSessionId: 'sandbox_new',
      workspaceId: 'conv_conv_new',
    });
    try {
      assert.equal(handle.sessionManager.getHeader().cwd, LOGICAL_CWD);
      assert.equal(createdBody.header_payload.cwd, LOGICAL_CWD);
    } finally {
      handle.cleanup();
    }
  });

  it('overrides an old persisted /tmp cwd when restoring a Pi SDK session', async () => {
    const client = {
      async getConversation() {
        return { agent_session_id: 'asess_existing' };
      },
      async resumeAgentSession() {
        return {
          session: {
            id: 'asess_existing',
            conversation_id: 'conv_existing',
            header_payload: {
              type: 'session',
              version: 3,
              id: 'sdk_existing',
              timestamp: '2026-07-12T00:00:00.000Z',
              cwd: '/tmp',
            },
          },
          entries: [],
        };
      },
    };

    const handle = await resolveAgentSessionManager(client, 'conv_existing', {
      sessionCwd: LOGICAL_CWD,
    });
    try {
      assert.equal(handle.sessionManager.getHeader().cwd, LOGICAL_CWD);
    } finally {
      handle.cleanup();
    }
  });

  it('uses the same cwd for in-memory sessions and createAgentSession options', () => {
    const inMemory = createInMemorySession({ cwd: LOGICAL_CWD });
    assert.equal(inMemory.sessionManager.getHeader().cwd, LOGICAL_CWD);

    const options = buildCreateAgentSessionOptions({
      sessionCwd: LOGICAL_CWD,
      model: { id: 'm' },
      tools: ['read'],
      customTools: [],
      sessionManager: inMemory.sessionManager,
      authStorage: {},
      modelRegistry: {},
      resourceLoader: {},
      settingsManager: {},
    });
    assert.equal(options.cwd, LOGICAL_CWD);
    assert.equal(options.sessionManager, inMemory.sessionManager);
  });
});
