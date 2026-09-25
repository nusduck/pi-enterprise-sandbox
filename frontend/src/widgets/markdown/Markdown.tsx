/**
 * Sanitized Markdown rendering shared by the chat transcript and the linear
 * turn stream: GFM, rehype-sanitize, copyable code blocks, and links limited
 * to http(s) and same-origin /api URLs.
 */
import { useState, isValidElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { downloadAttrName, safeApiUrl } from '../../shared/security/url';
import { IconCheck, IconCopy, IconDownload } from '../../shared/ui/Icons';

export function SafeDownloadLink({
  url,
  name,
  path,
  className = 'dl',
}: {
  url: string;
  name: string;
  path?: string;
  className?: string;
}) {
  const safe = safeApiUrl(url);
  if (!safe) return <span>{name}</span>;
  return (
    <a className={className} href={safe} download={downloadAttrName(name, path)}>
      <IconDownload size={14} /> {name}
    </a>
  );
}

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';
  const rawText = String(children).replace(/\n$/, '');

  async function handleCopy() {
    try {
      if (!navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(rawText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="md-code-container">
      <div className="md-code-header">
        <span className="md-code-lang">{language || 'code'}</span>
        <button
          type="button"
          className="md-code-copy"
          onClick={() => void handleCopy()}
          title="Copy code"
        >
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          <span>{copied ? 'Copied!' : 'Copy'}</span>
        </button>
      </div>
      <pre className="md-pre">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export function MarkdownBody({ text }: { text: string }) {
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
            pre: ({ children }) => {
              if (isValidElement(children)) {
                const codeProps = children.props as {
                  className?: string;
                  children?: ReactNode;
                };
                return (
                  <CodeBlock className={codeProps.className}>
                    {codeProps.children}
                  </CodeBlock>
                );
              }
              return <pre className="md-pre">{children}</pre>;
            },
            code: ({ children, ...props }) => {
              return (
                <code className="md-code-inline" {...props}>
                  {children}
                </code>
              );
            },
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
