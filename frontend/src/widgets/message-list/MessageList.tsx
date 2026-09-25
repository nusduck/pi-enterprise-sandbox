import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import { MessageBubble } from './MessageBubble';
import {
  lastAssistantIndex,
  findRegenerateSource,
  shouldShowJumpToBottom,
} from './messageActions';
import { runHasTurnEntities } from '../turn-stream/TurnStream';
import { isTerminalRunStatus } from '../../entities';
import { IconChevronDown } from '../../shared/ui/Icons';
import s from './messageList.module.css';

export function MessageList() {
  const { state, displayMessages, sendMessage, entityStore, activeRunId, activeSessionId } = useChat();
  const ref = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  function handleScroll() {
    const el = ref.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distance < 120;
    setShowJumpToBottom(
      shouldShowJumpToBottom(distance, {
        hasMessages: displayMessages.length > 0,
      }),
    );
  }

  function scrollToBottom() {
    const el = ref.current;
    if (!el) return;
    isNearBottomRef.current = true;
    setShowJumpToBottom(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  // Hide the jump button whenever an effect scrolls us back to the bottom.
  useEffect(() => {
    isNearBottomRef.current = true;
    setShowJumpToBottom(false);
    const el = ref.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [state.conversationId]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const lastMsg = displayMessages[displayMessages.length - 1];
    const isUserTurn = lastMsg?.role === 'user';

    if (isNearBottomRef.current || isUserTurn) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
    setShowJumpToBottom((show) =>
      isNearBottomRef.current || displayMessages.length === 0 ? false : show,
    );
  }, [displayMessages]);

  /**
   * One linear turn stream per Run, on the first assistant row of that Run.
   * The stream renders every text segment and tool call of the Run in event
   * order, so any further assistant rows of the same Run are skipped.
   */
  const turnRows = useMemo(() => {
    const first = new Set<number>();
    const skip = new Set<number>();
    const seen = new Set<string>();
    displayMessages.forEach((msg, idx) => {
      if (msg.role !== 'assistant' || !msg._runId) return;
      const key = String(msg._runId);
      if (seen.has(key)) {
        if (runHasTurnEntities(entityStore, key)) skip.add(idx);
        return;
      }
      seen.add(key);
      if (runHasTurnEntities(entityStore, key)) first.add(idx);
    });
    return { first, skip };
  }, [displayMessages, entityStore]);

  /** Regenerate is only offered on the last assistant bubble while idle. */
  const regen = useMemo(() => {
    const assistantIdx = lastAssistantIndex(displayMessages);
    if (assistantIdx < 0) {
      return { assistantIdx, source: null as string | null, allowed: false };
    }
    const activeRun = activeRunId ? entityStore.runsById[activeRunId] : null;
    const runBusy = Boolean(
      activeRun && !isTerminalRunStatus(String(activeRun.status)),
    );
    return {
      assistantIdx,
      source: findRegenerateSource(displayMessages, assistantIdx),
      allowed: !state.isStreaming && !runBusy,
    };
  }, [displayMessages, state.isStreaming, entityStore, activeRunId]);

  const handleRegenerate = useCallback(
    (text: string) => void sendMessage(text),
    [sendMessage],
  );

  // aria-live="off" is deliberate: role="log" carries an implicit polite live
  // region, and streaming SSE tokens mutate existing text nodes, so leaving it
  // live makes screen readers re-read the transcript on every delta. Run state
  // is announced by FlashZone (role="status" + aria-live="assertive") instead.
  return (
    <div
      id="messages"
      className="msgs"
      role="log"
      aria-live="off"
      ref={ref}
      onScroll={handleScroll}
    >
      {displayMessages.length === 0 ? (
        <div className={s.welcome}>
          <h2>今天想让智能体做什么？</h2>
          <p>描述任务，或者把文件拖进来。运行过程会在这里逐步展示。</p>
          <p className={s.keys}>
            <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行 · <kbd>⌘U</kbd> 添加文件 · <kbd>⌘L</kbd> 新建会话
          </p>
        </div>
      ) : (
        displayMessages.map((msg, idx) => {
          if (turnRows.skip.has(idx)) return null;
          const canRegenerate =
            regen.allowed && idx === regen.assistantIdx;
          // Only the regenerating bubble gets the source text: handing it to
          // every bubble would break their memo comparator on each new turn.
          const regenerateSource = canRegenerate ? regen.source : null;
          return (
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
              useTurnStream={turnRows.first.has(idx)}
              canRegenerate={canRegenerate}
              regenerateSource={regenerateSource}
              onRegenerate={handleRegenerate}
              sessionId={activeSessionId}
            />
          );
        })
      )}
      {showJumpToBottom ? (
        <button
          type="button"
          className="jump-to-bottom"
          aria-label="Jump to latest messages"
          title="Jump to latest messages"
          onClick={scrollToBottom}
        >
          <IconChevronDown size={16} />
        </button>
      ) : null}
    </div>
  );
}
