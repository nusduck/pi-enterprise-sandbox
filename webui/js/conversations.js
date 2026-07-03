/* ── Pi Agent WebUI · Conversation list module ────────────────────────── */

import { escapeHtml, formatTime } from "./utils.js";

/**
 * ConvList — manages the sidebar conversation list.
 */
export class ConvList {
  /**
   * @param {object} options
   * @param {function(string)} options.onSelect - Called when a conversation is selected
   * @param {function(string)} options.onDelete - Called when delete button is clicked
   */
  constructor(options = {}) {
    this.el = document.getElementById("convList");
    this.onSelect = options.onSelect || (() => {});
    this.onDelete = options.onDelete || (() => {});
    this._activeId = null;
  }

  /**
   * Full render of the conversation list.
   * @param {Array} conversations - Array of conversation objects {id, title, updated_at, ...}
   * @param {string|null} activeId - Currently active conversation ID
   */
  render(conversations, activeId) {
    this._activeId = activeId;
    this.el.innerHTML = conversations
      .map(
        (c) => `
      <div class="conv-item ${c.id === activeId ? "active" : ""}" data-id="${c.id}">
        <span class="conv-title">${escapeHtml(c.title || "New conversation")}</span>
        <span class="conv-time">${formatTime(c.updated_at)}</span>
        <button class="conv-del" data-id="${c.id}" title="Delete conversation">✕</button>
      </div>
    `
      )
      .join("");

    // Bind click on items
    this.el.querySelectorAll(".conv-item").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".conv-del")) return;
        this.onSelect(el.dataset.id);
      });
    });

    // Bind click on delete buttons
    this.el.querySelectorAll(".conv-del").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        this.onDelete(btn.dataset.id);
      });
    });
  }

  /**
   * Mark a conversation as selected.
   * @param {string} id
   */
  select(id) {
    this._activeId = id;
    this.el.querySelectorAll(".conv-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.id === id);
    });
  }

  /**
   * Add a single conversation item to the top of the list.
   * @param {object} conv
   */
  addItem(conv) {
    const existing = this.el.querySelector(`[data-id="${conv.id}"]`);
    if (existing) return; // already present

    const div = document.createElement("div");
    div.className = `conv-item ${conv.id === this._activeId ? "active" : ""}`;
    div.dataset.id = conv.id;
    div.innerHTML = `
      <span class="conv-title">${escapeHtml(conv.title || "New conversation")}</span>
      <span class="conv-time">${formatTime(conv.updated_at)}</span>
      <button class="conv-del" data-id="${conv.id}" title="Delete conversation">✕</button>
    `;

    div.addEventListener("click", (e) => {
      if (e.target.closest(".conv-del")) return;
      this.onSelect(div.dataset.id);
    });

    const delBtn = div.querySelector(".conv-del");
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      this.onDelete(conv.id);
    });

    this.el.prepend(div);
  }

  /**
   * Remove a conversation item from the list.
   * @param {string} id
   */
  removeItem(id) {
    const el = this.el.querySelector(`[data-id="${id}"]`);
    if (el) el.remove();
  }

  /**
   * Update a conversation item's title in place.
   * @param {string} id
   * @param {string} title
   */
  updateItem(id, title) {
    const el = this.el.querySelector(`[data-id="${id}"] .conv-title`);
    if (el) el.textContent = title;
  }
}
