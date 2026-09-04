import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent,
} from 'react';
import { useChat } from '../../features/chat/ChatContext';
import {
  activeAttachments,
  canSendAttachments,
  fileTypeLabel,
  hasUploadingAttachments,
  isInterruptedMessage,
  pastedImageName,
  uploadedAttachments,
} from '../../shared/state';
import { isEnterSubmitKey, isUploadShortcut } from '../../shared/ui/keyboard';
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
import { ModelPicker } from './ModelPicker';
import { AgentPicker } from './AgentPicker';
import {
  formatRunStatusLabel,
  getActiveRunEntity,
} from '../runtime-timeline/buildTimeline';
import {
  IconPaperclip,
  IconStop,
  IconSend,
  IconSteer,
  IconPlus,
  IconRefresh,
  IconClose,
  IconAlertCircle,
  IconUpload,
} from '../../shared/ui/Icons';

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
    respondInteraction,
    displayMessages,
    models,
    selectedModelId,
    setSelectedModelId,
    agents,
    selectedAgentId,
    setSelectedAgentId,
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

  // Queued/restoring runs cannot accept steer; keep the available action active.
  useEffect(() => {
    if (mode !== 'running') {
      setRunningAction('steer');
    } else if (!canSteer(mode, run?.status)) {
      setRunningAction('follow_up');
    }
  }, [mode, run?.status]);

  const attachments = activeAttachments(state.attachments);
  const gateOk = canSendAttachments(state.attachments);
  const uploading = hasUploadingAttachments(state.attachments);
  const hasUploaded = uploadedAttachments(state.attachments).length > 0;

  const idleSendDisabled = !gateOk;
  const textEmpty = !draftText.trim() && !hasUploaded;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draftText]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (isEnterSubmitKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) {
      e.preventDefault();
      void onPrimaryAction();
    }
  }

  function onInput(e: ChangeEvent<HTMLTextAreaElement>) {
    setDraftText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  /**
   * Ctrl+V / Cmd+V attaches images (and any other file) from the clipboard.
   *
   * Screenshots arrive as unnamed blobs, so each one is renamed before it hits
   * the upload queue — the attachment allowlist keys on the extension, and an
   * unnamed blob would be refused as a denied type. Files that already carry a
   * name (copied from a file manager) keep it.
   *
   * The event is only consumed when a file actually came off the clipboard;
   * pasting text must still land in the textarea untouched, including the mixed
   * case where a copy carries both an image and its alt text.
   */
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    // Same gate as the upload button and Ctrl+U: no attaching mid-run.
    if (mode === 'running') return;
    const items = Array.from(e.clipboardData?.items || []);
    const now = Date.now();
    const files: File[] = [];
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      if (file.name) {
        files.push(file);
        continue;
      }
      const name = pastedImageName(file.type, files.length + 1, now);
      // An unnamed non-image blob has no extension we can justify inventing;
      // the server allowlist would refuse it anyway.
      if (!name) continue;
      files.push(new File([file], name, { type: file.type }));
    }
    if (!files.length) return;
    e.preventDefault();
    void handleFilesSelected(files);
  }

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  // Ctrl+U / Cmd+U attaches files. The upload button is disabled while a run
  // is active, so the shortcut respects the same gate.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (
        !isUploadShortcut({
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
          isComposing: e.isComposing,
        })
      ) {
        return;
      }
      // The upload button is disabled while a run is active; the shortcut
      // respects the same gate and leaves the key to the browser otherwise.
      if (mode === 'running') return;
      e.preventDefault();
      fileInputRef.current?.click();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode]);

  async function onPrimaryAction() {
    if (submitting) return;

    if (mode === 'idle') {
      if (idleSendDisabled) return;
      if (textEmpty) return;
      void sendMessage(draftText);
      return;
    }

    if (mode === 'waiting_input') {
      if (run?.pendingInput?.interactionType === 'confirm') return;
      const text = draftText.trim();
      if (!text) return;
      setSubmitting(true);
      try {
        if (await respondInteraction(text)) setDraftText('');
      } finally {
        setSubmitting(false);
      }
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
      : mode === 'waiting_input'
        ? 'Respond'
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
        ? 'Steer — change direction immediately (Enter)'
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
          <div className="dz-icon">
            <IconUpload size={38} />
          </div>
          <p>Drop file to upload</p>
          <small>Uploaded directly to sandbox workspace</small>
        </div>
      </div>

      <div className={`input-wrap composer-mode-${mode}`}>
        {mode === 'waiting_approval' ? (
          <div className="composer-banner waiting" role="status">
            <div className="composer-banner-content">
              <IconAlertCircle size={16} className="composer-banner-icon" />
              <span className="composer-banner-text">
                Agent is waiting for human approval
                {pendingApproval?.reason
                  ? `: ${pendingApproval.reason}`
                  : ''}
              </span>
            </div>
            <div className="composer-banner-actions">
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
                  Cancel Run
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {mode === 'waiting_input' && run?.pendingInput ? (
          <div className="composer-banner waiting ix-composer-hint" role="status">
            <div className="composer-banner-content">
              <IconAlertCircle size={16} className="composer-banner-icon" />
              <span className="composer-banner-text">
                <strong>{run.pendingInput.title}</strong>
                {run.pendingInput.message
                  ? ` — reply in card or type here`
                  : ' — reply in card or type here'}
              </span>
            </div>
            {run.pendingInput.options.length ? (
              <div className="composer-banner-actions">
                {run.pendingInput.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="composer-banner-btn"
                    onClick={() => void respondInteraction(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            ) : null}
            {run.pendingInput.interactionType === 'confirm' ? (
              <div className="composer-banner-actions">
                <button
                  type="button"
                  className="composer-banner-btn approve"
                  onClick={() => void respondInteraction(true)}
                >
                  Confirm
                </button>
                <button
                  type="button"
                  className="composer-banner-btn reject"
                  onClick={() => void respondInteraction(false)}
                >
                  Decline
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {showResume ? (
          <div className="composer-banner resume" role="status">
            <div className="composer-banner-content">
              <IconAlertCircle size={16} className="composer-banner-icon" />
              <span className="composer-banner-text">
                Run was interrupted
                {run?.status === 'interrupted'
                  ? ` (${formatRunStatusLabel(run.status)})`
                  : ''}
                . You can continue the execution.
              </span>
            </div>
            <div className="composer-banner-actions">
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
            </div>
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
                <IconSteer size={13} /> Steer
              </button>
              <button
                type="button"
                className={`composer-action-btn${runningAction === 'follow_up' ? ' active' : ''}`}
                onClick={() => setRunningAction('follow_up')}
                title="Queue after current run finishes"
              >
                <IconPlus size={13} /> Follow-up
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
              <span
                className={`file-type-tile${a.status === 'uploading' || a.status === 'queued' ? ' is-loading' : ''}${a.status === 'failed' ? ' is-error' : ''}`}
                aria-hidden="true"
              >
                {a.status === 'failed'
                  ? '!'
                  : fileTypeLabel(a.name, a.mimeType)}
              </span>
              <span className="att-meta">
                <span className="att-name" title={a.path || a.name || ''}>
                  {a.name || 'file'}
                </span>
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
                    {a.status === 'queued' ? 'Waiting to upload' : 'Uploading…'}
                  </span>
                ) : (
                  <span className="att-size">
                    {[formatSize(a.size), 'Ready'].filter(Boolean).join(' · ')}
                  </span>
                )}
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
                    <IconRefresh size={13} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="att-btn att-remove"
                  title="Remove attachment"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => removeAttachmentDraft(a.localId)}
                >
                  <IconClose size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>

        <div className="composer-model-row">
          <ModelPicker
            models={models}
            selectedModelId={selectedModelId}
            onSelect={setSelectedModelId}
            disabled={mode !== 'idle' || models.length === 0}
          />
          {/* 单 Agent 的 org 完全看不到这个控件，体验与多 Agent 上线前一致。 */}
          {agents.length > 1 && !state.conversationId ? (
            <AgentPicker
              agents={agents}
              selectedAgentId={selectedAgentId}
              onSelect={setSelectedAgentId}
              disabled={mode !== 'idle'}
            />
          ) : null}
        </div>

        <div className="input-inner">
          <div className="composer-tools-left">
            <button
              className="btn btn-upload"
              id="btn-upload"
              title="Attach files (Ctrl+U)"
              type="button"
              onClick={openFilePicker}
              disabled={mode === 'running'}
            >
              <IconPaperclip size={17} />
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
          </div>

          <textarea
            id="input"
            ref={textareaRef}
            rows={1}
            placeholder={composerPlaceholder(mode, runningAction)}
            value={draftText}
            disabled={false}
            onChange={onInput}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />

          <div className="composer-tools-right">
            {canStop(mode) ? (
              <button
                className="btn btn-stop"
                id="btn-stop"
                type="button"
                title="Stop run"
                aria-label="Stop generating"
                onClick={onStop}
              >
                <IconStop size={13} />
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
              {mode === 'idle' ? (
                <IconSend size={15} />
              ) : primaryLabel === 'Steer' ? (
                <IconSteer size={15} />
              ) : (
                <IconPlus size={15} />
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
