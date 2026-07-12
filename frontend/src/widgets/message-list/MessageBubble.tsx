import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
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

function formatTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
      if (isUser) {
        // User text stays plain (preserve exact input, including newlines)
        body.push(
          <span key={`t-${i}`} className="user-plain">
            {p.text}
          </span>,
        );
      } else {
        body.push(<MarkdownBody key={`t-${i}`} text={p.text} />);
      }
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
        <div className="time">{formatTime()}</div>
      </div>
    </div>
  );
}
