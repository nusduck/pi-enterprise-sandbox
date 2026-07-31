import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type {
  AttachmentManifestItem,
  ChatMessage,
  ContentPart,
  ToolUsePart,
} from '../../shared/state';
import {
  fileTypeLabel,
  isInterruptedMessage,
  splitAttachmentDisplay,
} from '../../shared/state';
import { safeApiUrl } from '../../shared/security/url';
import { useChat } from '../../features/chat/ChatContext';
import {
  InlineRuntimeSteps,
  runHasEntitySteps,
} from '../runtime-steps/InlineRuntimeSteps';
import { ToolPill } from './ToolPill';

function SafeDownloadLink({
  url,
  name,
  className = 'dl',
}: {
  url: string;
  name: string;
  className?: string;
}) {
  const safe = safeApiUrl(url);
  if (!safe) return <span>{name}</span>;
  return (
    <a className={className} href={safe} download="">
      ⬇ {name}
    </a>
  );
}

function formatTime(createdAt?: string): string {
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) return '';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(createdAt));
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

function MarkdownBody({ text }: { text: string }) {
  // Extract download-markdown patterns into trailing links
  const re = /📄 \*\*([^*]+)\*\* — \[Download\]\(([^)]+)\)\n?/g;
  const links: { name: string; url: string }[] = [];
  let m: RegExpExecArray | null;
  let cleaned = text;
  while ((m = re.exec(text)) !== null) {
    links.push({ name: m[1], url: m[2] });
  }
  if (links.length) {
    cleaned = text.replace(re, '').trimEnd();
  }

  return (
    <>
      <div className="md-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSanitize]}
          components={{
            a: ({ href, children }) => {
              const safe = href ? safeApiUrl(href) || href : undefined;
              // Only allow http(s) and relative safe API paths
              const ok =
                safe &&
                (safe.startsWith('http://') ||
                  safe.startsWith('https://') ||
                  safe.startsWith('/api/'));
              if (!ok) return <span>{children}</span>;
              return (
                <a href={safe} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            },
            code: ({ className, children, ...props }) => {
              const inline = !className;
              if (inline) {
                return (
                  <code className="md-code-inline" {...props}>
                    {children}
                  </code>
                );
              }
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            },
            pre: ({ children }) => <pre className="md-pre">{children}</pre>,
            table: ({ children }) => (
              <div className="md-table-wrap">
                <table>{children}</table>
              </div>
            ),
          }}
        >
          {cleaned}
        </ReactMarkdown>
      </div>
      {links.map((fl) => (
        <SafeDownloadLink
          key={`dl-${fl.url}-${fl.name}`}
          url={fl.url}
          name={fl.name}
        />
      ))}
    </>
  );
}

export function MessageBubble({
  msg,
  idx,
  showRuntimeSteps = false,
}: {
  msg: ChatMessage;
  idx: number;
  /** When true, render entity-backed tool/MCP/process steps for this turn. */
  showRuntimeSteps?: boolean;
}) {
  const { entityStore } = useChat();
  const role = msg.role || 'assistant';
  const isUser = role === 'user';
  const interrupted = isInterruptedMessage(msg);
  const parts = msg.content || [];
  const runId = msg._runId || null;
  const useEntitySteps =
    Boolean(showRuntimeSteps) &&
    !isUser &&
    runHasEntitySteps(entityStore, runId);

  let hasContent = false;
  const body: ReactNode[] = [];
  let visibleAttachments = msg.attachments || [];

  if (!isUser && msg.thinking) {
    body.push(
      <details key="thinking" className="message-thinking">
        <summary>
          Thinking{msg.thinkingStatus === 'streaming' ? '…' : ''}
        </summary>
        <div className="message-thinking-body">{msg.thinking}</div>
      </details>,
    );
    hasContent = true;
  }

  // Prefer rich entity-backed steps (tools / process / approval / artifact).
  // Fall back to legacy ToolPill rail when history has only tool_use parts.
  if (!isUser && useEntitySteps && runId) {
    body.push(<InlineRuntimeSteps key="runtime-steps" runId={runId} />);
    hasContent = true;
  } else if (!isUser) {
    const tools = parts.filter((p) => p.type === 'tool_use') as ToolUsePart[];
    if (tools.length) {
      body.push(
        <div key="tools" className="bubble-tools runtime-steps-fallback">
          {tools.map((p, i) => (
            <ToolPill key={`tool-${i}`} part={p} />
          ))}
        </div>,
      );
      hasContent = true;
    }
  }

  parts.forEach((p: ContentPart, i) => {
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
    } else if (p.type === 'tool_use' && isUser) {
      body.push(<ToolPill key={`tool-${i}`} part={p as ToolUsePart} />);
      body.push(' ');
      hasContent = true;
    }
  });

  if (isUser && visibleAttachments.length) {
    body.push(
      <AttachmentCards
        key="message-attachments"
        attachments={visibleAttachments}
      />,
    );
    hasContent = true;
  }

  if (msg._fileLinks) {
    for (const fl of msg._fileLinks) {
      body.push(
        <SafeDownloadLink
          key={`fl-${fl.url}-${fl.name}`}
          url={fl.url}
          name={fl.name || 'file'}
        />,
      );
      hasContent = true;
    }
  }

  // Assistant turns that only exist as entity steps (no text yet) should still render.
  if (!hasContent && !isUser && useEntitySteps && runId) {
    body.push(<InlineRuntimeSteps key="runtime-steps-empty" runId={runId} />);
    hasContent = true;
  }

  return (
    <div
      className={`mw ${role}`}
      style={{ animationDelay: `${Math.min(idx, 8) * 30}ms` }}
    >
      <div className="body">
        {!isUser ? (
          <div className="msg-role-label" aria-hidden="true">
            UPRC
          </div>
        ) : null}
        <div className={`bubble${isUser ? '' : ' bubble-md'}`}>
          {hasContent ? body : <em className="bubble-empty">(empty)</em>}
          {!isUser && interrupted ? (
            <>
              {' '}
              <span
                className="msg-status msg-status-interrupted"
                role="status"
              >
                interrupted
              </span>
            </>
          ) : null}
        </div>
        <div className="time">{formatTime(msg.createdAt)}</div>
      </div>
    </div>
  );
}
