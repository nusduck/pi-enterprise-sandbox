/**
 * State management — single source of truth for the chat UI.
 *
 * Stream lifecycle uses streamGeneration so late SSE events from an
 * aborted/switched conversation are ignored by the orchestrator.
 */
/** Attachment draft statuses (composer, pre-send). */
export const ATTACHMENT_STATUSES = Object.freeze([
  'queued',
  'uploading',
  'uploaded',
  'failed',
  'removed',
]);

/** Defaults aligned with parent task P-00F1. */
export const ATTACHMENT_LIMITS = Object.freeze({
  maxCount: 10,
  maxFileBytes: 50 * 1024 * 1024,
  maxTurnBytes: 200 * 1024 * 1024,
});

/**
 * Client-side extension allowlist (mirrors sandbox attachment_manager).
 * Server remains authoritative; this is layered UX/pre-check only.
 */
const _ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.xml',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log', '.env',
  '.py', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.java', '.go', '.rs',
  '.rb', '.php', '.c', '.h', '.cpp', '.cc', '.hpp', '.cs', '.swift', '.kt',
  '.scala', '.sh', '.bash', '.zsh', '.ps1', '.sql', '.r', '.m', '.mm',
  '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte', '.lua',
  '.pl', '.pm', '.ex', '.exs', '.erl', '.hs', '.clj', '.dockerfile',
  '.ipynb', '.graphql', '.gql', '.proto', '.tf', '.hcl',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
  '.tif', '.tiff',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp', '.rtf', '.epub',
  // archives stored as-is (never auto-extracted)
  '.zip', '.tar', '.gz', '.tgz', '.tar.gz',
]);

const _COMPOUND_SUFFIXES = ['.tar.gz', '.tar.bz2', '.tar.xz'];

/** @param {string} filename */
export function extensionOf(filename) {
  const lower = String(filename || '').toLowerCase().trim();
  for (const compound of _COMPOUND_SUFFIXES) {
    if (lower.endsWith(compound)) return compound;
  }
  const i = lower.lastIndexOf('.');
  return i >= 0 ? lower.slice(i) : '';
}

/** @param {string} filename */
export function isAllowedAttachmentName(filename) {
  const ext = extensionOf(filename);
  return Boolean(ext) && _ALLOWED_EXTENSIONS.has(ext);
}

export const INITIAL = Object.freeze({
  messages: [],
  isStreaming: false,
  abortCtrl: null,
  currentMsg: null,
  sessionId: null,
  conversationId: null,
  readyFiles: new Set(),
  pendingTool: null, // {id, name, args}
  pendingApproval: null, // {id, reason} when an approval banner is active
  // Conversation sidebar + deliverables
  conversations: [],
  artifacts: [],
  /** Composer attachment drafts (not yet sent with a user turn). */
  attachments: [],
  traceId: null,
  sidebarOpen: true,
  /** Monotonic generation; bumped on stream start / abort / conversation switch. */
  streamGeneration: 0,
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
    attachments: [...(initial.attachments || [])],
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
  if (patch.attachments !== undefined) {
    next.attachments = [...patch.attachments];
  }
  const changes = {};
  for (const k of Object.keys(patch)) {
    if (prev[k] !== next[k]) changes[k] = { prev: prev[k], next: next[k] };
  }
  if (Object.keys(changes).length) notify(changes);
  return next;
}

// ── Attachment draft state machine ──────────────

let _attachmentSeq = 0;

/**
 * Create a new attachment draft (queued). Same display names are independent.
 * @param {File|Blob} file
 * @param {{ localId?: string, idempotencyKey?: string }} [opts]
 */
export function createAttachmentDraft(file, opts = {}) {
  _attachmentSeq += 1;
  const name = file?.name || 'upload';
  const size = typeof file?.size === 'number' ? file.size : 0;
  return {
    localId: opts.localId || `local_${Date.now()}_${_attachmentSeq}`,
    status: 'queued',
    name,
    size,
    mimeType: file?.type || '',
    file: file || null,
    attachmentId: null,
    path: null,
    idempotencyKey: opts.idempotencyKey || `idem_${Date.now()}_${_attachmentSeq}_${Math.random().toString(36).slice(2, 10)}`,
    error: null,
    errorCode: null,
    traceId: null,
    progress: 0,
    /** @type {AbortController|null} in-flight upload controller */
    abortCtrl: null,
  };
}

/** Active (non-removed) drafts. */
export function activeAttachments(attachments) {
  return (attachments || []).filter((a) => a && a.status !== 'removed');
}

/**
 * Whether the composer may send: no uploading/queued/failed drafts remain.
 * Empty attachment list is allowed (text-only send).
 * @param {object[]} attachments
 */
export function canSendAttachments(attachments) {
  const active = activeAttachments(attachments);
  for (const a of active) {
    if (a.status === 'queued' || a.status === 'uploading' || a.status === 'failed') {
      return false;
    }
  }
  return true;
}

/** True when any non-removed draft is mid-upload. */
export function hasUploadingAttachments(attachments) {
  return activeAttachments(attachments).some(
    (a) => a.status === 'queued' || a.status === 'uploading',
  );
}

/** Uploaded drafts ready for the next user turn. */
export function uploadedAttachments(attachments) {
  return activeAttachments(attachments).filter((a) => a.status === 'uploaded' && a.path);
}

/**
 * Patch a single draft by localId. Returns new attachments array.
 * @param {object[]} attachments
 * @param {string} localId
 * @param {object} patch
 */
export function patchAttachment(attachments, localId, patch) {
  return (attachments || []).map((a) =>
    a.localId === localId ? { ...a, ...patch } : a,
  );
}

/**
 * Mark draft removed (soft). Aborts any in-flight upload; does not dedupe by name.
 * @param {object[]} attachments
 * @param {string} localId
 */
export function removeAttachment(attachments, localId) {
  const list = attachments || [];
  const target = list.find((a) => a.localId === localId);
  if (target?.abortCtrl) {
    try {
      target.abortCtrl.abort();
    } catch { /* ignore */ }
  }
  return patchAttachment(list, localId, {
    status: 'removed',
    file: null,
    error: null,
    abortCtrl: null,
  });
}

/**
 * Validate adding files against count/size limits.
 * @param {object[]} existing
 * @param {File[]} files
 * @param {typeof ATTACHMENT_LIMITS} [limits]
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function validateNewAttachments(existing, files, limits = ATTACHMENT_LIMITS) {
  const active = activeAttachments(existing);
  const incoming = Array.from(files || []);
  if (active.length + incoming.length > limits.maxCount) {
    return {
      ok: false,
      code: 'turn_attachment_limit',
      message: `At most ${limits.maxCount} attachments per turn`,
    };
  }
  let turnBytes = active.reduce((s, a) => s + (a.size || 0), 0);
  for (const f of incoming) {
    const name = f?.name || 'upload';
    if (!isAllowedAttachmentName(name)) {
      const ext = extensionOf(name) || '(none)';
      return {
        ok: false,
        code: 'attachment_type_denied',
        message: `File type not allowed: ${ext}`,
      };
    }
    const size = f?.size || 0;
    if (size > limits.maxFileBytes) {
      return {
        ok: false,
        code: 'attachment_too_large',
        message: `"${name}" exceeds ${Math.round(limits.maxFileBytes / (1024 * 1024))}MB limit`,
      };
    }
    turnBytes += size;
  }
  if (turnBytes > limits.maxTurnBytes) {
    return {
      ok: false,
      code: 'turn_attachment_limit',
      message: `Total attachment size exceeds ${Math.round(limits.maxTurnBytes / (1024 * 1024))}MB per turn`,
    };
  }
  return { ok: true };
}

/**
 * Build user message content + attachment manifest for send.
 * Injects logical paths so the agent can read files without a separate channel.
 * @param {string} text
 * @param {object[]} attachments uploaded drafts
 */
export function buildUserTurnWithAttachments(text, attachments) {
  const uploaded = uploadedAttachments(attachments);
  const trimmed = (text || '').trim();
  const manifest = uploaded.map((a) => ({
    attachment_id: a.attachmentId,
    path: a.path,
    name: a.name,
    size: a.size,
  }));

  let body = trimmed;
  if (manifest.length) {
    const lines = manifest.map((m) => `- ${m.name} → ${m.path}`).join('\n');
    body = body
      ? `${body}\n\n[Attachments]\n${lines}`
      : `[Attachments]\n${lines}`;
  }

  return {
    role: 'user',
    content: [{ type: 'text', text: body }],
    attachments: manifest,
  };
}

// ── Explicit stream / conversation transitions ──

function _abortController(ctrl) {
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
 *
 * @param {object} state
 * @param {{ abortCtrl?: AbortController, currentMsg?: object }} [opts]
 */
export function startStream(state, opts = {}) {
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
 * @param {object} state
 * @param {object} [patch] extra fields (e.g. messages)
 */
export function endStream(state, patch = {}) {
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
 * @param {object} state
 * @param {object} [patch]
 */
export function abortStream(state, patch = {}) {
  _abortController(state.abortCtrl);
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
 * @param {object} state
 * @param {object} [patch]
 */
export function errorStream(state, patch = {}) {
  return update(state, {
    isStreaming: false,
    abortCtrl: null,
    pendingTool: null,
    ...patch,
  });
}

/**
 * Clear ephemeral UI state (tokens mid-stream, tools, approvals, artifacts).
 * Used when resetting context without necessarily changing conversationId.
 * @param {object} state
 * @param {object} [patch]
 */
export function clearEphemeral(state, patch = {}) {
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
 *
 * @param {object} state
 * @param {{ conversationId?: string|null, messages?: object[], sessionId?: string|null, sidebarOpen?: boolean }} [opts]
 */
export function switchConversation(state, opts = {}) {
  _abortController(state.abortCtrl);
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
 * @param {object} state
 * @param {number} generation
 */
export function isActiveGeneration(state, generation) {
  return (state.streamGeneration || 0) === generation;
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
      const out = {
        role: m.role,
        content: [{ type: 'text', text }],
      };
      // Preserve interrupted status from server dual-write / recovery
      if (m.interrupted === true || m.status === 'interrupted') {
        out.interrupted = true;
        out.status = 'interrupted';
      }
      if (m.stopReason) out.stopReason = m.stopReason;
      return out;
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
