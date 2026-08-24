import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import { MessageBubble } from './MessageBubble';
import {
  lastAssistantIndex,
  findRegenerateSource,
  shouldShowJumpToBottom,
} from './messageActions';
import { runHasEntitySteps } from '../runtime-steps/InlineRuntimeSteps';
import { isTerminalRunStatus } from '../../entities';
import { IconChevronDown, IconSparkles, IconTerminal, IconCode, IconAlertCircle } from '../../shared/ui/Icons';

const PROMPT_STARTERS = [
  {
    title: 'Analyze Codebase Architecture',
    desc: 'Explore modules, dependencies and data flows across the workspace.',
    prompt: 'Please analyze the codebase architecture, outline the key layers and suggest improvements.',
    icon: <IconCode size={16} />,
  },
  {
    title: 'Run Security & Governance Audit',
    desc: 'Audit policy gates, tool access, high-risk bash commands and approvals.',
    prompt: 'Audit current tool access policies and check if all external commands are properly gated.',
    icon: <IconAlertCircle size={16} />,
  },
  {
    title: 'Inspect Managed Processes',
    desc: 'Check background services, live terminal processes and execution logs.',
    prompt: 'Check active background processes and summarize recent execution outputs.',
    icon: <IconTerminal size={16} />,
  },
  {
    title: 'Generate Dynamic Agent Skill',
    desc: 'Draft and test a specialized Skill ZIP package for this workspace.',
    prompt: 'Help me design and create a specialized Skill package with tools for automated reporting.',
    icon: <IconSparkles size={16} />,
  },
];

export function MessageList() {
  const { state, displayMessages, setDraftText, sendMessage, entityStore, activeRunId } = useChat();
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
   * One step rail per run, on the *first* assistant bubble of that run.
   *
   * The projection normally merges a run into a single bubble, so first and
   * last are the same row. When something splits them anyway — a legacy
   * transcript, or another run's row landing in between — the rail belongs to
   * the top of the turn, where it reads as "here is what I did" before the
   * answer, rather than trailing after it.
   */
  const runtimeStepRunIds = useMemo(() => {
    const firstByRun = new Map<string, number>();
    displayMessages.forEach((msg, idx) => {
      if (msg.role === 'assistant' && msg._runId) {
        const key = String(msg._runId);
        if (!firstByRun.has(key)) firstByRun.set(key, idx);
      }
    });
    return new Set(firstByRun.values());
  }, [displayMessages]);

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

  function selectStarter(prompt: string) {
    setDraftText(prompt);
    const textarea = document.getElementById('input') as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.focus();
    }
  }

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
        <div className="welcome">
          <div className="welcome-hero-badge">
            <div className="welcome-icon">
              <img src="/brand/uprc-icon.png" alt="" width={44} height={44} />
            </div>
            <div className="welcome-hero-tag">
              <IconSparkles size={13} /> Enterprise Agent Workbench
            </div>
          </div>

          <h2 className="welcome-title">What do you want to accomplish?</h2>
          <p className="welcome-subtitle">
            Autonomous execution, policy-gated tools, human-in-the-loop approvals, and audited subagent fleets.
          </p>

          <div className="welcome-starters-grid">
            {PROMPT_STARTERS.map((s) => (
              <button
                key={s.title}
                type="button"
                className="starter-card"
                onClick={() => selectStarter(s.prompt)}
              >
                <div className="starter-card-icon">{s.icon}</div>
                <div className="starter-card-content">
                  <span className="starter-card-title">{s.title}</span>
                  <span className="starter-card-desc">{s.desc}</span>
                </div>
              </button>
            ))}
          </div>

          <p className="welcome-hints">
            <kbd>Enter</kbd> send
            <span className="hint-sep">·</span>
            <kbd>Shift+Enter</kbd> newline
            <span className="hint-sep">·</span>
            <kbd>Ctrl/Cmd+U</kbd> attach
            <span className="hint-sep">·</span>
            <kbd>Ctrl/Cmd+L</kbd> new chat
          </p>
        </div>
      ) : (
        displayMessages.map((msg, idx) => {
          const showRuntimeSteps = runtimeStepRunIds.has(idx);
          const useEntitySteps =
            showRuntimeSteps &&
            msg.role === 'assistant' &&
            Boolean(msg._runId) &&
            runHasEntitySteps(entityStore, msg._runId || null);
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
              showRuntimeSteps={showRuntimeSteps}
              useEntitySteps={useEntitySteps}
              canRegenerate={canRegenerate}
              regenerateSource={regenerateSource}
              onRegenerate={handleRegenerate}
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
