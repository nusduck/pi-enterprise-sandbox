/**
 * State management — single source of truth for the chat UI.
 */
export const INITIAL = Object.freeze({
  messages: [],
  isStreaming: false,
  abortCtrl: null,
  currentMsg: null,
  sessionId: null,
  conversationId: null,
  readyFiles: new Set(),
  pendingTool: null,  // {id, name, args}
  // Conversation sidebar + deliverables
  conversations: [],
  artifacts: [],
  traceId: null,
  sidebarOpen: true,
});

/**
 * Create a new state snapshot. Mutations return a copy (immutable-ish).
 */
export function createState(initial = INITIAL) {
  return {
    ...initial,
    readyFiles: new Set(initial.readyFiles),
    conversations: [...(initial.conversations || [])],
    artifacts: [...(initial.artifacts || [])],
  };
}

/**
 * Writable state fields that trigger UI re-render on change.
 * Each key is a change: (prev, next) => void where prev is the old value.
 */
const subscribers = [];

export function subscribe(fn) {
  subscribers.push(fn);
  return () => {
    const i = subscribers.indexOf(fn);
    if (i >= 0) subscribers.splice(i, 1);
  };
}

function notify(changes) {
  for (const fn of subscribers) fn(changes);
}

/**
 * Apply an atomic state mutation. Returns the new state and notifies subscribers.
 */
export function update(state, patch) {
  const prev = state;
  const next = { ...state, ...patch };
  if (patch.readyFiles !== undefined) {
    next.readyFiles = new Set(patch.readyFiles);
  }
  if (patch.conversations !== undefined) {
    next.conversations = [...patch.conversations];
  }
  if (patch.artifacts !== undefined) {
    next.artifacts = [...patch.artifacts];
  }
  const changes = {};
  for (const k of Object.keys(patch)) {
    if (prev[k] !== next[k]) changes[k] = { prev: prev[k], next: next[k] };
  }
  if (Object.keys(changes).length) notify(changes);
  return next;
}

/**
 * Save current state to localStorage for session persistence.
 */
export function persistMessages(messages) {
  try {
    const trimmed = messages.slice(-50).map(m => ({
      role: m.role,
      content: Array.isArray(m.content)
        ? m.content.filter(p => p.type === 'text').map(p => p.text).join('')
        : (typeof m.content === 'string' ? m.content : ''),
    }));
    localStorage.setItem('sandbox_messages', JSON.stringify(trimmed));
  } catch { /* quota exceeded — ignore */ }
}

export function loadPersistedMessages() {
  try {
    const raw = localStorage.getItem('sandbox_messages');
    if (!raw) return [];
    const msgs = JSON.parse(raw);
    return msgs.filter(m => m.role && m.content != null).map(m => ({
      role: m.role,
      content: [{ type: 'text', text: typeof m.content === 'string' ? m.content : String(m.content) }],
    }));
  } catch {
    return [];
  }
}

export function persistConversationId(conversationId) {
  if (conversationId) {
    localStorage.setItem('sandbox_conversation_id', conversationId);
  } else {
    localStorage.removeItem('sandbox_conversation_id');
  }
}

export function loadPersistedConversationId() {
  try {
    return localStorage.getItem('sandbox_conversation_id') || null;
  } catch {
    return null;
  }
}

export function clearPersistedChat() {
  try {
    localStorage.removeItem('sandbox_messages');
    localStorage.removeItem('sandbox_conversation_id');
  } catch { /* ignore */ }
}

/**
 * Normalize server conversation messages into UI message shape.
 * Server stores { role, content: string }; UI uses content: [{ type:'text', text }].
 */
export function normalizeServerMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .map(m => {
      let text = '';
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        text = m.content
          .map(p => (typeof p === 'string' ? p : p?.text || ''))
          .filter(Boolean)
          .join('\n');
      }
      return {
        role: m.role,
        content: [{ type: 'text', text }],
      };
    });
}

/**
 * Title helper for sidebar entries.
 */
export function conversationTitle(conv) {
  if (!conv) return 'Chat';
  if (conv.title && conv.title !== 'New chat' && conv.title !== 'New conversation') {
    return conv.title;
  }
  const msgs = conv.messages || [];
  const firstUser = msgs.find(m => m.role === 'user');
  if (firstUser) {
    const t = typeof firstUser.content === 'string'
      ? firstUser.content
      : (Array.isArray(firstUser.content)
        ? firstUser.content.map(p => p?.text || '').join('')
        : '');
    const trimmed = (t || '').trim().replace(/\s+/g, ' ');
    if (trimmed) return trimmed.length > 40 ? trimmed.slice(0, 40) + '…' : trimmed;
  }
  return conv.title || 'New chat';
}
