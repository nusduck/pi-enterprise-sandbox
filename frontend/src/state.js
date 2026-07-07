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
});

/**
 * Create a new state snapshot. Mutations return a copy (immutable-ish).
 */
export function createState(initial = INITIAL) {
  return { ...initial, readyFiles: new Set(initial.readyFiles) };
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
      content: m.content.filter(p => p.type === 'text').map(p => p.text).join(''),
    }));
    localStorage.setItem('sandbox_messages', JSON.stringify(trimmed));
  } catch { /* quota exceeded — ignore */ }
}

export function loadPersistedMessages() {
  try {
    const raw = localStorage.getItem('sandbox_messages');
    if (!raw) return [];
    const msgs = JSON.parse(raw);
    return msgs.filter(m => m.role && m.content).map(m => ({
      role: m.role,
      content: [{ type: 'text', text: m.content }],
    }));
  } catch {
    return [];
  }
}

export function persistConversationId(conversationId) {
  if (conversationId) {
    localStorage.setItem('sandbox_conversation_id', conversationId);
  }
}

export function loadPersistedConversationId() {
  try {
    return localStorage.getItem('sandbox_conversation_id') || null;
  } catch {
    return null;
  }
}
