import { useChat } from '../../features/chat/ChatContext';
import { conversationTitle } from '../../shared/state';
import {
  formatRunStatusLabel,
  getActiveRunEntity,
} from '../runtime-timeline/buildTimeline';

export function ConversationHeader() {
  const { state, entityStore, activeRunId } = useChat();

  const conv = (state.conversations || []).find(
    (c) => c.id === state.conversationId,
  );
  const title = conv
    ? conversationTitle(conv)
    : state.conversationId
      ? 'Conversation'
      : 'New chat';

  const run = getActiveRunEntity(
    entityStore,
    activeRunId || entityStore.activeRunId,
  );
  const agentSession =
    (run?.agentSessionId &&
      entityStore.agentSessionsById[run.agentSessionId]) ||
    (state.conversationId &&
      Object.values(entityStore.agentSessionsById).find(
        (s) => s.conversationId === state.conversationId,
      )) ||
    null;

  const model =
    agentSession?.modelId ||
    (typeof conv?.model === 'string' ? conv.model : null) ||
    null;
  const workspace =
    agentSession?.workspaceId ||
    run?.sandboxSessionId ||
    state.sessionId ||
    null;

  return (
    <div className="conversation-header" role="region" aria-label="Conversation">
      <div className="conv-header-main">
        <h2 className="conv-header-title" title={title}>
          {title}
        </h2>
        <div className="conv-header-meta">
          {agentSession ? (
            <span className="conv-chip" title={agentSession.id}>
              Session {agentSession.status}
            </span>
          ) : state.sessionId ? (
            <span className="conv-chip" title={state.sessionId}>
              Sandbox …{state.sessionId.slice(-8)}
            </span>
          ) : (
            <span className="conv-chip muted">No session</span>
          )}
          {model ? (
            <span className="conv-chip" title={model}>
              {model}
            </span>
          ) : null}
          {workspace ? (
            <span className="conv-chip mono" title={workspace}>
              ws …{workspace.slice(-8)}
            </span>
          ) : null}
          {run ? (
            <span className="conv-chip" title={run.id}>
              Run {formatRunStatusLabel(run.status)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
