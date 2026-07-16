import { useEffect, useMemo, useState } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import { conversationTitle, isInterruptedMessage } from '../../shared/state';
import {
  buildRunTimeline,
  countRunTools,
  formatDuration,
  formatRunStatusLabel,
  getActiveRunEntity,
  runStatusTone,
} from '../runtime-timeline/buildTimeline';
import { BudgetBar } from '../budget-bar/BudgetBar';
import { shouldShowResumeEntry } from '../composer/composerMode';
import { useWorkbenchSelection } from '../../app/layout/WorkbenchSelectionContext';

/**
 * Single workbench toolbar — conversation title + live run chips + panel toggles.
 * Replaces the old stacked App header / conversation header / idle run-status bar.
 */
export function ConversationHeader() {
  const {
    state,
    entityStore,
    activeRunId,
    activeSessionId,
    activeTraceId,
    displayMessages,
    resumeInterrupted,
    toggleSidebar,
    inspectorOpen,
    toggleInspector,
  } = useChat();
  const { activityOpen, toggleActivity } = useWorkbenchSelection();

  const conv = (state.conversations || []).find(
    (c) => c.id === state.conversationId,
  );
  const title = conv
    ? conversationTitle(conv)
    : state.conversationId
      ? 'Conversation'
      : 'New conversation';

  const run = getActiveRunEntity(entityStore, activeRunId);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!run || run.finishedAt) return;
    const status = run.status;
    if (
      status === 'succeeded' ||
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'interrupted' ||
      status === 'budget_exceeded'
    ) {
      return;
    }
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [run?.id, run?.status, run?.finishedAt]);

  const timelineCount = useMemo(
    () => buildRunTimeline(entityStore, activeRunId).length,
    [entityStore, activeRunId],
  );

  const showRun = Boolean(run || state.isStreaming);
  const status = run?.status || (state.isStreaming ? 'running' : null);
  const tone = status ? runStatusTone(status) : 'idle';
  const tools = activeRunId ? countRunTools(entityStore, activeRunId) : 0;
  const duration = run
    ? formatDuration(run.startedAt || run.createdAt, run.finishedAt)
    : null;

  const lastInterrupted = (() => {
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      if (displayMessages[i].role === 'assistant') {
        return isInterruptedMessage(displayMessages[i]);
      }
    }
    return false;
  })();

  const showResume = shouldShowResumeEntry({
    runStatus: run?.status,
    lastMessageInterrupted: lastInterrupted,
    isStreaming: state.isStreaming,
  });

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

  return (
    <header
      className="workbench-toolbar conversation-header"
      role="region"
      aria-label="Conversation"
    >
      <div className="wb-toolbar-left">
        <button
          type="button"
          className="btn-icon"
          id="btn-sidebar-toggle"
          title="Toggle conversations"
          aria-label="Toggle sidebar"
          onClick={toggleSidebar}
        >
          ☰
        </button>
        <div className="wb-title-block">
          <h1 className="conv-header-title" title={title}>
            {title}
          </h1>
          <div className="conv-header-meta">
            {model ? (
              <span className="conv-chip" title={model}>
                {model}
              </span>
            ) : null}
            {activeSessionId || agentSession ? (
              <span
                className="conv-chip muted"
                title={agentSession?.id || activeSessionId || ''}
              >
                {agentSession
                  ? `Session ${agentSession.status}`
                  : `UPRC …${(activeSessionId || '').slice(-6)}`}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="wb-toolbar-center" aria-live="polite">
        {showRun && status ? (
          <div
            className={`run-status-bar inline tone-${tone}`}
            role="status"
            data-run-id={run?.id || ''}
            data-run-status={status}
          >
            <span className="rsb-dot" aria-hidden="true" />
            <span className="rsb-status">{formatRunStatusLabel(status)}</span>
            {tools > 0 ? (
              <>
                <span className="rsb-sep">·</span>
                <span className="rsb-detail">
                  {tools} tool{tools === 1 ? '' : 's'}
                </span>
              </>
            ) : null}
            {duration ? (
              <>
                <span className="rsb-sep">·</span>
                <span className="rsb-detail mono">{duration}</span>
              </>
            ) : null}
            {run ? <BudgetBar run={run} /> : null}
            {showResume ? (
              <button
                type="button"
                className="rsb-resume-btn"
                onClick={() => void resumeInterrupted()}
                title="Resume interrupted run"
              >
                Resume
              </button>
            ) : null}
            {activeTraceId ? (
              <span className="rsb-trace" title={activeTraceId}>
                {activeTraceId.slice(0, 8)}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="run-status-bar inline idle" role="status">
            <span
              className="dot"
              aria-hidden="true"
              style={{ background: state.statusColor }}
            />
            <span id="status-label" className="rsb-detail">
              {state.statusLabel}
            </span>
          </div>
        )}
      </div>

      <div className="wb-toolbar-right">
        <button
          type="button"
          className={`btn-toolbar${activityOpen ? ' active' : ''}`}
          title="Runtime activity"
          aria-label="Toggle runtime activity"
          aria-pressed={activityOpen}
          onClick={toggleActivity}
        >
          Activity
          {timelineCount > 0 ? (
            <span className="btn-toolbar-badge">{timelineCount}</span>
          ) : null}
        </button>
        <button
          type="button"
          className={`btn-toolbar${inspectorOpen ? ' active' : ''}`}
          id="btn-inspector-toggle"
          title="Context inspector"
          aria-label="Toggle context inspector"
          aria-pressed={inspectorOpen}
          onClick={toggleInspector}
        >
          Details
        </button>
      </div>
    </header>
  );
}
