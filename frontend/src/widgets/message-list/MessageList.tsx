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
          <div className="icon">
            <img src="/brand/uprc-icon.svg" alt="" width={56} height={56} />
          </div>
          <h2>UPRC Agent</h2>
          <p>
            Risk-control AI agent runtime — policy-gated tools, approvals, and
            audited execution. Upload files or start typing.
          </p>
          <p className="welcome-hints">
            <kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline ·{' '}
            <kbd>Ctrl+L</kbd> new chat
          </p>
        </div>
      ) : (
        displayMessages.map((msg, idx) => (
          <MessageBubble
            key={
              msg._messageId
                ? `${msg.role}-${msg._messageId}`
                : msg._runId
                  ? `${msg.role}-${msg._runId}`
                  : `${msg.role}-${idx}`
            }
            msg={msg}
            idx={idx}
          />
        ))
      )}
    </div>
  );
}
