/**
 * Session bootstrap helpers — conversation + sandbox session + Pi SDK session.
 *
 * Pure orchestration over a Sandbox client; no HTTP transport ownership.
 * Extracted from agent-runtime so the hot path stays unit-testable and the
 * oversized runner does not re-fetch the same conversation twice per turn.
 */
import { config } from '../config.js';
import {
  SessionRestoreError,
  createInMemorySession,
  createNewPersistedSession,
  isForceInMemory,
  openSessionFromResume,
} from '../services/session-persistence.js';

/**
 * Resolve conversation + sandbox session (reuse when possible).
 *
 * Returns the last known conversation row as `conversation` so callers can
 * hand it to {@link resolveAgentSessionManager} and skip a second GET.
 *
 * @param {{
 *   getConversation?: (id: string) => Promise<object>,
 *   getSession?: (id: string) => Promise<object>,
 *   createConversation?: () => Promise<{ id: string }>,
 *   createSession?: (callerId: string, extra?: object) => Promise<object>,
 *   updateConversation?: (id: string, patch?: object) => Promise<unknown>,
 * }} client
 * @param {string | null | undefined} conversation_id
 */
export async function resolveConversationAndSession(client, conversation_id) {
  let activeConversationId = conversation_id || null;
  let sandboxSessionId = null;
  let workspaceId = null;
  let reusedSession = false;
  /** @type {object|null} */
  let conversation = null;

  if (activeConversationId) {
    try {
      conversation = await client.getConversation(activeConversationId);
      if (conversation?.sandbox_session_id) {
        try {
          const existing = await client.getSession(conversation.sandbox_session_id);
          if (existing?.status === 'RUNNING' && existing.session_id) {
            sandboxSessionId = existing.session_id;
            workspaceId = existing.workspace_id || null;
            reusedSession = true;
            console.log(`[agent] Reusing sandbox session ${sandboxSessionId}`);
          }
        } catch {
          // session expired or missing
        }
      }
      console.log(
        `[agent] Reusing conversation ${activeConversationId} workspace_id=conv_${activeConversationId}`,
      );
    } catch {
      console.log(`[agent] Conversation ${activeConversationId} not found, will create new`);
      activeConversationId = null;
      conversation = null;
    }
  }

  if (!activeConversationId) {
    const convResp = await client.createConversation();
    activeConversationId = convResp.id;
    conversation = convResp;
    console.log(
      `[agent] Created conversation ${activeConversationId} workspace_id=conv_${activeConversationId}`,
    );
  }

  if (!sandboxSessionId) {
    const sessionData = await client.createSession('pi-coding-agent', {
      conversation_id: activeConversationId,
      enterprise_session_id: activeConversationId,
    });
    sandboxSessionId = sessionData.session_id;
    workspaceId = sessionData.workspace_id || null;
    try {
      await client.updateConversation(activeConversationId, {
        sandbox_session_id: sandboxSessionId,
      });
      // Keep the local snapshot coherent without another GET.
      conversation = {
        ...(conversation && typeof conversation === 'object' ? conversation : {}),
        id: activeConversationId,
        sandbox_session_id: sandboxSessionId,
      };
    } catch (err) {
      console.warn('[agent] Failed to bind sandbox_session_id on conversation:', err.message);
    }
    console.log(`[agent] Created sandbox session ${sandboxSessionId}`);
  }

  return {
    activeConversationId,
    workspace_id: workspaceId || (activeConversationId ? `conv_${activeConversationId}` : null),
    sessionCwd: config.SESSION_WORKSPACE_CWD,
    sandboxSessionId,
    reusedSession,
    agentSessionId: conversation?.agent_session_id || null,
    /** Last known conversation row; reuse to avoid a second GET on the hot path. */
    conversation,
  };
}

/**
 * Resolve or create the logical Pi SDK agent session for a conversation.
 * Fail-closed when a bound session cannot be restored.
 *
 * When `opts.conversation` is provided (from {@link resolveConversationAndSession}),
 * skips an extra `getConversation` round-trip.
 *
 * @param {{
 *   getConversation?: (id: string) => Promise<object>,
 *   resumeAgentSession?: (id: string) => Promise<object>,
 *   createAgentSession?: (body: object) => Promise<object>,
 * }} client
 * @param {string} conversationId
 * @param {{
 *   sandboxSessionId?: string|null,
 *   workspaceId?: string|null,
 *   sessionCwd?: string|null,
 *   modelId?: string|null,
 *   emit?: (event: object) => void,
 *   conversation?: object|null,
 * }} [opts]
 */
export async function resolveAgentSessionManager(client, conversationId, opts = {}) {
  const emit = typeof opts.emit === 'function' ? opts.emit : () => {};
  const sessionCwd = opts.sessionCwd || config.SESSION_WORKSPACE_CWD;

  if (isForceInMemory() || config.AGENT_FORCE_INMEMORY) {
    console.warn('[agent] AGENT_FORCE_INMEMORY set — using ephemeral SessionManager.inMemory()');
    return {
      ...createInMemorySession({ cwd: sessionCwd }),
      agentSessionId: null,
      restored: false,
      forceInMemory: true,
    };
  }

  let boundAgentSessionId = null;
  if (opts.conversation && typeof opts.conversation === 'object') {
    boundAgentSessionId = opts.conversation.agent_session_id || null;
  } else {
    try {
      const conv = await client.getConversation(conversationId);
      boundAgentSessionId = conv?.agent_session_id || null;
    } catch {
      boundAgentSessionId = null;
    }
  }

  if (boundAgentSessionId) {
    try {
      const resume = await client.resumeAgentSession(boundAgentSessionId);
      if (!resume?.session?.id) {
        throw new SessionRestoreError('Resume returned empty session', {
          agentSessionId: boundAgentSessionId,
          conversationId,
        });
      }
      const opened = openSessionFromResume(resume, {
        conversationId,
        cwd: sessionCwd,
      });
      console.log(
        `[agent] Restored agent session ${boundAgentSessionId} ` +
          `(${opened.persistedCount} entries) for conversation ${conversationId}`,
      );
      return {
        ...opened,
        agentSessionId: boundAgentSessionId,
        restored: true,
        forceInMemory: false,
      };
    } catch (err) {
      const message = err?.message || String(err);
      emit({
        type: 'session_restore_failed',
        conversation_id: conversationId,
        agent_session_id: boundAgentSessionId,
        error: message,
      });
      // Fail closed: never invent a silent empty session when restore fails.
      throw new SessionRestoreError(message, {
        agentSessionId: boundAgentSessionId,
        conversationId,
        cause: err,
      });
    }
  }

  // First turn: create a file-backed SessionManager and bind a new agent session row.
  const created = createNewPersistedSession({ cwd: sessionCwd });
  const header = created.sessionManager.getHeader() || {
    type: 'session',
    version: 3,
    id: created.sessionManager.getSessionId(),
    timestamp: new Date().toISOString(),
    cwd: sessionCwd,
  };
  try {
    const row = await client.createAgentSession({
      conversation_id: conversationId,
      sdk_session_id: created.sessionManager.getSessionId(),
      workspace_id: opts.workspaceId || `conv_${conversationId}`,
      sandbox_session_id: opts.sandboxSessionId || null,
      model_id: opts.modelId || config.MODEL_ID,
      session_schema_version: header.version || 3,
      header_payload: header,
    });
    console.log(
      `[agent] Created agent session ${row.id} (sdk=${row.sdk_session_id}) ` +
        `for conversation ${conversationId}`,
    );
    return {
      ...created,
      agentSessionId: row.id,
      restored: false,
      forceInMemory: false,
    };
  } catch (err) {
    created.cleanup();
    throw err;
  }
}
