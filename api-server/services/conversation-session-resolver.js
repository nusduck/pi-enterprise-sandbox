/** Resolve/create the Conversation-owned Sandbox session used for draft uploads. */
export async function resolveConversationAndSession(client, conversationId) {
  let activeConversationId = conversationId || null;
  let sandboxSessionId = null;
  let workspaceId = null;
  let reusedSession = false;
  if (activeConversationId) {
    try {
      const conversation = await client.getConversation(activeConversationId);
      if (conversation.sandbox_session_id) {
        try {
          const existing = await client.getSession(conversation.sandbox_session_id);
          if (existing?.status === 'RUNNING' && existing.session_id) {
            sandboxSessionId = existing.session_id;
            workspaceId = existing.workspace_id || null;
            reusedSession = true;
          }
        } catch { /* replace expired session below */ }
      }
    } catch { activeConversationId = null; }
  }
  if (!activeConversationId) {
    activeConversationId = (await client.createConversation()).id;
  }
  if (!sandboxSessionId) {
    const session = await client.createSession('pi-coding-agent', {
      conversation_id: activeConversationId,
      enterprise_session_id: activeConversationId,
    });
    sandboxSessionId = session.session_id;
    workspaceId = session.workspace_id || null;
    await client.updateConversation(activeConversationId, {
      sandbox_session_id: sandboxSessionId,
    }).catch(() => {});
  }
  return {
    activeConversationId,
    workspace_id: workspaceId || `conv_${activeConversationId}`,
    sandboxSessionId,
    reusedSession,
  };
}
