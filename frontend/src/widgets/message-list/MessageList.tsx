import { useEffect, useRef } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import { MessageBubble } from './MessageBubble';

export function MessageList() {
  const { displayMessages } = useChat();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [displayMessages]);

  return (
    <div
      id="messages"
      className="msgs"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      ref={ref}
    >
      {displayMessages.length === 0 ? (
        <div className="welcome">
          <div className="icon">◆</div>
          <h2>Enterprise Sandbox</h2>
          <p>
            AI-powered sandboxed coding environment. Upload files or ask the
            agent to write code.
          </p>
          <p style={{ fontSize: 12, color: '#64748b' }}>
            <kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline ·{' '}
            <kbd>Ctrl+L</kbd> new chat
          </p>
        </div>
      ) : (
        displayMessages.map((msg, idx) => (
          <MessageBubble
            key={`${msg.role}-${idx}-${msg.content?.[0] && 'text' in msg.content[0] ? String(msg.content[0].text).slice(0, 24) : idx}`}
            msg={msg}
            idx={idx}
          />
        ))
      )}
    </div>
  );
}
