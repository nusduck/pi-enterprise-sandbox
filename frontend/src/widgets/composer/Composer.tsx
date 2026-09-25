import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent,
} from 'react';
import { useChat } from '../../features/chat/ChatContext';
import { formatElapsed } from '../../features/chat/projections/turnFields';
import {
  activeAttachments,
  canSendAttachments,
  hasUploadingAttachments,
  pastedImageName,
  uploadedAttachments,
} from '../../shared/state';
import { isEnterSubmitKey, isUploadShortcut } from '../../shared/ui/keyboard';
import { canFollowUp, canSteer, canStop, resolveComposerMode } from './composerMode';
import { ModelPicker } from './ModelPicker';
import { AgentPicker } from './AgentPicker';
import { AttachmentChips } from './AttachmentChips';
import { effectiveModel, supportsImages } from '../../features/chat/effectiveModel';
import { ImportArtifactDialog } from './ImportArtifactDialog';
import { getActiveRunEntity } from '../runtime-timeline/buildTimeline';
import { IconPlus, IconSend, IconStop, IconUpload } from '../../shared/ui/Icons';
import { usePreference } from '../../shared/ui/preferences';
import s from './composer.module.css';

const STATUS_LINE: Record<string, string> = {
  running: '正在运行',
  waiting_approval: '正在等待审批',
  waiting_input: '等待你的回答',
};

const MODE_NOTE: Record<string, string> = {
  waiting_approval: '等待审批：在上方卡片里批准或拒绝；这里输入的内容会排队',
  waiting_input: '智能体在等你回答：可以点上方选项，也可以直接输入',
};

/**
 * Message composer. While a run is active the box stays usable: Enter queues a
 * follow-up that runs after the current one, Cmd/Ctrl+Enter steers the run
 * now. Approvals and questions are answered in the stream, not here.
 */
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
    respondInteraction,
    importArtifactToConversation,
    models,
    selectedModelId,
    fixedModelId,
    setSelectedModelId,
    agents,
    selectedAgentId,
    setSelectedAgentId,
  } = useChat();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [enterPref] = usePreference('enterWhileRunning');
  const [plusOpen, setPlusOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

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
      // The preference picks what plain Enter does; Cmd/Ctrl+Enter does the other.
      const modified = e.metaKey || e.ctrlKey;
      void onPrimaryAction(enterPref === 'steer' ? !modified : modified);
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

  async function onPrimaryAction(steer = false) {
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
        if (steer && canSteer(mode, run?.status)) {
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

  // Image attachments need a model that reads images; say so before sending
  // rather than flashing an error after the click.
  const needsVision = uploadedAttachments(state.attachments).some((a) => (a.mimeType || '').startsWith('image/'))
    && !supportsImages(effectiveModel(models, selectedModelId, fixedModelId));
  const primaryDisabled =
    submitting || needsVision || (mode === 'idle' ? idleSendDisabled || textEmpty : !draftText.trim());
  const primaryLabel = mode === 'idle' ? '发送' : mode === 'waiting_input' ? '回答' : '排队追问';
  const placeholder =
    mode === 'idle'
      ? state.conversationId ? '继续对话…' : '描述你要完成的任务…'
      : mode === 'waiting_input' ? '输入你的回答…' : enterPref === 'steer' ? '补充要求，Enter 立即改向…' : '补充要求，Enter 排队追问…';
  // Ticks once a second while a run is in flight, for the elapsed-time line.
  const [now, setNow] = useState(() => Date.now());
  // A freshly created run may not carry timestamps yet; fall back to when this
  // composer saw it start.
  const [seenStart, setSeenStart] = useState<number | null>(null);
  const busy = mode !== 'idle';
  useEffect(() => {
    if (!busy) {
      setSeenStart(null);
      return;
    }
    setSeenStart(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy, runId]);
  const stamped = Date.parse(String(run?.startedAt || run?.createdAt || ''));
  const runStart = Number.isFinite(stamped) ? stamped : seenStart ?? NaN;
  const statusLine = mode !== 'idle' && STATUS_LINE[mode]
    ? `${STATUS_LINE[mode]}${Number.isFinite(runStart) ? ` · 已运行 ${formatElapsed(now - runStart)}` : ''}`
    : '';
  const runningNote = enterPref === 'steer' ? 'Enter 立即改向 · ⌘Enter 排队追问' : 'Enter 排队追问 · ⌘Enter 立即改向';
  const note = needsVision
    ? '当前模型不支持图片，请换一个支持看图的模型'
    : mode === 'running' ? runningNote : MODE_NOTE[mode] || (!gateOk ? (uploading ? '等待附件上传完成' : '有附件上传失败，请重试或移除') : '');

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
          <p>松开即可上传</p>
          <small>文件会上传到当前会话的工作区</small>
        </div>
      </div>

      <div className={s.wrap}>
        <div className={s.box} data-mode={mode}>
          {statusLine ? (
            <div className={s.status} role="status">
              {mode === 'running' ? <span className={s.spin} aria-hidden="true" /> : <span className={s.statusDot} aria-hidden="true" />}
              {statusLine}
            </div>
          ) : null}
          <AttachmentChips
            attachments={attachments}
            onRemove={removeAttachmentDraft}
            onRetry={(id) => void retryAttachmentDraft(id)}
          />
          <textarea
            id="input"
            ref={textareaRef}
            className={s.input}
            rows={1}
            placeholder={placeholder}
            aria-label="消息"
            value={draftText}
            onChange={onInput}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <div className={s.row}>
            <div className={s.plusWrap}>
              <button
                type="button"
                id="btn-upload"
                className={s.tool}
                aria-expanded={plusOpen}
                aria-label="添加文件或引用产物"
                title="添加文件或引用产物（⌘U 直接选择文件）"
                disabled={mode === 'running'}
                onClick={() => setPlusOpen((v) => !v)}
              >
                <IconPlus size={16} />
              </button>
              {plusOpen ? (
                <div className={s.pop} role="menu" onMouseLeave={() => setPlusOpen(false)}>
                  <button type="button" role="menuitem" onClick={() => { setPlusOpen(false); openFilePicker(); }}>
                    上传文件或图片
                    <small>也可以拖拽或粘贴 · ⌘U</small>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!state.conversationId}
                    onClick={() => { setPlusOpen(false); setImportOpen(true); }}
                  >
                    引用其他会话的产物
                    <small>{state.conversationId ? '复制到当前会话的工作区' : '会话开始后可用'}</small>
                  </button>
                </div>
              ) : null}
            </div>
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
            <ModelPicker
              models={models}
              selectedModelId={selectedModelId}
              onSelect={setSelectedModelId}
              fixedModelId={fixedModelId}
              disabled={mode !== 'idle' || models.length === 0}
            />
            {/* 只在建会话前可选：会话一旦开始就绑定了智能体。 */}
            {agents.length > 1 && !state.conversationId ? (
              <AgentPicker
                agents={agents}
                selectedAgentId={selectedAgentId}
                onSelect={setSelectedAgentId}
                disabled={mode !== 'idle'}
              />
            ) : null}
            <span className={s.note} role="status">{note}</span>
            <div className={s.actions} role="group" aria-label="Running action">
              {canStop(mode) ? (
                <button type="button" id="btn-stop" className={s.stop} aria-label="停止运行" title="停止运行" onClick={onStop}>
                  <IconStop size={12} />
                </button>
              ) : null}
              <button
                type="button"
                id="btn-send"
                className={s.send}
                aria-label={primaryLabel}
                title={`${primaryLabel}（Enter）`}
                disabled={primaryDisabled}
                onClick={() => void onPrimaryAction()}
              >
                <IconSend size={15} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {state.conversationId ? (
        <ImportArtifactDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          conversations={state.conversations || []}
          currentConversationId={state.conversationId}
          onImport={(artifactId, target) => importArtifactToConversation(artifactId, target)}
        />
      ) : null}
    </>
  );
}
