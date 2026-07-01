/* ── Pi Agent WebUI · app.js v2.1 ─────────────────────────────────── */
// ── State ──────────────────────────────────────────────────────────────
let conversations = [];
let activeConvId = null;
let isStreaming = false;
let _activeAbort = null; // AbortController for current SSE request

const convListEl = document.getElementById("convList");
const messagesEl = document.getElementById("messages");
const welcomeEl = document.getElementById("welcome");
const input = document.getElementById("promptInput");
const btnSend = document.getElementById("btnSend");
const streamingIndicator = document.getElementById("streamingIndicator");
const convTitle = document.getElementById("convTitle");
const sandboxBadge = document.getElementById("sandboxBadge");
const agentDot = document.getElementById("agentDot");
const agentStatus = document.getElementById("agentStatus");

// ── Force-reset streaming state ─────────────────────────────────────────
function forceResetStreaming() {
  if (_activeAbort) {
    try { _activeAbort.abort(); } catch {}
    _activeAbort = null;
  }
  isStreaming = false;
  btnSend.disabled = !input.value.trim();
  streamingIndicator.style.display = "none";
}

// ── Textarea auto-resize ───────────────────────────────────────────────
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

// ── API helpers ────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp;
}

// ── Conversation Management ────────────────────────────────────────────

async function loadConversations() {
  try {
    const resp = await api("/api/conversations");
    conversations = await resp.json();
    if (activeConvId && !conversations.find((c) => c.id === activeConvId)) {
      activeConvId = null;
    }
    renderConvList();
  } catch (err) {
    console.error("Failed to load conversations:", err);
  }
}

function renderConvList() {
  convListEl.innerHTML = conversations
    .map(
      (c) => `
    <div class="conv-item ${c.id === activeConvId ? "active" : ""}" data-id="${c.id}">
      <span class="conv-title">${escapeHtml(c.title)}</span>
      <button class="conv-del" data-id="${c.id}" title="Delete">✕</button>
    </div>
  `
    )
    .join("");

  convListEl.querySelectorAll(".conv-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".conv-del")) return;
      selectConversation(el.dataset.id);
    });
  });

  convListEl.querySelectorAll(".conv-del").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteConversation(btn.dataset.id);
    });
  });
}

async function selectConversation(id) {
  if (isStreaming) { forceResetStreaming(); }
  activeConvId = id;
  renderConvList();

  const conv = conversations.find((c) => c.id === id);
  convTitle.textContent = conv ? conv.title : "New conversation";

  try {
    const resp = await api(`/api/conversations/${id}/messages`);
    const msgs = await resp.json();
    renderMessages(msgs);
  } catch (err) {
    console.error("Failed to load messages:", err);
    renderMessages([]);
  }
}

async function newConversation() {
  if (isStreaming) { forceResetStreaming(); }
  try {
    const resp = await api("/api/conversations", { method: "POST" });
    const conv = await resp.json();
    conversations.unshift(conv);
    renderConvList();
    await selectConversation(conv.id);
    input.focus();
  } catch (err) {
    console.error("Failed to create conversation:", err);
  }
}

async function deleteConversation(id) {
  if (isStreaming) { forceResetStreaming(); }
  try {
    await api(`/api/conversations/${id}`, { method: "DELETE" });
    if (activeConvId === id) {
      activeConvId = null;
      convTitle.textContent = "Pi Agent";
      renderMessages([]);
    }
    conversations = conversations.filter((c) => c.id !== id);
    renderConvList();
  } catch (err) {
    console.error("Failed to delete conversation:", err);
  }
}

// ── Message rendering ──────────────────────────────────────────────────

function scrollToBottom() {
  const el = document.getElementById('chatContainer');
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

function renderMessages(msgs) {
  messagesEl.innerHTML = "";
  welcomeEl.style.display = msgs.length === 0 ? "block" : "none";
  for (const msg of msgs) {
    addMessageDOM(msg.role, msg.content, false);
  }
  scrollToBottom();
}

function addMessageDOM(role, content, streaming = false) {
  welcomeEl.style.display = "none";

  if (!streaming) {
    const lastMsg = messagesEl.lastElementChild;
    if (lastMsg && lastMsg.classList.contains("assistant") && lastMsg.dataset.streaming === "true") {
      lastMsg.remove();
    }
  }

  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (streaming) div.dataset.streaming = "true";

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "user" ? "U" : "P";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  if (!streaming) {
    bubble.innerHTML = renderMarkdown(content);
  } else {
    bubble.textContent = content;
  }

  div.appendChild(avatar);
  div.appendChild(bubble);
  messagesEl.appendChild(div);
  scrollToBottom();
  return { div, bubble };
}

function updateStreamingMessage(text) {
  let lastMsg = messagesEl.lastElementChild;
  if (!lastMsg || !lastMsg.classList.contains("assistant") || lastMsg.dataset.streaming !== "true") {
    const result = addMessageDOM("assistant", "", true);
    lastMsg = result.div;
  }
  const bubble = lastMsg.querySelector(".msg-bubble");
  if (bubble) bubble.textContent = text;
  scrollToBottom();
}

function addToolIndicator(toolName, isRunning = true) {
  const div = document.createElement("div");
  div.className = "msg system";
  const toolInfo = document.createElement("div");
  toolInfo.className = "tool-info";
  if (isRunning) {
    toolInfo.innerHTML = `<span class="tool-spinner"></span> Using tool: ${escapeHtml(toolName)}…`;
  } else {
    toolInfo.innerHTML = `✓ Tool: ${escapeHtml(toolName)} completed`;
  }
  div.appendChild(toolInfo);
  messagesEl.appendChild(div);
  scrollToBottom();
  return toolInfo;
}

function updateToolIndicator(el, toolName, isError = false) {
  el.innerHTML = isError
    ? `✕ Tool: ${escapeHtml(toolName)} failed`
    : `✓ Tool: ${escapeHtml(toolName)} completed`;
}

// ── Simple Markdown renderer ───────────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(code)}</code></pre>`;
  });
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(?:<li>.*<\/li>\n?)+(?=<ul|<li)/g, "<ol>$&</ol>");
  html = html.replace(/\n\n/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  return `<p>${html}</p>`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ── Send message ───────────────────────────────────────────────────────
async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;
  // If stuck from a previous broken stream, force-reset
  if (isStreaming) forceResetStreaming();

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

  // 2-minute client-side timeout
  const timeoutId = setTimeout(() => {
    abortCtrl.abort();
  }, 120_000);

  addMessageDOM("user", text);
  streamingIndicator.style.display = "block";

  try {
    const resp = await fetch(`/api/conversations/${activeConvId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
      signal: abortCtrl.signal,
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      addMessageDOM("system", `Error: ${err.error}`);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let assistantText = "";
    let toolEl = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6));
          switch (data.type) {
            case "token":
              assistantText += data.text;
              updateStreamingMessage(assistantText);
              break;
            case "tool_start":
              toolEl = addToolIndicator(data.toolName, true);
              break;
            case "tool_end":
              if (toolEl) {
                updateToolIndicator(toolEl, data.toolName, data.isError);
                toolEl = null;
              }
              break;
            case "error":
              addMessageDOM("system", `Error: ${data.text}`);
              break;
          }
        } catch { /* skip malformed */ }
      }
    }

    if (assistantText.trim()) {
      const lastMsg = messagesEl.lastElementChild;
      if (lastMsg && lastMsg.dataset.streaming === "true") lastMsg.remove();
      addMessageDOM("assistant", assistantText.trim());
    }
  } catch (err) {
    if (err.name === "AbortError") {
      addMessageDOM("system", "Request timed out. Please try again.");
    } else {
      addMessageDOM("system", `Connection error: ${err.message}`);
    }
  } finally {
    streamingIndicator.style.display = "none";
    isStreaming = false;
    btnSend.disabled = false;
    _activeAbort = null;
    input.focus();
    loadConversations();
  }
}

btnSend.addEventListener("click", sendMessage);

// ── New chat button ────────────────────────────────────────────────────
document.getElementById("btnNewChat").addEventListener("click", async () => {
  await newConversation();
  if (innerWidth <= 768) {
    document.getElementById("sidebar").classList.remove("open");
  }
});

// ── Sidebar toggle (mobile) ────────────────────────────────────────────
document.getElementById("btnMenu").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("sidebarOverlay").classList.toggle("show");
});

document.getElementById("sidebarOverlay").addEventListener("click", () => {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebarOverlay").classList.remove("show");
});

document.getElementById("btnToggleSidebar").addEventListener("click", () => {
  const sidebar = document.getElementById("sidebar");
  sidebar.style.display = sidebar.style.display === "none" ? "flex" : "none";
});

// ── Health check ───────────────────────────────────────────────────────
async function checkHealth() {
  try {
    const resp = await api("/api/status");
    const data = await resp.json();
    agentDot.className = "dot on";
    agentStatus.textContent = `${data.conversations} conv`;
    if (data.sandbox) {
      sandboxBadge.textContent = `sandbox: ${data.sandbox.status} · ${data.sandbox.sessions_active || "?"} sessions`;
    }
  } catch {
    agentDot.className = "dot off";
    agentStatus.textContent = "offline";
    sandboxBadge.textContent = "sandbox: unreachable";
  }
}

// ── Init ───────────────────────────────────────────────────────────────
async function init() {
  // Ensure no stuck streaming state from previous page loads
  forceResetStreaming();

  await loadConversations();
  checkHealth();
  setInterval(checkHealth, 10000);

  if (conversations.length === 0) {
    await newConversation();
  } else {
    await selectConversation(conversations[0].id);
  }

  input.focus();
}

init();
