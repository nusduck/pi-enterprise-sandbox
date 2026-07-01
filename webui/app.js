/* ── Agent WebUI · app.js ──────────────────────────────────────────── */

const chatContainer = document.getElementById("chatContainer");
const messagesEl = document.getElementById("messages");
const welcomeEl = document.getElementById("welcome");
const input = document.getElementById("promptInput");
const btnSend = document.getElementById("btnSend");
const streamingIndicator = document.getElementById("streamingIndicator");
const agentDot = document.getElementById("agentDot");
const agentStatus = document.getElementById("agentStatus");
const sandboxBadge = document.getElementById("sandboxBadge");

let isStreaming = false;
let history = []; // [{role, content}]

// ─── Auto-resize textarea ──────────────────────────────────────────
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
  btnSend.disabled = !input.value.trim();
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!btnSend.disabled) sendMessage();
  }
});

// ─── Send message ──────────────────────────────────────────────────
async function sendMessage() {
  const text = input.value.trim();
  if (!text || isStreaming) return;

  input.value = "";
  input.style.height = "auto";
  btnSend.disabled = true;
  welcomeEl.style.display = "none";

  // Add user message
  addMessage("user", text);
  history.push({ role: "user", content: text });

  // Show streaming indicator
  streamingIndicator.style.display = "block";
  isStreaming = true;
  scrollToBottom();

  // Assistant message placeholder
  const assistantMsg = addMessage("assistant", "");
  const bubble = assistantMsg.querySelector(".msg-bubble");
  let fullText = "";

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history }),
    });

    if (!resp.ok) {
      bubble.textContent = `Error: ${resp.status} ${resp.statusText}`;
      bubble.style.color = "var(--red)";
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.type === "token") {
            fullText += data.text;
            bubble.textContent = fullText;
            scrollToBottom();
          } else if (data.type === "done") {
            // finished
          } else if (data.type === "error") {
            bubble.textContent = `Error: ${data.text}`;
            bubble.style.color = "var(--red)";
          }
        } catch { /* skip malformed */ }
      }
    }
  } catch (err) {
    bubble.textContent = `Connection error: ${err.message}`;
    bubble.style.color = "var(--red)";
  } finally {
    streamingIndicator.style.display = "none";
    isStreaming = false;
    btnSend.disabled = false;
    input.focus();

    if (fullText.trim()) {
      history.push({ role: "assistant", content: fullText });
    }
  }
}

btnSend.addEventListener("click", sendMessage);

// ─── Add message to DOM ────────────────────────────────────────────
function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "msg-avatar";
  avatar.textContent = role === "user" ? "U" : "P";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = text;

  div.appendChild(avatar);
  div.appendChild(bubble);
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

// ─── Scroll to bottom ──────────────────────────────────────────────
function scrollToBottom() {
  requestAnimationFrame(() => {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  });
}

// ─── New chat ──────────────────────────────────────────────────────
document.getElementById("btnNewChat").addEventListener("click", () => {
  messagesEl.innerHTML = "";
  history = [];
  welcomeEl.style.display = "block";
  input.focus();
});

// ─── Health check ──────────────────────────────────────────────────
async function checkHealth() {
  try {
    const resp = await fetch("/api/health");
    const data = await resp.json();
    agentDot.className = "status-dot on";
    agentStatus.textContent = "online";
  } catch {
    agentDot.className = "status-dot off";
    agentStatus.textContent = "offline";
  }

  // Sandbox status — fetched via the WebUI server proxy
  try {
    const resp = await fetch("/api/sandbox-health");
    const data = await resp.json();
    sandboxBadge.textContent = `sandbox: ${data.status} · ${data.sessions_active || '?'} sessions`;
  } catch {
    sandboxBadge.textContent = "sandbox: unreachable";
  }
}

checkHealth();
setInterval(checkHealth, 10000);

// Focus input on load
input.focus();
