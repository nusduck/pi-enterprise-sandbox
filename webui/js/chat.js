/* ── Pi Agent WebUI · Chat UI module ──────────────────────────────────── */

import { escapeHtml, renderMarkdown, scrollToBottom } from "./utils.js";

/**
 * ChatUI — manages the message area, streaming output, and tool indicators.
 */
export class ChatUI {
  constructor() {
    this.messagesEl = document.getElementById("messages");
    this.welcomeEl = document.getElementById("welcome");
    this.streamingIndicator = document.getElementById("streamingIndicator");
  }

  /**
   * Render a list of messages (initial load).
   * @param {Array} msgs - Array of {role, content} objects
   */
  renderMessages(msgs) {
    this.messagesEl.innerHTML = "";
    this.welcomeEl.style.display = msgs.length === 0 ? "block" : "none";
    for (const msg of msgs) {
      this._addDOM(msg.role, msg.content, false);
    }
    scrollToBottom();
  }

  /**
   * Add a message to the DOM.
   * @param {"user"|"assistant"|"system"} role
   * @param {string} content
   * @param {boolean} [streaming=false] - If true, render as plain text (updating)
   * @returns {{div: HTMLElement, bubble: HTMLElement}}
   */
  addMessage(role, content, streaming = false) {
    return this._addDOM(role, content, streaming);
  }

  /**
   * Update the last streaming assistant message with new text.
   * Creates a new streaming message if none exists.
   * @param {string} text
   */
  updateStreamingMessage(text) {
    let lastMsg = this.messagesEl.lastElementChild;
    if (
      !lastMsg ||
      !lastMsg.classList.contains("assistant") ||
      lastMsg.dataset.streaming !== "true"
    ) {
      const result = this._addDOM("assistant", "", true);
      lastMsg = result.div;
    }
    const bubble = lastMsg.querySelector(".msg-bubble");
    if (bubble) bubble.textContent = text;
    scrollToBottom();
  }

  /**
   * Finalize a streaming message — re-render as markdown.
   * Removes the streaming message and re-adds it as a final rendered message.
   * @param {string} text
   */
  finalizeStreamingMessage(text) {
    const lastMsg = this.messagesEl.lastElementChild;
    if (lastMsg && lastMsg.dataset.streaming === "true") {
      lastMsg.remove();
    }
    if (text.trim()) {
      this._addDOM("assistant", text.trim(), false);
    }
  }

  /**
   * Add or update a tool call indicator message.
   * @param {string} toolName
   * @param {boolean} isRunning - true = spinner, false = completed state
   * @param {object} [toolData] - Optional tool data (args, result) for collapsible detail
   * @param {string} [toolData.args] - JSON string of tool arguments
   * @param {string} [toolData.result] - Tool result summary
   * @returns {HTMLElement} The tool info element
   */
  addToolIndicator(toolName, isRunning = true, toolData = null) {
    const div = document.createElement("div");
    div.className = "msg system tool-msg";

    const toolInfo = document.createElement("div");
    toolInfo.className = `tool-info${isRunning ? "" : " tool-done"}`;

    if (isRunning) {
      toolInfo.innerHTML = `
        <span class="tool-spinner"></span>
        <span class="tool-name">${escapeHtml(toolName)}</span>
        <span class="tool-status">running…</span>
      `;
    } else {
      toolInfo.innerHTML = `
        <span class="tool-status-icon">✓</span>
        <span class="tool-name">${escapeHtml(toolName)}</span>
        <span class="tool-status">done</span>
      `;
    }

    div.appendChild(toolInfo);

    // Add collapsible detail section if toolData is provided
    if (toolData && (toolData.args || toolData.result)) {
      const details = document.createElement("details");
      details.className = "tool-details";
      const summary = document.createElement("summary");
      summary.textContent = "Details";
      details.appendChild(summary);

      const detailBody = document.createElement("div");
      detailBody.className = "tool-detail-body";
      if (toolData.args) {
        const argsPre = document.createElement("pre");
        argsPre.className = "tool-args";
        argsPre.textContent = toolData.args;
        detailBody.appendChild(argsPre);
      }
      if (toolData.result) {
        const resultPre = document.createElement("pre");
        resultPre.className = "tool-result";
        resultPre.textContent = toolData.result;
        detailBody.appendChild(resultPre);
      }
      details.appendChild(detailBody);
      div.appendChild(details);
    }

    this.messagesEl.appendChild(div);
    scrollToBottom();
    return toolInfo;
  }

  /**
   * Update a tool indicator to show completion or error.
   * @param {HTMLElement} el - The tool-info element returned by addToolIndicator
   * @param {string} toolName
   * @param {boolean} [isError=false]
   */
  updateToolIndicator(el, toolName, isError = false) {
    if (isError) {
      el.className = "tool-info tool-error";
      el.innerHTML = `
        <span class="tool-status-icon">✕</span>
        <span class="tool-name">${escapeHtml(toolName)}</span>
        <span class="tool-status">failed</span>
      `;
    } else {
      el.className = "tool-info tool-done";
      el.innerHTML = `
        <span class="tool-status-icon">✓</span>
        <span class="tool-name">${escapeHtml(toolName)}</span>
        <span class="tool-status">done</span>
      `;
    }
  }

  /**
   * Add a system message (errors, status).
   * @param {string} text
   */
  addSystemMessage(text) {
    const div = document.createElement("div");
    div.className = "msg system";
    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.textContent = text;
    div.appendChild(bubble);
    this.messagesEl.appendChild(div);
    scrollToBottom();
  }

  /**
   * Clear all messages and show welcome.
   */
  clear() {
    this.messagesEl.innerHTML = "";
    this.welcomeEl.style.display = "block";
  }

  /**
   * Add an artifacts panel showing downloadable output files.
   * @param {Array} artifacts - Array of {id, name, path, mime_type, size}
   * @param {string} sessionId - Sandbox session ID for download URLs
   */
  addArtifactsPanel(artifacts, sessionId) {
    // Remove any previous artifacts panel to avoid duplicates
    const existing = this.messagesEl.querySelector(".artifacts-panel");
    if (existing) existing.remove();

    const div = document.createElement("div");
    div.className = "msg system artifacts-panel";

    const inner = document.createElement("div");
    inner.className = "artifacts-inner";

    const heading = document.createElement("div");
    heading.className = "artifacts-heading";
    heading.textContent = `📎 Output Files (${artifacts.length})`;
    inner.appendChild(heading);

    const list = document.createElement("div");
    list.className = "artifacts-list";

    for (const art of artifacts) {
      const item = document.createElement("div");
      item.className = "artifact-item";

      const icon = document.createElement("span");
      icon.className = "artifact-icon";
      const mime = art.mime_type || "";
      if (mime.includes("html")) icon.textContent = "🌐";
      else if (mime.includes("image")) icon.textContent = "🖼";
      else if (mime.includes("json")) icon.textContent = "📋";
      else if (mime.includes("pdf")) icon.textContent = "📄";
      else if (mime.includes("csv") || mime.includes("text")) icon.textContent = "📝";
      else icon.textContent = "📎";

      const nameSpan = document.createElement("span");
      nameSpan.className = "artifact-name";
      nameSpan.textContent = art.name;

      const sizeSpan = document.createElement("span");
      sizeSpan.className = "artifact-size";
      sizeSpan.textContent = art.size ? `${(art.size / 1024).toFixed(1)} KB` : "";

      const dlLink = document.createElement("a");
      dlLink.className = "artifact-download";
      dlLink.textContent = "⬇ Download";
      dlLink.href = `/api/sessions/${sessionId}/files/download?path=${encodeURIComponent(art.path)}`;
      dlLink.target = "_blank";
      dlLink.rel = "noopener";

      item.appendChild(icon);
      item.appendChild(nameSpan);
      item.appendChild(sizeSpan);
      item.appendChild(dlLink);
      list.appendChild(item);
    }

    inner.appendChild(list);
    div.appendChild(inner);
    this.messagesEl.appendChild(div);
    scrollToBottom();
  }

  /**
   * Set streaming indicator visibility.
   * @param {boolean} visible
   */
  setStreamingIndicator(visible) {
    this.streamingIndicator.style.display = visible ? "block" : "none";
  }

  // ── Private helpers ────────────────────────────────────────────────

  /**
   * Internal DOM creation method.
   * @private
   */
  _addDOM(role, content, streaming = false) {
    this.welcomeEl.style.display = "none";

    // If this is a final (non-streaming) message and the previous was streaming, remove it
    if (!streaming) {
      const lastMsg = this.messagesEl.lastElementChild;
      if (
        lastMsg &&
        lastMsg.classList.contains("assistant") &&
        lastMsg.dataset.streaming === "true"
      ) {
        lastMsg.remove();
      }
    }

    const div = document.createElement("div");
    div.className = `msg ${role}`;
    if (streaming) div.dataset.streaming = "true";

    const avatar = document.createElement("div");
    avatar.className = "msg-avatar";
    if (role === "system") {
      avatar.textContent = "●";
    } else {
      avatar.textContent = role === "user" ? "U" : "P";
    }

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    if (!streaming) {
      bubble.innerHTML = renderMarkdown(content);
      // Wire up copy buttons in code blocks
      this._wireCopyButtons(bubble);
    } else {
      bubble.textContent = content;
    }

    div.appendChild(avatar);
    div.appendChild(bubble);
    this.messagesEl.appendChild(div);
    scrollToBottom();
    return { div, bubble };
  }

  /**
   * Wire up copy buttons inside a rendered message bubble.
   * @private
   * @param {HTMLElement} bubble
   */
  _wireCopyButtons(bubble) {
    bubble.querySelectorAll(".copy-code-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pre = btn.closest("pre");
        const code = pre?.querySelector("code");
        if (!code) return;
        const text = code.textContent;
        try {
          await navigator.clipboard.writeText(text);
          const orig = btn.textContent;
          btn.textContent = "✅";
          setTimeout(() => {
            btn.textContent = orig;
          }, 2000);
        } catch {
          btn.textContent = "❌";
          setTimeout(() => {
            btn.textContent = "📋";
          }, 2000);
        }
      });
    });
  }
}
