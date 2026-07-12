import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ChangeEvent,
} from 'react';
import { useChat } from '../../features/chat/ChatContext';
import {
  activeAttachments,
  canSendAttachments,
  hasUploadingAttachments,
  isInterruptedMessage,
  uploadedAttachments,
} from '../../shared/state';
import {
  canFollowUp,
  canSteer,
  canStop,
  composerModeLabel,
  composerPlaceholder,
  resolveComposerMode,
  runningActionHint,
  shouldShowResumeEntry,
  type RunningAction,
} from './composerMode';
import {
  formatRunStatusLabel,
  getActiveRunEntity,
} from '../runtime-timeline/buildTimeline';

function formatSize(n?: number | null): string {
  if (n == null || Number.isNaN(Number(n))) return '';
  const b = Number(n);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export function Composer() {
  const {
    state,
    draftText,
    setDraftText,
    sendMessage,
    cancelStream,
    handleFilesSelected,
    removeAttachmentDraft,
    retryAttachmentDraft,
    dropzoneVisible,
    setDropzoneVisible,
    entityStore,
    activeRunId,
    steerRun,
    followUpRun,
    stopRun,
    approvePending,
    rejectPending,
    resumeInterrupted,
    resolveApproval,
    displayMessages,
  } = useChat();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [runningAction, setRunningAction] = useState<RunningAction>('steer');
  const [submitting, setSubmitting] = useState(false);

  const runId = activeRunId;
  const run = getActiveRunEntity(entityStore, runId);
  const pendingApproval = Object.values(entityStore.approvalsById).find(
    (a) => a.runId === run?.id && a.status === 'pending',
  );
  const hasPendingApproval = Boolean(pendingApproval);

  const mode = resolveComposerMode({
    isStreaming: state.isStreaming,
    runStatus: run?.status,
    hasPendingApproval,
  });

  const lastInterrupted = useMemo(() => {
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      if (displayMessages[i].role === 'assistant') {
        return isInterruptedMessage(displayMessages[i]);
      }
    }
    return false;
  }, [displayMessages]);

  const showResume = shouldShowResumeEntry({
    runStatus: run?.status,
    lastMessageInterrupted: lastInterrupted,
    isStreaming: state.isStreaming,
  });

  // Reset to steer when leaving running mode
  useEffect(() => {
    if (mode !== 'running') setRunningAction('steer');
  }, [mode]);

  const attachments = activeAttachments(state.attachments);
  const gateOk = canSendAttachments(state.attachments);
  const uploading = hasUploadingAttachments(state.attachments);
  const hasUploaded = uploadedAttachments(state.attachments).length > 0;

  const idleSendDisabled = !gateOk;
  const textEmpty = !draftText.trim() && !hasUploaded;

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void onPrimaryAction();
    }
  }

  function onInput(e: ChangeEvent<HTMLTextAreaElement>) {
    setDraftText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  async function onPrimaryAction() {
    if (submitting) return;

    if (mode === 'idle') {
      if (idleSendDisabled) return;
      if (textEmpty) return;
      void sendMessage(draftText);
      return;
    }

    if (mode === 'running' || mode === 'waiting_approval') {
      const text = draftText.trim();
      if (!text) return;
      setSubmitting(true);
      try {
        if (mode === 'running' && runningAction === 'steer' && canSteer(mode, run?.status)) {
          await steerRun(text);
        } else if (canFollowUp(mode)) {
          await followUpRun(text);
        }
      } finally {
        setSubmitting(false);
      }
    }
  }

  function onStop() {
    if (!canStop(mode)) return;
    stopRun();
  }

  const primaryLabel =
    mode === 'idle'
      ? 'Send'
      : mode === 'running' && runningAction === 'steer'
        ? 'Steer'
        : 'Follow-up';

  const primaryTitle =
    mode === 'idle'
      ? !gateOk
        ? uploading
          ? 'Wait for uploads to finish'
          : 'Remove or retry failed attachments'
        : 'Send (Enter)'
      : runningAction === 'steer' && mode === 'running'
        ? 'Steer — change direction now (Enter)'
        : 'Follow-up — queue after current work (Enter)';

  const primaryDisabled =
    submitting ||
    (mode === 'idle'
      ? idleSendDisabled || textEmpty
      : !draftText.trim() ||
        (mode === 'running' &&
          runningAction === 'steer' &&
          !canSteer(mode, run?.status)));

  return (
    <>
      <div
        id="dropzone"
        className={`dropzone${dropzoneVisible ? ' show' : ''}`}
        onDragLeave={(e) => {
          e.preventDefault();
          if (e.target === e.currentTarget) setDropzoneVisible(false);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          setDropzoneVisible(false);
          const files = e.dataTransfer.files;
          if (files?.length) void handleFilesSelected(files);
        }}
      >
        <div className="dropzone-inner">
          <div className="dz-icon">📤</div>
          <p>Drop file to upload</p>
          <small>Uploaded to sandbox workspace</small>
        </div>
      </div>

      <div className={`input-wrap composer-mode-${mode}`}>
        {mode === 'waiting_approval' ? (
          <div className="composer-banner waiting" role="status">
            <span className="composer-banner-text">
              Agent is waiting for approval
              {pendingApproval?.reason
                ? `: ${pendingApproval.reason}`
                : ''}
            </span>
            <span className="composer-banner-actions">
              <button
                type="button"
                className="composer-banner-btn approve"
                onClick={() => {
                  if (pendingApproval?.id) {
                    void resolveApproval(pendingApproval.id, 'approve');
                  } else {
                    void approvePending();
                  }
                }}
              >
                Approve
              </button>
              <button
                type="button"
                className="composer-banner-btn reject"
                onClick={() => {
                  if (pendingApproval?.id) {
                    void resolveApproval(pendingApproval.id, 'reject');
                  } else {
                    void rejectPending();
                  }
                }}
              >
                Reject
              </button>
              {canStop(mode) ? (
                <button
                  type="button"
                  className="composer-banner-btn stop"
                  onClick={onStop}
                >
                  Cancel run
                </button>
              ) : null}
            </span>
          </div>
        ) : null}

        {showResume ? (
          <div className="composer-banner resume" role="status">
            <span className="composer-banner-text">
              Run was interrupted
              {run?.status === 'interrupted'
                ? ` (${formatRunStatusLabel(run.status)})`
                : ''}
              . You can continue the conversation.
            </span>
            <span className="composer-banner-actions">
              <button
                type="button"
                className="composer-banner-btn resume"
                onClick={() => {
                  void resumeInterrupted();
                  textareaRef.current?.focus();
                }}
              >
                Resume
              </button>
            </span>
          </div>
        ) : null}

        {mode === 'running' ? (
          <div className="composer-mode-bar">
            <span className="composer-mode-label">
              {composerModeLabel(mode)}
            </span>
            <div className="composer-action-switch" role="group" aria-label="Running action">
              <button
                type="button"
                className={`composer-action-btn${runningAction === 'steer' ? ' active' : ''}`}
                onClick={() => setRunningAction('steer')}
                disabled={!canSteer(mode, run?.status)}
                title="Change current execution direction"
              >
                Steer
              </button>
              <button
                type="button"
                className={`composer-action-btn${runningAction === 'follow_up' ? ' active' : ''}`}
                onClick={() => setRunningAction('follow_up')}
                title="Queue after current run finishes"
              >
                Follow-up
              </button>
            </div>
            <span className="composer-action-hint">
              {runningActionHint(runningAction)}
            </span>
          </div>
        ) : null}

        <div
          id="attachment-drafts"
          className="attachment-drafts"
          hidden={attachments.length === 0}
          aria-live="polite"
        >
          {attachments.map((a) => (
            <div
              key={a.localId}
              className={`att-chip att-${a.status}`}
              data-local-id={a.localId}
            >
              <span className="att-icon" aria-hidden="true">
                {a.status === 'uploading' || a.status === 'queued'
                  ? '⏳'
                  : a.status === 'failed'
                    ? '⚠'
                    : '📎'}
              </span>
              <span className="att-meta">
                <span className="att-name" title={a.path || a.name || ''}>
                  {a.name || 'file'}
                </span>
                {formatSize(a.size) ? (
                  <span className="att-size">{formatSize(a.size)}</span>
                ) : null}
                {a.status === 'failed' && a.error ? (
                  <span
                    className="att-error"
                    title={
                      a.errorCode ? `${a.errorCode}: ${a.error}` : a.error
                    }
                  >
                    {a.error}
                    {a.traceId ? ` (trace ${a.traceId.slice(0, 8)})` : ''}
                  </span>
                ) : a.status === 'uploading' || a.status === 'queued' ? (
                  <span className="att-status">
                    {a.status === 'queued' ? 'queued' : 'uploading…'}
                  </span>
                ) : null}
              </span>
              <span className="att-actions">
                {a.status === 'failed' ? (
                  <button
                    type="button"
                    className="att-btn att-retry"
                    title="Retry upload"
                    aria-label={`Retry ${a.name}`}
                    onClick={() => void retryAttachmentDraft(a.localId)}
                  >
                    ↻
                  </button>
                ) : null}
                <button
                  type="button"
                  className="att-btn att-remove"
                  title="Remove attachment"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => removeAttachmentDraft(a.localId)}
                >
                  ×
                </button>
              </span>
            </div>
          ))}
        </div>

        <div className="input-inner">
          <button
            className="btn btn-upload"
            id="btn-upload"
            title="Attach files (Ctrl+U)"
            type="button"
            onClick={openFilePicker}
            disabled={mode === 'running'}
          >
            📎
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) {
                void handleFilesSelected(e.target.files);
                e.target.value = '';
              }
            }}
          />
          <textarea
            id="input"
            ref={textareaRef}
            rows={1}
            placeholder={composerPlaceholder(mode, runningAction)}
            value={draftText}
            disabled={false}
            onChange={onInput}
            onKeyDown={onKeyDown}
          />
          {canStop(mode) ? (
            <button
              className="btn btn-stop"
              id="btn-stop"
              type="button"
              title="Stop run"
              aria-label="Stop generating"
              onClick={onStop}
            >
              ■
            </button>
          ) : null}
          <button
            className={`btn ${mode === 'idle' ? 'btn-send' : 'btn-action'}`}
            id="btn-send"
            type="button"
            title={primaryTitle}
            aria-label={primaryLabel}
            disabled={primaryDisabled}
            onClick={() => void onPrimaryAction()}
          >
            {mode === 'idle' ? '➤' : primaryLabel === 'Steer' ? '↪' : '＋'}
          </button>
        </div>
      </div>
    </>
  );
}

// Re-export gate helpers for tests / external use
export { canSendAttachments, hasUploadingAttachments };
export {
  resolveComposerMode,
  composerModeLabel,
  shouldShowResumeEntry,
} from './composerMode';
