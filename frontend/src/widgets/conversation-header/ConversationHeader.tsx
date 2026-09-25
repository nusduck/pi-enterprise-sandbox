import { useEffect, useMemo, useState } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import { conversationTitle, isInterruptedMessage } from '../../shared/state';
import { isTerminalRunStatus, listProcessesForSession } from '../../entities';
import { formatDuration, getActiveRunEntity } from '../runtime-timeline/buildTimeline';
import { BudgetBar } from '../budget-bar/BudgetBar';
import { shouldShowResumeEntry } from '../composer/composerMode';
import { agentTone } from '../conversation-sidebar/sidebarModel';
import { IconLayers, IconPanel, IconRefresh } from '../../shared/ui/Icons';
import s from './conversationHeader.module.css';

const LIVE_LABEL: Record<string, string> = {
  queued: '排队中',
  restoring_session: '恢复会话中',
  running: '运行中',
  waiting_approval: '等待审批',
  waiting_input: '等待你的回答',
  cancelling: '正在取消',
};

/**
 * Conversation title bar: what this conversation is and which agent it is
 * bound to, the live state of the current run (only while it runs), and the
 * toggle for the resources drawer (artifacts, files, datasets, processes).
 */
export function ConversationHeader() {
  const {
    state,
    entityStore,
    activeRunId,
    activeSessionId,
    displayMessages,
    resumeInterrupted,
    toggleSidebar,
    inspectorOpen,
    toggleInspector,
    agentNameById,
  } = useChat();

  const conv = (state.conversations || []).find((c) => c.id === state.conversationId);
  const title = conv ? conversationTitle(conv) : state.conversationId ? '会话' : '新会话';
  const run = getActiveRunEntity(entityStore, activeRunId);
  const live = Boolean(run && !isTerminalRunStatus(String(run.status)));
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [live]);

  const agentId = typeof conv?.agent_id === 'string' ? conv.agent_id : null;
  const agentName = agentNameById(agentId);
  const rawVersion = conv?.agent_version_no;
  const versionNo = rawVersion != null && Number.isFinite(Number(rawVersion)) ? Number(rawVersion) : null;

  const lastInterrupted = (() => {
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      if (displayMessages[i].role === 'assistant') return isInterruptedMessage(displayMessages[i]);
    }
    return false;
  })();
  const showResume = shouldShowResumeEntry({
    runStatus: run?.status,
    lastMessageInterrupted: lastInterrupted,
    isStreaming: state.isStreaming,
  });

  const resourceCount = useMemo(() => {
    const convId = state.conversationId;
    if (!convId) return 0;
    const runIds = new Set(
      Object.values(entityStore.runsById).filter((r) => r.conversationId === convId).map((r) => r.id),
    );
    const artifacts = Object.values(entityStore.artifactsById).filter((a) => a.runId && runIds.has(a.runId)).length;
    return artifacts + listProcessesForSession(entityStore, activeSessionId).length;
  }, [entityStore, state.conversationId, activeSessionId]);

  return (
    <header className={s.head} role="region" aria-label="Conversation">
      {state.sidebarOpen === false ? (
        <button type="button" className={s.icon} onClick={toggleSidebar} aria-label="Toggle sidebar" title="展开侧栏">
          <IconPanel size={18} />
        </button>
      ) : (
        <button type="button" className={`${s.icon} ${s.mobileOnly}`} onClick={toggleSidebar} aria-label="Toggle sidebar" title="会话列表">
          <IconPanel size={18} />
        </button>
      )}
      <h1 className={s.title} title={title}>{title}</h1>
      {/* Always shown, the org default included: the sidebar hides "default" tags to cut noise, the title bar does not. */}
      {agentId && agentName ? (
        <span className={s.chip} title="会话建立时绑定的智能体，之后不会变化">
          <span className={s.dot} style={{ ['--tone' as string]: `var(--agent-tone-${agentTone(agentId)})` }} />
          {agentName}
          {versionNo != null ? <span className={s.ver}>v{versionNo}</span> : null}
        </span>
      ) : null}

      <span className={s.sp} />

      <div className={s.status} aria-live="polite">
        {live && run ? (
          <span className={`${s.pill} ${run.status === 'waiting_approval' || run.status === 'waiting_input' ? s.warn : s.run}`} role="status">
            <span className={s.pulse} aria-hidden="true" />
            {LIVE_LABEL[String(run.status)] || '运行中'}
            <span className={s.dur}>{formatDuration(run.startedAt || run.createdAt, run.finishedAt)}</span>
          </span>
        ) : null}
        {run ? <BudgetBar run={run} /> : null}
        {showResume ? (
          <button type="button" className={s.btn} onClick={() => void resumeInterrupted()}>
            <IconRefresh size={12} /> 继续运行
          </button>
        ) : null}
      </div>

      <button
        type="button"
        className={`${s.btn}${inspectorOpen ? ` ${s.pressed}` : ''}`}
        id="btn-inspector-toggle"
        aria-label="Toggle context inspector"
        aria-pressed={inspectorOpen}
        onClick={toggleInspector}
        title="产物、文件、数据集与进程"
      >
        <IconLayers size={14} />
        资料{resourceCount ? <span className={s.count}>{resourceCount}</span> : null}
      </button>
    </header>
  );
}
