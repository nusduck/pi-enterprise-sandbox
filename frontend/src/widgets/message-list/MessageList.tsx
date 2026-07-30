import { useEffect, useMemo, useRef } from 'react';
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

  /** One step rail per run — attach to the last assistant bubble of that run. */
  const runtimeStepRunIds = useMemo(() => {
    const lastByRun = new Map<string, number>();
    displayMessages.forEach((msg, idx) => {
      if (msg.role === 'assistant' && msg._runId) {
        lastByRun.set(String(msg._runId), idx);
      }
    });
    return new Set(lastByRun.values());
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
            <img src="/brand/uprc-icon.svg" alt="" width={48} height={48} />
          </div>
          <h2>What do you want to run?</h2>
          <p>
            Policy-gated tools, human approvals, and audited execution —
            ready when you are.
          </p>
          <p className="welcome-hints">
            <kbd>Enter</kbd> send
            <span aria-hidden="true">·</span>
            <kbd>Shift+Enter</kbd> newline
            <span aria-hidden="true">·</span>
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
                  ? `${msg.role}-${msg._runId}-${idx}`
                  : `${msg.role}-${idx}`
            }
            msg={msg}
            idx={idx}
            showRuntimeSteps={runtimeStepRunIds.has(idx)}
          />
        ))
      )}
    </div>
  );
}
