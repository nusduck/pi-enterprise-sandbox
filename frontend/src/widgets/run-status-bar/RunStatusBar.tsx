import { useEffect, useState } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import {
  countRunTools,
  formatDuration,
  formatRunStatusLabel,
  getActiveRunEntity,
  runStatusTone,
} from '../runtime-timeline/buildTimeline';
import { BudgetBar } from '../budget-bar/BudgetBar';
import { shouldShowResumeEntry } from '../composer/composerMode';
import { isInterruptedMessage } from '../../shared/state';

/**
 * Run Status Bar — Running · N Tool Calls · duration · budget · resume (ADR §5.2 / F4).
 */
export function RunStatusBar() {
  const { entityStore, activeRunId, state, resumeInterrupted } = useChat();
  const runId = activeRunId || entityStore.activeRunId;
  const run = getActiveRunEntity(entityStore, runId);
  const [, setTick] = useState(0);

  // Live duration tick while run is active
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

  if (!run && !state.isStreaming) {
    return (
      <div className="run-status-bar idle" role="status" aria-live="polite">
        <span className="rsb-status">Idle</span>
        <span className="rsb-sep">·</span>
        <span className="rsb-detail">No active run</span>
      </div>
    );
  }

  const status = run?.status || (state.isStreaming ? 'running' : 'queued');
  const tone = runStatusTone(status);
  const tools = runId ? countRunTools(entityStore, runId) : 0;
  const duration = run
    ? formatDuration(run.startedAt || run.createdAt, run.finishedAt)
    : '—';
  const step = tools > 0 ? tools : null;

  const lastInterrupted = (() => {
    const msgs = state.currentMsg
      ? [...state.messages, state.currentMsg]
      : state.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') return isInterruptedMessage(msgs[i]);
    }
    return false;
  })();

  const showResume = shouldShowResumeEntry({
    runStatus: run?.status,
    lastMessageInterrupted: lastInterrupted,
    isStreaming: state.isStreaming,
  });

  return (
    <div
      className={`run-status-bar tone-${tone}`}
      role="status"
      aria-live="polite"
      data-run-id={run?.id || ''}
      data-run-status={status}
    >
      <span className="rsb-dot" aria-hidden="true" />
      <span className="rsb-status">{formatRunStatusLabel(status)}</span>
      {step != null ? (
        <>
          <span className="rsb-sep">·</span>
          <span className="rsb-detail">Step {step}</span>
        </>
      ) : null}
      <span className="rsb-sep">·</span>
      <span className="rsb-detail">
        {tools} Tool Call{tools === 1 ? '' : 's'}
      </span>
      <span className="rsb-sep">·</span>
      <span className="rsb-detail mono">{duration}</span>
      {run?.error ? (
        <>
          <span className="rsb-sep">·</span>
          <span className="rsb-error" title={run.error}>
            {run.error.length > 60 ? `${run.error.slice(0, 57)}…` : run.error}
          </span>
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
      {state.traceId ? (
        <span className="rsb-trace" title={state.traceId}>
          trace {state.traceId.slice(0, 8)}
        </span>
      ) : null}
    </div>
  );
}
