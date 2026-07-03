/* ── Pi Agent WebUI · Main entry point ────────────────────────────────── */

import {
  api,
  fetchConversations,
  createConversation,
  deleteConversation,
  fetchMessages,
  checkHealth,
  streamChat,
  getSandboxSessionId,
  fetchArtifacts,
} from "./api.js";
import { scrollToBottom } from "./utils.js";
import { ChatUI } from "./chat.js";
import { ConvList } from "./conversations.js";

/* ═══════════════════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════════════════ */
const CHAT_TIMEOUT_MS = 120_000;

/* ═══════════════════════════════════════════════════════════════════════
   State
   ═══════════════════════════════════════════════════════════════════════ */
let conversations = [];
let activeConvId = null;
let isStreaming = false;
let _activeAbort = null; // AbortController for current SSE request

/* ═══════════════════════════════════════════════════════════════════════
   DOM References
   ═══════════════════════════════════════════════════════════════════════ */
const convTitle = document.getElementById("convTitle");
const sandboxBadge = document.getElementById("sandboxBadge");
const input = document.getElementById("promptInput");
const btnSend = document.getElementById("btnSend");
const agentDot = document.getElementById("agentDot");
const agentStatus = document.getElementById("agentStatus");

/* ═══════════════════════════════════════════════════════════════════════
   UI Instances
   ═══════════════════════════════════════════════════════════════════════ */
const chatUI = new ChatUI();
const convList = new ConvList({
  onSelect: (id) => selectConversation(id),
  onDelete: (id) => deleteConversationHandler(id),
});

/* ═══════════════════════════════════════════════════════════════════════
   Core Helpers
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Force-reset any in-progress streaming state.
 */
function forceResetStreaming() {
  if (_activeAbort) {
    try {
      _activeAbort.abort();
    } catch {
      /* ignore */
    }
    _activeAbort = null;
  }
  isStreaming = false;
  btnSend.disabled = !input.value.trim();
  chatUI.setStreamingIndicator(false);
}

/* ═══════════════════════════════════════════════════════════════════════
   Conversation Management
   ═══════════════════════════════════════════════════════════════════════ */

async function loadConversations() {
  try {
    conversations = await fetchConversations();
    if (activeConvId && !conversations.find((c) => c.id === activeConvId)) {
      activeConvId = null;
    }
    convList.render(conversations, activeConvId);
  } catch (err) {
    console.error("Failed to load conversations:", err);
  }
}

async function selectConversation(id) {
  if (isStreaming) {
    forceResetStreaming();
  }
  activeConvId = id;
  convList.select(id);

  const conv = conversations.find((c) => c.id === id);
  convTitle.textContent = conv ? conv.title : "New conversation";

  try {
    const msgs = await fetchMessages(id);
    chatUI.renderMessages(msgs);
  } catch (err) {
    console.error("Failed to load messages:", err);
    chatUI.clear();
  }
}

async function newConversation() {
  if (isStreaming) {
    forceResetStreaming();
  }
  try {
    const conv = await createConversation();
    conversations.unshift(conv);
    convList.render(conversations, activeConvId);
    await selectConversation(conv.id);
    input.focus();
  } catch (err) {
    console.error("Failed to create conversation:", err);
  }
}

async function deleteConversationHandler(id) {
  if (isStreaming) {
    forceResetStreaming();
  }
  try {
    await deleteConversation(id);
    if (activeConvId === id) {
      activeConvId = null;
      convTitle.textContent = "Pi Agent";
      chatUI.clear();
    }
    conversations = conversations.filter((c) => c.id !== id);
    convList.render(conversations, activeConvId);
  } catch (err) {
    console.error("Failed to delete conversation:", err);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   Send Message / Streaming
   ═══════════════════════════════════════════════════════════════════════ */

async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;

  // If stuck from a previous broken stream, force-reset
  if (isStreaming) forceResetStreaming();

  // Auto-create conversation if none active
  if (!activeConvId) {
    await newConversation();
    setTimeout(() => sendMessage(), 100);
    return;
  }

  input.value = "";
  input.style.height = "auto";
  btnSend.disabled = true;
  isStreaming = true;

  const abortCtrl = new AbortController();
  _activeAbort = abortCtrl;

  // Client-side timeout
  const timeoutId = setTimeout(() => {
    try {
      abortCtrl.abort();
    } catch {
      /* ignore */
    }
  }, CHAT_TIMEOUT_MS);

  // Show user message
  chatUI.addMessage("user", text);

  // Show streaming indicator
  chatUI.setStreamingIndicator(true);

  try {
    let toolEl = null;

    await streamChat(activeConvId, text, abortCtrl.signal, {
      onToken: (fullText) => {
        chatUI.updateStreamingMessage(fullText);
      },

      onToolStart: (toolName) => {
        toolEl = chatUI.addToolIndicator(toolName, true);
      },

      onToolEnd: (toolName, isError) => {
        if (toolEl) {
          chatUI.updateToolIndicator(toolEl, toolName, isError);
          toolEl = null;
        }
      },

      onError: (errorMsg) => {
        chatUI.addSystemMessage(`Error: ${errorMsg}`);
      },

      onDone: async (fullText) => {
        chatUI.finalizeStreamingMessage(fullText);
        // Fetch and display artifacts (output files) after response
        try {
          const sid = await getSandboxSessionId(activeConvId);
          if (sid) {
            const artifacts = await fetchArtifacts(sid);
            if (artifacts.length > 0) {
              chatUI.addArtifactsPanel(artifacts, sid);
            }
          }
        } catch { /* ignore artifact errors */ }
      },
    });
  } catch (err) {
    if (err.name === "AbortError") {
      chatUI.addSystemMessage("Request timed out. Please try again.");
    } else {
      chatUI.addSystemMessage(`Connection error: ${err.message}`);
    }
  } finally {
    clearTimeout(timeoutId);
    chatUI.setStreamingIndicator(false);
    isStreaming = false;
    btnSend.disabled = false;
    _activeAbort = null;
    input.focus();
    // Refresh conversation list (title may have updated)
    loadConversations();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   Event Listeners
   ═══════════════════════════════════════════════════════════════════════ */

// Send button
btnSend.addEventListener("click", sendMessage);

// Textarea auto-resize + submit on Enter
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
  btnSend.disabled = !input.value.trim() || isStreaming;
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!btnSend.disabled) sendMessage();
  }
});

// New chat button
document.getElementById("btnNewChat").addEventListener("click", async () => {
  await newConversation();
  if (innerWidth <= 768) {
    document.getElementById("sidebar").classList.remove("open");
  }
});

// Sidebar toggle (mobile hamburger)
document.getElementById("btnMenu").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("sidebarOverlay").classList.toggle("show");
});

// Sidebar overlay close (mobile)
document.getElementById("sidebarOverlay").addEventListener("click", () => {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebarOverlay").classList.remove("show");
});

// Sidebar toggle button (desktop hide/show)
document.getElementById("btnToggleSidebar").addEventListener("click", () => {
  const sidebar = document.getElementById("sidebar");
  sidebar.style.display = sidebar.style.display === "none" ? "flex" : "none";
});

/* ═══════════════════════════════════════════════════════════════════════
   Theme Toggle
   ═══════════════════════════════════════════════════════════════════════ */

document.getElementById("btnThemeToggle")?.addEventListener("click", () => {
  const html = document.documentElement;
  const current = html.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  html.setAttribute("data-theme", next);
  localStorage.setItem("pi-agent-theme", next);
});

// Restore saved theme on load
const savedTheme = localStorage.getItem("pi-agent-theme");
if (savedTheme) {
  document.documentElement.setAttribute("data-theme", savedTheme);
}

/* ═══════════════════════════════════════════════════════════════════════
   Health Check
   ═══════════════════════════════════════════════════════════════════════ */

async function performHealthCheck() {
  const data = await checkHealth();
  if (data) {
    agentDot.className = "dot on";
    agentStatus.textContent = `${data.conversations} conv`;
    if (data.sandbox) {
      sandboxBadge.textContent = `sandbox: ${data.sandbox.status} · ${
        data.sandbox.sessions_active || "?"
      } sessions`;
    }
  } else {
    agentDot.className = "dot off";
    agentStatus.textContent = "offline";
    sandboxBadge.textContent = "sandbox: unreachable";
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   Init
   ═══════════════════════════════════════════════════════════════════════ */

async function init() {
  // Ensure no stuck streaming state from previous page loads
  forceResetStreaming();

  await loadConversations();
  performHealthCheck();
  setInterval(performHealthCheck, 10_000);

  if (conversations.length === 0) {
    await newConversation();
  } else {
    await selectConversation(conversations[0].id);
  }

  input.focus();
}

// Boot
init();
