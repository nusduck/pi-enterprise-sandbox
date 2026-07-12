import type { ReactNode } from 'react';
import type { ChatMessage, ContentPart, ToolUsePart } from '../../shared/state';
import { isInterruptedMessage } from '../../shared/state';
import { safeApiUrl } from '../../shared/security/url';
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

/** Append text, converting known download-markdown patterns into safe links. */
function TextWithSafeLinks({ text }: { text: string }) {
  const re = /📄 \*\*([^*]+)\*\* — \[Download\]\(([^)]+)\)\n?/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    }
    const name = m[1];
    const url = m[2];
    const safe = safeApiUrl(url);
    if (safe) {
      nodes.push(
        <SafeDownloadLink key={key++} url={safe} name={name} />,
      );
    } else {
      nodes.push(<span key={key++}>{m[0]}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    nodes.push(<span key={key++}>{text.slice(last)}</span>);
  }
  return <>{nodes}</>;
}

function formatTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function MessageBubble({
  msg,
  idx,
}: {
  msg: ChatMessage;
  idx: number;
}) {
  const role = msg.role || 'assistant';
  const isUser = role === 'user';
  const interrupted = isInterruptedMessage(msg);
  const parts = msg.content || [];
  let hasContent = false;

  const body: ReactNode[] = [];
  parts.forEach((p: ContentPart, i) => {
    if (p.type === 'text' && 'text' in p && typeof p.text === 'string' && p.text) {
      body.push(
        <span key={`t-${i}`}>
          <TextWithSafeLinks text={p.text} />
          {'\n'}
        </span>,
      );
      hasContent = true;
    } else if (p.type === 'tool_use') {
      body.push(<ToolPill key={`tool-${i}`} part={p as ToolUsePart} />);
      body.push(' ');
      hasContent = true;
    }
  });

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

  return (
    <div
      className={`mw ${role}`}
      style={{ animationDelay: `${idx * 40}ms` }}
    >
      <div className="av" aria-hidden="true">
        {isUser ? '🧑' : '●'}
      </div>
      <div className="body">
        <div className="bubble">
          {hasContent ? body : <em style={{ color: '#64748b' }}>(empty)</em>}
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
        <div className="time">{formatTime()}</div>
      </div>
    </div>
  );
}
