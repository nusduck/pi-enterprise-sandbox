import { useEffect, useState } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import { conversationTitle, isInterruptedMessage } from '../../shared/state';
import {
  countRunTools,
  formatDuration,
  formatRunStatusLabel,
  getActiveRunEntity,
  runStatusTone,
} from '../runtime-timeline/buildTimeline';
import { BudgetBar } from '../budget-bar/BudgetBar';
import { shouldShowResumeEntry } from '../composer/composerMode';
import { IconMenu, IconLayers, IconRefresh, IconSun, IconMoon } from '../../shared/ui/Icons';

import { useTheme } from '../../shared/ui/theme';

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
    agentNameById,
  } = useChat();

  const [theme, toggleTheme] = useTheme();

  const conv = (state.conversations || []).find(
    (c) => c.id === state.conversationId,
  );
  const title = conv
    ? conversationTitle(conv)
    : state.conversationId
      ? 'Conversation'
      : 'New Conversation';

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

  // 这个会话绑在哪个 Agent 上（D2：建会话时钉死）。只有 org 里确实存在多个
  // Agent 时 `agentNameById` 才解析得出名字，单 Agent 的 org 看不到这个 chip。
  const agentName = agentNameById(
    typeof conv?.agent_id === 'string' ? conv.agent_id : null,
  );

  const model =
    run?.modelId ||
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
          <IconMenu size={18} />
        </button>
        <div className="wb-title-block">
          <h1 className="conv-header-title" title={title}>
            {title}
          </h1>
          <div className="conv-header-meta">
            {agentName ? (
              <span className="conv-chip agent-chip" title={`Agent · ${agentName}`}>
                {agentName}
              </span>
            ) : null}
            {model ? (
              <span className="conv-chip model-chip" title={model}>
                {model}
              </span>
            ) : null}
            {activeSessionId || agentSession ? (
              <span
                className="conv-chip session-chip"
                title={agentSession?.id || activeSessionId || ''}
              >
                {agentSession
                  ? `Session · ${agentSession.status}`
                  : `Sandbox · ${(activeSessionId || '').slice(-6)}`}
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
                <IconRefresh size={12} /> Resume
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
          className="btn-icon"
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          aria-label="Toggle color theme"
          onClick={() => toggleTheme()}
        >
          {theme === 'light' ? <IconMoon size={16} /> : <IconSun size={16} />}
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
          <IconLayers size={14} />
          <span>Details</span>
        </button>
      </div>
    </header>
  );
}
