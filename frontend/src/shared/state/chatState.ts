import type { ChatMessage, ChatState, ConversationSummary } from './types';

export const INITIAL: Readonly<ChatState> = Object.freeze({
  messages: [],
  isStreaming: false,
  abortCtrl: null,
  currentMsg: null,
  sessionId: null,
  conversationId: null,
  readyFiles: new Set<string>(),
  pendingTool: null,
  pendingApproval: null,
  conversations: [],
  artifacts: [],
  attachments: [],
  traceId: null,
  sidebarOpen: true,
  streamGeneration: 0,
  statusLabel: 'Agent Ready',
  statusColor: '#22c55e',
  flashMessage: null,
  authUser: null,
});

/**
 * Create a new state snapshot. Mutations return a copy (immutable-ish).
 */
export function createState(initial: Partial<ChatState> | ChatState = INITIAL): ChatState {
  const base = { ...INITIAL, ...initial };
  return {
    ...base,
    readyFiles: new Set(base.readyFiles || []),
    conversations: [...(base.conversations || [])],
    artifacts: [...(base.artifacts || [])],
    attachments: [...(base.attachments || [])],
    messages: [...(base.messages || [])],
  };
}

type ChangeMap = Record<string, { prev: unknown; next: unknown }>;
type Subscriber = (changes: ChangeMap) => void;

const subscribers: Subscriber[] = [];

export function subscribe(fn: Subscriber): () => void {
  subscribers.push(fn);
  return () => {
    const i = subscribers.indexOf(fn);
    if (i >= 0) subscribers.splice(i, 1);
  };
}

function notify(changes: ChangeMap): void {
  for (const fn of subscribers) fn(changes);
}

/**
 * Apply an atomic state mutation. Returns the new state and notifies subscribers.
 */
export function update(state: ChatState, patch: Partial<ChatState>): ChatState {
  const prev = state;
  const next: ChatState = { ...state, ...patch };
  if (patch.readyFiles !== undefined) {
    next.readyFiles = new Set(patch.readyFiles);
  }
  if (patch.conversations !== undefined) {
    next.conversations = [...patch.conversations];
  }
  if (patch.artifacts !== undefined) {
    next.artifacts = [...patch.artifacts];
  }
  if (patch.attachments !== undefined) {
    next.attachments = [...patch.attachments];
  }
  if (patch.messages !== undefined) {
    next.messages = [...patch.messages];
  }
  const changes: ChangeMap = {};
  for (const k of Object.keys(patch) as (keyof ChatState)[]) {
    if (prev[k] !== next[k]) {
      changes[k as string] = { prev: prev[k], next: next[k] };
    }
  }
  if (Object.keys(changes).length) notify(changes);
  return next;
}

// ── Explicit stream / conversation transitions ──

function abortController(ctrl: AbortController | null | undefined): void {
  if (!ctrl) return;
  try {
    ctrl.abort();
  } catch {
    /* ignore */
  }
}

/**
 * Begin a streaming response. Bumps streamGeneration and clears ephemeral
 * tool/approval/file state from any previous turn.
 */
export function startStream(
  state: ChatState,
  opts: { abortCtrl?: AbortController; currentMsg?: ChatMessage } = {},
): ChatState {
  const abortCtrl = opts.abortCtrl || new AbortController();
  const currentMsg = opts.currentMsg || {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
  };
  return update(state, {
    isStreaming: true,
    abortCtrl,
    currentMsg,
    readyFiles: new Set(),
    pendingTool: null,
    pendingApproval: null,
    streamGeneration: (state.streamGeneration || 0) + 1,
  });
}

/**
 * End a stream successfully (or after finalize). Clears streaming flags.
 */
export function endStream(state: ChatState, patch: Partial<ChatState> = {}): ChatState {
  return update(state, {
    isStreaming: false,
    abortCtrl: null,
    currentMsg: null,
    pendingTool: null,
    ...patch,
  });
}

/**
 * Abort the active stream. Bumps generation so late SSE events are ignored.
 * Does not drop currentMsg — caller decides whether to keep partial text.
 */
export function abortStream(state: ChatState, patch: Partial<ChatState> = {}): ChatState {
  abortController(state.abortCtrl);
  return update(state, {
    isStreaming: false,
    abortCtrl: null,
    pendingTool: null,
    pendingApproval: null,
    streamGeneration: (state.streamGeneration || 0) + 1,
    ...patch,
  });
}

/**
 * Record a stream-level error. Clears streaming flags; keeps currentMsg for
 * the caller to append error text if desired.
 */
export function errorStream(state: ChatState, patch: Partial<ChatState> = {}): ChatState {
  return update(state, {
    isStreaming: false,
    abortCtrl: null,
    pendingTool: null,
    ...patch,
  });
}

/**
 * Clear ephemeral UI state (tokens mid-stream, tools, approvals, artifacts).
 */
export function clearEphemeral(state: ChatState, patch: Partial<ChatState> = {}): ChatState {
  return update(state, {
    currentMsg: null,
    pendingTool: null,
    pendingApproval: null,
    readyFiles: new Set(),
    artifacts: [],
    traceId: null,
    ...patch,
  });
}

/**
 * Switch to another conversation (or blank). Aborts any active stream,
 * bumps generation, and clears tokens/approvals/artifacts from the previous id.
 */
export function switchConversation(
  state: ChatState,
  opts: {
    conversationId?: string | null;
    messages?: ChatMessage[];
    sessionId?: string | null;
    sidebarOpen?: boolean;
  } = {},
): ChatState {
  abortController(state.abortCtrl);
  return update(state, {
    conversationId: opts.conversationId !== undefined ? opts.conversationId : null,
    messages: opts.messages !== undefined ? opts.messages : [],
    sessionId: opts.sessionId !== undefined ? opts.sessionId : null,
    isStreaming: false,
    abortCtrl: null,
    currentMsg: null,
    readyFiles: new Set(),
    artifacts: [],
    attachments: [],
    pendingTool: null,
    pendingApproval: null,
    traceId: null,
    streamGeneration: (state.streamGeneration || 0) + 1,
    ...(opts.sidebarOpen !== undefined ? { sidebarOpen: opts.sidebarOpen } : {}),
  });
}

/**
 * True if an SSE handler should still apply events for this generation.
 */
export function isActiveGeneration(state: ChatState, generation: number): boolean {
  return (state.streamGeneration || 0) === generation;
}

/**
 * UI preference LocalStorage only (ADR 0003 §4.3 / Phase 6):
 * - recent conversation id
 * - sidebar open preference
 *
 * Message bodies are NEVER restored from LocalStorage — server history is
 * the sole source of truth after refresh.
 */

const PREF_CONVERSATION_ID = 'sandbox_conversation_id';
const PREF_SIDEBAR_OPEN = 'sandbox_ui_sidebar_open';
/** Legacy key — cleared on write so old installs do not rehydrate messages. */
const LEGACY_MESSAGES_KEY = 'sandbox_messages';

function scrubLegacyMessageCache(): void {
  try {
    localStorage.removeItem(LEGACY_MESSAGES_KEY);
  } catch {
    /* ignore */
  }
}

/** Persist last-focused conversation (UI preference, not message cache). */
export function persistConversationId(conversationId: string | null | undefined): void {
  scrubLegacyMessageCache();
  try {
    if (conversationId) {
      localStorage.setItem(PREF_CONVERSATION_ID, conversationId);
    } else {
      localStorage.removeItem(PREF_CONVERSATION_ID);
    }
  } catch {
    /* ignore */
  }
}

export function loadPersistedConversationId(): string | null {
  scrubLegacyMessageCache();
  try {
    return localStorage.getItem(PREF_CONVERSATION_ID) || null;
  } catch {
    return null;
  }
}

/** Persist sidebar open/collapsed preference. */
export function persistSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(PREF_SIDEBAR_OPEN, open ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function loadPersistedSidebarOpen(): boolean | null {
  try {
    const raw = localStorage.getItem(PREF_SIDEBAR_OPEN);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return null;
  } catch {
    return null;
  }
}

/** Clear UI conversation preference and any leftover legacy message cache. */
export function clearPersistedChat(): void {
  try {
    localStorage.removeItem(PREF_CONVERSATION_ID);
    localStorage.removeItem(LEGACY_MESSAGES_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Normalize server conversation messages into UI message shape.
 * Server stores { role, content: string }; UI uses content: [{ type:'text', text }].
 */
export function normalizeServerMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(
      (m): m is Record<string, unknown> =>
        Boolean(m) &&
        ((m as { role?: string }).role === 'user' ||
          (m as { role?: string }).role === 'assistant'),
    )
    .map((m) => {
      let text = '';
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        text = m.content
          .map((p: unknown) =>
            typeof p === 'string'
              ? p
              : (p as { text?: string })?.text || '',
          )
          .filter(Boolean)
          .join('\n');
      }
      const out: ChatMessage = {
        role: m.role as string,
        content: [{ type: 'text', text }],
      };
      // Preserve interrupted status from server dual-write / recovery
      if (m.interrupted === true || m.status === 'interrupted') {
        out.interrupted = true;
        out.status = 'interrupted';
      }
      if (m.stopReason) out.stopReason = String(m.stopReason);
      return out;
    });
}

/** True when an assistant message should show the interrupted badge. */
export function isInterruptedMessage(msg: ChatMessage | null | undefined): boolean {
  if (!msg || msg.role === 'user') return false;
  return (
    msg.interrupted === true ||
    msg.status === 'interrupted' ||
    msg.stopReason === 'aborted' ||
    msg.stopReason === 'interrupted'
  );
}

/**
 * Title helper for sidebar entries.
 */
export function conversationTitle(conv: ConversationSummary | null | undefined): string {
  if (!conv) return 'Chat';
  if (conv.title && conv.title !== 'New chat' && conv.title !== 'New conversation') {
    return conv.title;
  }
  const msgs = conv.messages || [];
  const firstUser = msgs.find((m) => m.role === 'user');
  if (firstUser) {
    const t =
      typeof firstUser.content === 'string'
        ? firstUser.content
        : Array.isArray(firstUser.content)
          ? firstUser.content
              .map((p) => (typeof p === 'object' && p && 'text' in p ? String((p as { text?: string }).text || '') : ''))
              .join('')
          : '';
    const trimmed = (t || '').trim().replace(/\s+/g, ' ');
    if (trimmed) return trimmed.length > 40 ? trimmed.slice(0, 40) + '…' : trimmed;
  }
  return conv.title || 'New chat';
}
