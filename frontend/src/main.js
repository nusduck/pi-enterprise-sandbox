/**
 * Pi Enterprise Sandbox — Frontend Entry Point
 *
 * Architecture: Vanilla JS SPA consuming SSE events from api-server.
 * No agent code runs in the browser — all LLM/tool logic is server-side.
 */
import { createState, update, subscribe, persistMessages, loadPersistedMessages, persistConversationId, loadPersistedConversationId } from './state.js';
import { sendChatMessage, uploadFile, getDownloadUrl } from './api.js';
import { initDOM, dom, render, incBubble, rerenderLast, setStatus, flashError, showWelcome } from './render.js';

// ── Init DOM references ─────────────────────────
initDOM({
  msgs: document.getElementById('messages'),
  input: document.getElementById('input'),
  send: document.getElementById('btn-send'),
  upload: document.getElementById('btn-upload'),
  dropzone: document.getElementById('dropzone'),
  status: document.getElementById('status-label'),
  flash: document.getElementById('flash-zone'),
});

// ── State ───────────────────────────────────────
let state = createState();

// Restore persisted messages and conversation
const saved = loadPersistedMessages();
if (saved.length) {
  state = update(state, { messages: saved });
}
const savedConvId = loadPersistedConversationId();
if (savedConvId) {
  state = update(state, { conversationId: savedConvId });
}

// Re-render on state changes
subscribe(() => render(state));

// ── SSE event handler ───────────────────────────

function handleSSE(ev) {
  switch (ev.type) {
    case 'session':
      state = update(state, { sessionId: ev.session_id });
      if (ev.conversation_id) {
        state = update(state, { conversationId: ev.conversation_id });
        persistConversationId(ev.conversation_id);
      }
      setStatus(`Session ${ev.session_id.slice(-8)}`);
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

    case 'file_ready':
      if (state.sessionId && ev.path && !state.readyFiles.has(ev.path)) {
        const readyFiles = new Set(state.readyFiles);
        readyFiles.add(ev.path);
        state = update(state, { readyFiles });

        const name = ev.path.split('/').pop();
        const url = getDownloadUrl(state.sessionId, ev.path);
        if (!state.currentMsg._fileLinks) state.currentMsg._fileLinks = [];
        state.currentMsg._fileLinks.push({ name, url, path: ev.path });
        rerenderLast(state);
      }
      break;

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
  } catch (err) {
    if (err.name === 'AbortError') {
      // User cancelled — keep partial message
      if (state.currentMsg) {
        state.currentMsg.stopReason = 'aborted';
        messages.push(state.currentMsg);
        state = update(state, { messages, currentMsg: null });
      }
      render(state);
      return;
    }
    console.error('[chat] Error:', err);
    flashError(`Connection error: ${err.message}`);
    if (state.currentMsg) {
      state.currentMsg.content.push({ type: 'text', text: `\n[Connection error: ${err.message}]` });
      messages.push(state.currentMsg);
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

// ── Init ────────────────────────────────────────

function init() {
  render(state);

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

  // Keyboard shortcut: Ctrl+L to clear conversation
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      state = update(state, {
        messages: [],
        sessionId: null,
        conversationId: null,
        readyFiles: new Set(),
        currentMsg: null,
      });
      dom.msgs.innerHTML = '';
      localStorage.removeItem('sandbox_messages');
      localStorage.removeItem('sandbox_conversation_id');
      showWelcome();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
