import { useEffect, useMemo, useRef } from 'react';
import { useChat } from '../../features/chat/ChatContext';
import { MessageBubble } from './MessageBubble';
import { IconSparkles, IconTerminal, IconCode, IconAlertCircle } from '../../shared/ui/Icons';

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
  const { state, displayMessages, setDraftText } = useChat();
  const ref = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  function handleScroll() {
    const el = ref.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distance < 120;
  }

  useEffect(() => {
    isNearBottomRef.current = true;
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

  function selectStarter(prompt: string) {
    setDraftText(prompt);
    const textarea = document.getElementById('input') as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.focus();
    }
  }

  return (
    <div
      id="messages"
      className="msgs"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
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
