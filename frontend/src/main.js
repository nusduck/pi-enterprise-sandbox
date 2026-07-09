/**
 * Pi Enterprise Sandbox — Frontend Entry Point
 *
 * Architecture: Vanilla JS SPA consuming SSE events from api-server.
 * No agent code runs in the browser — all LLM/tool logic is server-side.
 */
import {
  INITIAL,
  createState,
  update,
  subscribe,
  persistMessages,
  loadPersistedMessages,
  persistConversationId,
  loadPersistedConversationId,
  clearPersistedChat,
  normalizeServerMessages,
} from './state.js';
import {
  sendChatMessage,
  uploadFile,
  getDownloadUrl,
  getArtifactDownloadUrl,
  listConversations,
  getConversation,
  deleteConversation,
  listArtifacts,
  decideApproval,
} from './api.js';
import {
  initDOM,
  dom,
  render,
  renderMessagesFull,
  renderConversationList,
  renderDeliverables,
  applySidebarLayout,
  incBubble,
  rerenderLast,
  setStatus,
  flashError,
  showWelcome,
} from './render.js';

// ── Init DOM references ─────────────────────────
initDOM({
  msgs: document.getElementById('messages'),
  input: document.getElementById('input'),
  send: document.getElementById('btn-send'),
  upload: document.getElementById('btn-upload'),
  dropzone: document.getElementById('dropzone'),
  status: document.getElementById('status-label'),
  flash: document.getElementById('flash-zone'),
  sidebar: document.getElementById('sidebar'),
  sidebarBackdrop: document.getElementById('sidebar-backdrop'),
  conversationList: document.getElementById('conversation-list'),
  deliverables: document.getElementById('deliverables'),
  deliverablesList: document.getElementById('deliverables-list'),
  deliverablesCount: document.getElementById('deliverables-count'),
  btnNewChat: document.getElementById('btn-new-chat'),
  btnSidebarToggle: document.getElementById('btn-sidebar-toggle'),
  btnSidebarClose: document.getElementById('btn-sidebar-close'),
});

// ── State ───────────────────────────────────────
const isMobileBoot = window.matchMedia('(max-width: 768px)').matches;
let state = createState({
  ...INITIAL,
  sidebarOpen: !isMobileBoot,
});

// Re-render messages + chrome on state changes
subscribe((changes) => {
  // Conversation switch/new-chat rebuild the message list explicitly via renderMessagesFull.
  // Avoid incremental render when conversationId changes (wrong DOM reuse).
  if (
    (changes.messages || changes.currentMsg || changes.isStreaming) &&
    !changes.conversationId
  ) {
    render(state);
  }
  if (changes.conversations || changes.conversationId) {
    renderConversationList(state, { onSelect: selectConversation, onDelete: removeConversation });
  }
  if (changes.artifacts || changes.sessionId) {
    renderDeliverables(state);
  }
  if (changes.sidebarOpen) {
    applySidebarLayout(state);
  }
});

// ── Conversations / artifacts helpers ───────────

async function refreshConversations() {
  try {
    const list = await listConversations();
    state = update(state, { conversations: Array.isArray(list) ? list : [] });
  } catch (err) {
    console.warn('[conv] list failed:', err.message);
  }
}

async function refreshArtifacts(sessionId) {
  const sid = sessionId || state.sessionId;
  if (!sid) {
    state = update(state, { artifacts: [] });
    return;
  }
  try {
    const data = await listArtifacts(sid);
    const artifacts = Array.isArray(data) ? data : (data.artifacts || []);
    state = update(state, { artifacts });
  } catch (err) {
    console.warn('[artifacts] list failed:', err.message);
  }
}

/**
 * Switch to an existing conversation — load messages from server.
 */
async function selectConversation(id) {
  if (!id || id === state.conversationId) {
    // On mobile, still close sidebar when re-tapping active
    if (window.matchMedia('(max-width: 768px)').matches) {
      state = update(state, { sidebarOpen: false });
    }
    return;
  }
  if (state.isStreaming) {
    flashError('Wait for the current response to finish');
    return;
  }

  try {
    setStatus('Loading…', '#94a3b8');
    const conv = await getConversation(id);
    const messages = normalizeServerMessages(conv.messages);
    const sessionId = conv.sandbox_session_id || null;

    state = update(state, {
      conversationId: conv.id,
      messages,
      currentMsg: null,
      sessionId,
      readyFiles: new Set(),
      artifacts: [],
      pendingTool: null,
      traceId: null,
    });
    persistConversationId(conv.id);
    persistMessages(messages);
    renderMessagesFull(state);
    renderConversationList(state, { onSelect: selectConversation, onDelete: removeConversation });

    if (window.matchMedia('(max-width: 768px)').matches) {
      state = update(state, { sidebarOpen: false });
    }

    if (sessionId) {
      await refreshArtifacts(sessionId);
      setStatus(`Session ${sessionId.slice(-8)}`);
    } else {
      setStatus('Agent Ready');
    }
  } catch (err) {
    console.error('[conv] select failed:', err);
    flashError(`Failed to load conversation: ${err.message}`);
    setStatus('Agent Ready');
  }
}

/**
 * Start a blank chat (clears conversationId so next send creates new).
 */
async function startNewChat() {
  if (state.isStreaming) {
    flashError('Wait for the current response to finish');
    return;
  }
  state = update(state, {
    messages: [],
    sessionId: null,
    conversationId: null,
    readyFiles: new Set(),
    currentMsg: null,
    artifacts: [],
    pendingTool: null,
    traceId: null,
  });
  clearPersistedChat();
  renderMessagesFull(state);
  renderConversationList(state, { onSelect: selectConversation, onDelete: removeConversation });
  renderDeliverables(state);
  setStatus('Agent Ready');
  dom.input?.focus();

  if (window.matchMedia('(max-width: 768px)').matches) {
    state = update(state, { sidebarOpen: false });
  }
}

/**
 * Delete a conversation (server + local if active).
 */
async function removeConversation(id) {
  if (!id) return;
  if (state.isStreaming && id === state.conversationId) {
    flashError('Cannot delete while streaming');
    return;
  }
  if (!confirm('Delete this conversation? Workspace and linked session may be cleaned up.')) {
    return;
  }
  try {
    await deleteConversation(id);
    const remaining = (state.conversations || []).filter(c => c.id !== id);
    state = update(state, { conversations: remaining });

    if (state.conversationId === id) {
      await startNewChat();
    } else {
      renderConversationList(state, { onSelect: selectConversation, onDelete: removeConversation });
    }
  } catch (err) {
    console.error('[conv] delete failed:', err);
    flashError(`Delete failed: ${err.message}`);
  }
}

// ── SSE event handler ───────────────────────────

function handleSSE(ev) {
  switch (ev.type) {
    case 'trace':
      if (ev.trace_id) {
        state = update(state, { traceId: ev.trace_id });
      }
      break;

    case 'session':
      state = update(state, { sessionId: ev.session_id });
      if (ev.conversation_id) {
        state = update(state, { conversationId: ev.conversation_id });
        persistConversationId(ev.conversation_id);
      }
      if (ev.trace_id) {
        state = update(state, { traceId: ev.trace_id });
      }
      setStatus(`Session ${ev.session_id.slice(-8)}`);
      // Refresh artifacts for this session (reuse may already have deliverables)
      refreshArtifacts(ev.session_id);
      break;

    case 'token':
      if (!state.currentMsg) break;
      {
        const parts = state.currentMsg.content;
        const last = parts[parts.length - 1];
        if (last && last.type === 'text') {
          last.text += ev.text;
        } else {
          parts.push({ type: 'text', text: ev.text });
        }
        incBubble(state);
      }
      break;

    case 'tool_start':
      if (!state.currentMsg) break;
      state.currentMsg.content.push({
        type: 'tool_use', name: ev.name || 'tool',
        input: ev.args || {}, status: 'running',
      });
      state = update(state, { pendingTool: { id: ev.id, name: ev.name, args: ev.args } });
      rerenderLast(state);
      break;

    case 'tool_end': {
      if (!state.currentMsg) break;
      for (let i = state.currentMsg.content.length - 1; i >= 0; i--) {
        const p = state.currentMsg.content[i];
        if (p.type === 'tool_use' && p.status === 'running') {
          p.status = 'complete';
          p.isError = ev.isError;
          p.result = ev.result;
          break;
        }
      }
      state = update(state, { pendingTool: null });
      rerenderLast(state);
      break;
    }

    case 'file_ready': {
      // P7: prefer artifact_id for deliverable downloads; path-only is legacy fallback
      const dedupeKey = ev.artifact_id || ev.path;
      if (!state.sessionId || !dedupeKey || state.readyFiles.has(dedupeKey)) break;
      if (!ev.artifact_id && !ev.path) break;

      const readyFiles = new Set(state.readyFiles);
      readyFiles.add(dedupeKey);
      state = update(state, { readyFiles });

      const name = ev.name || (ev.path ? ev.path.split('/').pop() : ev.artifact_id);
      let url = null;
      if (ev.artifact_id) {
        url = getArtifactDownloadUrl(state.sessionId, ev.artifact_id);
      } else if (ev.path) {
        // Graceful fallback only if backend omitted artifact_id
        url = getDownloadUrl(state.sessionId, ev.path);
      }
      if (!url || !state.currentMsg) break;

      if (!state.currentMsg._fileLinks) state.currentMsg._fileLinks = [];
      state.currentMsg._fileLinks.push({
        name,
        url,
        path: ev.path,
        artifact_id: ev.artifact_id,
        mime_type: ev.mime_type,
        size: ev.size,
      });
      rerenderLast(state);
      // Keep deliverables panel in sync
      refreshArtifacts(state.sessionId);
      break;
    }

    case 'approval_required': {
      // Optional wire — show approve/reject banner if sandbox emits approval events
      const approvalId = ev.approval_id || ev.id;
      if (!approvalId || !dom.flash) break;
      const banner = document.createElement('div');
      banner.className = 'approval-banner';
      banner.innerHTML = `
        <span>⚠ Approval required: ${escText(ev.reason || ev.command || approvalId)}</span>
        <button type="button" class="btn-approve">Approve</button>
        <button type="button" class="btn-reject">Reject</button>
      `;
      banner.querySelector('.btn-approve')?.addEventListener('click', async () => {
        try {
          await decideApproval(approvalId, 'approve');
          banner.remove();
          setStatus('Approved', '#22c55e');
        } catch (err) {
          flashError(err.message);
        }
      });
      banner.querySelector('.btn-reject')?.addEventListener('click', async () => {
        try {
          await decideApproval(approvalId, 'reject');
          banner.remove();
          setStatus('Rejected', '#ef4444');
        } catch (err) {
          flashError(err.message);
        }
      });
      dom.flash.appendChild(banner);
      break;
    }

    case 'error':
      if (state.currentMsg) {
        state.currentMsg.content.push({ type: 'text', text: `\n[Error: ${ev.message || ev.text}]` });
        rerenderLast(state);
      }
      flashError(ev.message || ev.text || 'Unknown error');
      break;

    case 'done':
      // Finalize — handled in sendMessage finally block
      break;

    case 'session_closed':
      setStatus('Session ended', '#64748b');
      break;
  }
}

function escText(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// ── Send message ────────────────────────────────

async function sendMessage(text) {
  if (state.isStreaming || !text.trim()) return;

  // Add user message to state immediately so it renders
  const userMsg = {
    role: 'user',
    content: [{ type: 'text', text: text.trim() }],
  };
  state = update(state, { messages: [...state.messages, userMsg] });

  // Prepare streaming
  state = update(state, {
    abortCtrl: new AbortController(),
    isStreaming: true,
    currentMsg: { role: 'assistant', content: [{ type: 'text', text: '' }] },
    readyFiles: new Set(),
    pendingTool: null,
  });
  render(state);

  try {
    // Send full message history (state already includes the user msg)
    await sendChatMessage(state.messages, handleSSE, state.abortCtrl.signal, state.conversationId);

    // Finalize: append assistant response to messages
    if (state.currentMsg) {
      const newMessages = [...state.messages, state.currentMsg];
      state = update(state, { messages: newMessages, currentMsg: null });
    }
    render(state);
    persistMessages(state.messages);
    // Conversation list may now include a newly created conversation
    await refreshConversations();
    await refreshArtifacts(state.sessionId);
  } catch (err) {
    if (err.name === 'AbortError') {
      // User cancelled — keep partial message
      if (state.currentMsg) {
        state.currentMsg.stopReason = 'aborted';
        const messages = [...state.messages, state.currentMsg];
        state = update(state, { messages, currentMsg: null });
      }
      render(state);
      return;
    }
    console.error('[chat] Error:', err);
    flashError(`Connection error: ${err.message}`);
    if (state.currentMsg) {
      state.currentMsg.content.push({ type: 'text', text: `\n[Connection error: ${err.message}]` });
      const messages = [...state.messages, state.currentMsg];
      state = update(state, { messages, currentMsg: null });
    }
    render(state);
  } finally {
    state = update(state, { isStreaming: false, abortCtrl: null });
    dom.input.disabled = false;
    dom.input.focus();
  }
}

function cancelStream() {
  if (state.abortCtrl) state.abortCtrl.abort();
}

// ── File upload ─────────────────────────────────

async function handleUpload(file) {
  if (!state.sessionId) {
    flashError('Send a message first to create a session');
    return;
  }

  const messages = [
    ...state.messages,
    {
      role: 'user',
      content: [{ type: 'text', text: `📎 Uploaded: **${file.name}** (${(file.size / 1024).toFixed(1)} KB)` }],
    },
  ];
  state = update(state, { messages });
  render(state);

  try {
    await uploadFile(state.sessionId, file, state.abortCtrl?.signal);
    // Auto-send follow-up to analyze
    dom.input.value = `I uploaded ${file.name}. Please analyze this file.`;
    sendMessage(dom.input.value);
    dom.input.value = '';
    dom.input.style.height = 'auto';
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[upload] Error:', err);
    flashError(`Upload error: ${err.message}`);
  }
}

// ── Boot: load conversation list + prefer server history ──

async function bootConversations() {
  await refreshConversations();

  const savedConvId = loadPersistedConversationId();
  if (savedConvId) {
    try {
      const conv = await getConversation(savedConvId);
      const messages = normalizeServerMessages(conv.messages);
      // Prefer server history when present; fall back to localStorage
      const useMessages = messages.length ? messages : loadPersistedMessages();
      state = update(state, {
        conversationId: conv.id,
        messages: useMessages,
        sessionId: conv.sandbox_session_id || null,
      });
      persistConversationId(conv.id);
      if (useMessages.length) persistMessages(useMessages);
      renderMessagesFull(state);
      if (conv.sandbox_session_id) {
        await refreshArtifacts(conv.sandbox_session_id);
        setStatus(`Session ${conv.sandbox_session_id.slice(-8)}`);
      }
      return;
    } catch {
      // Stale local conversation id — clear and show local cache if any
      clearPersistedChat();
    }
  }

  const local = loadPersistedMessages();
  if (local.length) {
    state = update(state, { messages: local });
  }
  renderMessagesFull(state);
}

// ── Init ────────────────────────────────────────

function init() {
  applySidebarLayout(state);
  renderMessagesFull(state);
  renderConversationList(state, { onSelect: selectConversation, onDelete: removeConversation });
  renderDeliverables(state);

  // Boot load from API
  bootConversations().catch(err => console.warn('[boot]', err));

  // New chat
  dom.btnNewChat?.addEventListener('click', () => startNewChat());

  // Sidebar toggle
  dom.btnSidebarToggle?.addEventListener('click', () => {
    state = update(state, { sidebarOpen: !state.sidebarOpen });
  });
  dom.btnSidebarClose?.addEventListener('click', () => {
    state = update(state, { sidebarOpen: false });
  });
  dom.sidebarBackdrop?.addEventListener('click', () => {
    state = update(state, { sidebarOpen: false });
  });
  window.addEventListener('resize', () => applySidebarLayout(state));

  // Send / Stop
  dom.send.addEventListener('click', () => {
    if (state.isStreaming) { cancelStream(); return; }
    const text = dom.input.value.trim();
    if (text) {
      dom.input.value = '';
      dom.input.style.height = 'auto';
      sendMessage(text);
    }
  });

  // Textarea auto-resize
  dom.input.addEventListener('input', () => {
    dom.input.style.height = 'auto';
    dom.input.style.height = Math.min(dom.input.scrollHeight, 150) + 'px';
  });

  // Ctrl+Enter or Enter to send
  dom.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      dom.send.click();
    }
  });

  // Upload button
  dom.upload.addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.addEventListener('change', () => {
      if (inp.files?.[0]) handleUpload(inp.files[0]);
    });
    inp.click();
  });

  // Drag & drop
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dom.dropzone.classList.add('show');
  });
  dom.dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (e.target === dom.dropzone || e.currentTarget === e.target) {
      dom.dropzone.classList.remove('show');
    }
  });
  dom.dropzone.addEventListener('dragover', (e) => e.preventDefault());
  dom.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.dropzone.classList.remove('show');
    const files = e.dataTransfer.files;
    if (files?.[0]) handleUpload(files[0]);
  });

  // Ctrl+U for upload
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'u') {
      e.preventDefault();
      dom.upload.click();
    }
  });

  // Keyboard shortcut: Ctrl+L → new chat
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      startNewChat();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
