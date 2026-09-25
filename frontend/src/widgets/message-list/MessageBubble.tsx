import { memo, useState, type ReactNode } from 'react';
import type {
  AttachmentManifestItem,
  ChatMessage,
  ContentPart,
} from '../../shared/state';
import {
  fileTypeLabel,
  isInterruptedMessage,
  splitAttachmentDisplay,
} from '../../shared/state';
import { MarkdownBody, SafeDownloadLink } from '../markdown/Markdown';
import { TurnStream } from '../turn-stream/TurnStream';
import { messageFingerprint, messagePlainText } from './messageActions';
import {
  IconCopy,
  IconCheck,
  IconBrain,
  IconChevronDown,
  IconChevronRight,
  IconAlertCircle,
  IconRefresh,
} from '../../shared/ui/Icons';

function formatTime(createdAt?: string): string {
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) return '';
  const d = new Date(createdAt);
  const now = new Date();
  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  if (isSameDay) {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  }

  const isSameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: 'numeric',
    day: 'numeric',
    ...(isSameYear ? {} : { year: '2-digit' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function formatFileSize(n?: number | null): string {
  if (n == null || !Number.isFinite(Number(n)) || Number(n) <= 0) return '';
  const bytes = Number(n);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentCards({
  attachments,
}: {
  attachments: AttachmentManifestItem[];
}) {
  if (!attachments.length) return null;
  return (
    <div
      className="message-attachments"
      aria-label={`${attachments.length} attached file${attachments.length === 1 ? '' : 's'}`}
    >
      {attachments.map((attachment, index) => {
        const name =
          attachment.filename || attachment.name || attachment.path || 'File';
        const size = formatFileSize(attachment.size);
        return (
          <div
            className="message-attachment"
            key={String(attachment.attachment_id || attachment.path || `${name}-${index}`)}
            title={name}
          >
            <span className="file-type-tile" aria-hidden="true">
              {fileTypeLabel(name, attachment.mime_type)}
            </span>
            <span className="message-attachment-copy">
              <span className="message-attachment-name">{name}</span>
              <span className="message-attachment-meta">
                {size || 'Attached file'}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ThinkingBlock({
  thinking,
  isStreaming,
}: {
  thinking: string;
  isStreaming?: boolean;
}) {
  const [open, setOpen] = useState(isStreaming);

  return (
    <div className={`message-thinking-box${open ? ' is-open' : ''}${isStreaming ? ' is-streaming' : ''}`}>
      <button
        type="button"
        className="thinking-toggle-btn"
        onClick={() => setOpen((v) => !v)}
      >
        <IconBrain size={15} className="thinking-icon" />
        <span className="thinking-label">
          {isStreaming ? 'Agent Reasoning…' : 'Thought Process'}
        </span>
        {isStreaming ? <span className="thinking-live-dot" /> : null}
        <span className="thinking-chevron">
          {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        </span>
      </button>
      {open ? (
        <div className="message-thinking-body">{thinking}</div>
      ) : null}
    </div>
  );
}

function MessageBubbleBase({
  msg,
  idx,
  useTurnStream = false,
  canRegenerate = false,
  regenerateSource = null,
  onRegenerate,
}: {
  msg: ChatMessage;
  idx: number;
  /**
   * Render this assistant row as the Run's linear turn stream (thinking, text
   * and tool activity in event order). Precomputed by MessageList so this
   * component stays off the chat context and React.memo holds.
   */
  useTurnStream?: boolean;
  canRegenerate?: boolean;
  regenerateSource?: string | null;
  /** Stable callback from MessageList; identity must not change per render. */
  onRegenerate?: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const role = msg.role || 'assistant';
  const isUser = role === 'user';
  const interrupted = isInterruptedMessage(msg);
  const parts = msg.content || [];
  const runId = msg._runId || null;
  const turnStream = useTurnStream && !isUser && Boolean(runId);

  let hasContent = false;
  const body: ReactNode[] = [];
  let visibleAttachments = msg.attachments || [];

  if (turnStream && runId) {
    body.push(<TurnStream key="turn-stream" runId={runId} />);
    hasContent = true;
  }

  // Legacy rows (no Run entities in the store): thinking, then text parts.
  if (!turnStream && !isUser && msg.thinking) {
    body.push(
      <ThinkingBlock
        key="thinking"
        thinking={msg.thinking}
        isStreaming={msg.thinkingStatus === 'streaming'}
      />,
    );
    hasContent = true;
  }

  parts.forEach((p: ContentPart, i) => {
    if (turnStream) return;
    if (p.type === 'text' && 'text' in p && typeof p.text === 'string' && p.text) {
      if (isUser) {
        const display = splitAttachmentDisplay(p.text, visibleAttachments);
        visibleAttachments = display.attachments;
        if (display.text) {
          body.push(
            <span key={`t-${i}`} className="user-plain">
              {display.text}
            </span>,
          );
        }
      } else {
        let text = p.text;
        const stars = (text.match(/\*\*/g) || []).length;
        if (stars % 2 === 1) text = `${text}**`;
        body.push(<MarkdownBody key={`t-${i}`} text={text} />);
      }
      hasContent = true;
    }
  });

  // 4. Attachments & File Links
  if (isUser && visibleAttachments.length) {
    body.push(
      <AttachmentCards
        key="message-attachments"
        attachments={visibleAttachments}
      />,
    );
    hasContent = true;
  }

  if (msg._fileLinks && !turnStream) {
    for (const fl of msg._fileLinks) {
      body.push(
        <SafeDownloadLink
          key={`fl-${fl.url}-${fl.name}`}
          url={fl.url}
          name={fl.name || 'file'}
          path={fl.path}
        />,
      );
      hasContent = true;
    }
  }

  async function handleCopy() {
    try {
      if (!navigator.clipboard?.writeText || !copyText) return;
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  // Only text parts are copyable; a bubble that carried nothing but tool calls
  // would otherwise offer a Copy button that writes an empty string.
  const copyText = messagePlainText(msg);

  function handleRegenerate() {
    if (!canRegenerate || !regenerateSource) return;
    onRegenerate?.(regenerateSource);
  }

  return (
    <div
      className={`mw ${role}`}
      style={{ animationDelay: `${Math.min(idx, 8) * 30}ms` }}
    >
      <div className="body">
        {!isUser ? (
          <div className="msg-header" aria-hidden="true">
            <div className="msg-avatar-brand">
              <img src="/brand/uprc-icon.png" alt="" width={18} height={18} />
            </div>
            <span className="msg-role-name">UPRC Agent</span>
          </div>
        ) : null}

        <div className={`bubble${isUser ? '' : ' bubble-md'}`}>
          {hasContent ? body : <em className="bubble-empty">(empty message)</em>}
          {!isUser && interrupted ? (
            <div className="msg-interrupted-banner" role="status">
              <IconAlertCircle size={14} />
              <span>Execution interrupted</span>
            </div>
          ) : null}
        </div>
        {!isUser && (copyText.length > 0 || canRegenerate) ? (
          <div className="msg-actions" aria-label="Message actions">
            {copyText.length > 0 ? (
              <button
                type="button"
                className="msg-action-btn"
                onClick={() => void handleCopy()}
                title="Copy message text"
                aria-label="Copy message text"
              >
                {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            ) : null}
            {canRegenerate && regenerateSource ? (
              <button
                type="button"
                className="msg-action-btn"
                onClick={handleRegenerate}
                title="Re-send the previous message and generate a new answer"
                aria-label="Regenerate answer"
              >
                <IconRefresh size={13} />
                <span>Regenerate</span>
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="time">{formatTime(msg.createdAt)}</div>
      </div>
    </div>
  );
}

/**
 * Memoized: during streaming every SSE tick rebuilds the projected transcript
 * with fresh objects, so identity comparison never holds. The fingerprint
 * skips re-renders when a bubble's rendered content is unchanged — the
 * streaming bubble still updates (its text/thinking grows), completed ones
 * stop re-parsing markdown.
 */
export const MessageBubble = memo(
  MessageBubbleBase,
  (prev, next) =>
    prev.idx === next.idx &&
    prev.useTurnStream === next.useTurnStream &&
    prev.canRegenerate === next.canRegenerate &&
    prev.regenerateSource === next.regenerateSource &&
    prev.onRegenerate === next.onRegenerate &&
    (prev.msg === next.msg ||
      messageFingerprint(prev.msg) === messageFingerprint(next.msg)),
);
