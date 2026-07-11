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
  startStream,
  endStream,
  abortStream,
  errorStream,
  switchConversation,
  isActiveGeneration,
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
  getAuthToken,
  clearAuthToken,
  login as apiLogin,
  register as apiRegister,
  me as apiMe,
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
  clearApprovals,
  showApprovalBanner,
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

/** Generation captured at stream start; late events for old gens are ignored. */
let activeStreamGen = 0;

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
 * Mid-stream switch aborts the active stream and clears ephemeral state.
 */
async function selectConversation(id) {
  if (!id || id === state.conversationId) {
    // On mobile, still close sidebar when re-tapping active
    if (window.matchMedia('(max-width: 768px)').matches) {
      state = update(state, { sidebarOpen: false });
    }
    return;
  }

  // Abort any in-flight stream so late SSE events are ignored via generation bump
  if (state.isStreaming || state.abortCtrl) {
    state = abortStream(state);
    activeStreamGen = state.streamGeneration;
  }
  clearApprovals();

  try {
    setStatus('Loading…', '#94a3b8');
    const conv = await getConversation(id);
    const messages = normalizeServerMessages(conv.messages);
    const sessionId = conv.sandbox_session_id || null;

    state = switchConversation(state, {
      conversationId: conv.id,
      messages,
      sessionId,
      sidebarOpen: window.matchMedia('(max-width: 768px)').matches ? false : state.sidebarOpen,
    });
    activeStreamGen = state.streamGeneration;
    persistConversationId(conv.id);
    persistMessages(messages);
    renderMessagesFull(state);
    renderConversationList(state, { onSelect: selectConversation, onDelete: removeConversation });
    renderDeliverables(state);

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
 * Mid-stream new-chat aborts and clears tokens/approvals/artifacts.
 */
async function startNewChat() {
  if (state.isStreaming || state.abortCtrl) {
    state = abortStream(state);
    activeStreamGen = state.streamGeneration;
  }
  clearApprovals();

  state = switchConversation(state, {
    conversationId: null,
    messages: [],
    sessionId: null,
    sidebarOpen: window.matchMedia('(max-width: 768px)').matches ? false : state.sidebarOpen,
  });
  activeStreamGen = state.streamGeneration;
  clearPersistedChat();
  renderMessagesFull(state);
  renderConversationList(state, { onSelect: selectConversation, onDelete: removeConversation });
  renderDeliverables(state);
  setStatus('Agent Ready');
  dom.input?.focus();
}

/**
 * Delete a conversation (server + local if active).
 */
async function removeConversation(id) {
  if (!id) return;
  if (state.isStreaming && id === state.conversationId) {
    // Abort first so delete can proceed cleanly
    state = abortStream(state);
    activeStreamGen = state.streamGeneration;
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

function handleSSE(ev, generation) {
  // Ignore late events from a previous stream / conversation
  if (!isActiveGeneration(state, generation)) return;

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
      const approvalId = ev.approval_id || ev.id;
      if (!approvalId) break;
      state = update(state, {
        pendingApproval: { id: approvalId, reason: ev.reason || ev.command || '' },
      });
      showApprovalBanner({
        id: approvalId,
        reason: ev.reason || ev.command || approvalId,
        onApprove: async () => {
          if (!isActiveGeneration(state, generation)) return;
          try {
            await decideApproval(approvalId, 'approve');
            clearApprovals();
            state = update(state, { pendingApproval: null });
            setStatus('Approved', '#22c55e');
          } catch (err) {
            flashError(err.message);
          }
        },
        onReject: async () => {
          if (!isActiveGeneration(state, generation)) return;
          try {
            await decideApproval(approvalId, 'reject');
            clearApprovals();
            state = update(state, { pendingApproval: null });
            setStatus('Rejected', '#ef4444');
          } catch (err) {
            flashError(err.message);
          }
        },
      });
      break;
    }

    case 'error':
      if (state.currentMsg) {
        state.currentMsg.content.push({
          type: 'text',
          text: `\n[Error: ${ev.message || ev.text}]`,
        });
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

// ── Send message ────────────────────────────────

async function sendMessage(text) {
  if (state.isStreaming || !text.trim()) return;

  // Add user message to state immediately so it renders
  const userMsg = {
    role: 'user',
    content: [{ type: 'text', text: text.trim() }],
  };
  state = update(state, { messages: [...state.messages, userMsg] });

  // Prepare streaming with generation token
  state = startStream(state);
  activeStreamGen = state.streamGeneration;
  const generation = activeStreamGen;
  clearApprovals();
  render(state);

  try {
    // Send full message history (state already includes the user msg)
    await sendChatMessage(
      state.messages,
      (ev) => handleSSE(ev, generation),
      state.abortCtrl?.signal,
      state.conversationId,
    );

    // If generation changed mid-flight (conversation switch), discard
    if (!isActiveGeneration(state, generation)) return;

    // Finalize: append assistant response to messages
    if (state.currentMsg) {
      const newMessages = [...state.messages, state.currentMsg];
      state = endStream(state, { messages: newMessages });
    } else {
      state = endStream(state);
    }
    render(state);
    persistMessages(state.messages);
    // Conversation list may now include a newly created conversation
    await refreshConversations();
    await refreshArtifacts(state.sessionId);
  } catch (err) {
    if (!isActiveGeneration(state, generation)) return;

    if (err.name === 'AbortError') {
      // User cancelled — keep partial message
      if (state.currentMsg) {
        state.currentMsg.stopReason = 'aborted';
        const messages = [...state.messages, state.currentMsg];
        state = abortStream(state, { messages, currentMsg: null });
      } else {
        state = abortStream(state);
      }
      activeStreamGen = state.streamGeneration;
      render(state);
      return;
    }
    console.error('[chat] Error:', err);
    flashError(`Connection error: ${err.message}`);
    if (state.currentMsg) {
      state.currentMsg.content.push({ type: 'text', text: `\n[Connection error: ${err.message}]` });
      const messages = [...state.messages, state.currentMsg];
      state = errorStream(state, { messages, currentMsg: null });
    } else {
      state = errorStream(state);
    }
    render(state);
  } finally {
    if (isActiveGeneration(state, generation) && state.isStreaming) {
      state = update(state, { isStreaming: false, abortCtrl: null });
    }
    if (isActiveGeneration(state, generation)) {
      dom.input.disabled = false;
      dom.input.focus();
    }
  }
}

function cancelStream() {
  if (state.abortCtrl) {
    state.abortCtrl.abort();
  }
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

// ── Auth panel (optional; token in localStorage) ──

function updateAuthUi(user) {
  const panel = document.getElementById('auth-panel');
  const label = document.getElementById('auth-user-label');
  if (!panel) return;
  // Always show panel when AUTH is likely needed or a token exists
  panel.hidden = false;
  if (label) {
    if (user?.username) {
      label.textContent = `Signed in as ${user.username}`;
    } else if (getAuthToken()) {
      label.textContent = 'Token stored (local)';
    } else {
      label.textContent = 'Optional login when AUTH_ENABLED';
    }
  }
}

async function refreshAuthState() {
  const token = getAuthToken();
  if (!token) {
    updateAuthUi(null);
    return;
  }
  try {
    const user = await apiMe();
    updateAuthUi(user);
  } catch {
    // Stale token — keep it visible but mark unknown
    updateAuthUi(null);
  }
}

function wireAuthForm() {
  const form = document.getElementById('auth-form');
  const panel = document.getElementById('auth-panel');
  if (!form || !panel) return;
  panel.hidden = false;

  const usernameEl = document.getElementById('auth-username');
  const passwordEl = document.getElementById('auth-password');
  const btnRegister = document.getElementById('btn-register');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = usernameEl?.value?.trim();
    const password = passwordEl?.value || '';
    if (!username || !password) return;
    try {
      const data = await apiLogin({ username, password });
      updateAuthUi(data.user);
      flashError(''); // clear
      setStatus(`Logged in as ${data.user?.username || username}`);
      await bootConversations();
    } catch (err) {
      flashError(err.message || 'Login failed');
    }
  });

  btnRegister?.addEventListener('click', async () => {
    const username = usernameEl?.value?.trim();
    const password = passwordEl?.value || '';
    if (!username || !password) {
      flashError('Username and password required');
      return;
    }
    try {
      const data = await apiRegister({ username, password });
      updateAuthUi(data.user);
      setStatus(`Registered as ${data.user?.username || username}`);
      await bootConversations();
    } catch (err) {
      flashError(err.message || 'Register failed');
    }
  });

  // Double-click label to clear token (dev convenience)
  document.getElementById('auth-user-label')?.addEventListener('dblclick', () => {
    clearAuthToken();
    updateAuthUi(null);
    setStatus('Logged out');
  });
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

  wireAuthForm();
  refreshAuthState().catch(() => {});

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
