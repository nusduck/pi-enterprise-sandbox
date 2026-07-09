/**
 * DOM rendering helpers for the chat UI.
 * Download URLs are prebuilt in main.js (artifact-first, P7) and stored on _fileLinks.
 */

import { conversationTitle } from './state.js';
import { getArtifactDownloadUrl, getDownloadUrl } from './api.js';

// ── DOM references (set once during init) ──────
export let dom = {};

export function initDOM(refs) {
  dom = refs;
}

// ── Helpers ─────────────────────────────────────

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function time() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function scrollBottom() {
  requestAnimationFrame(() => { dom.msgs.scrollTop = dom.msgs.scrollHeight; });
}

function formatSize(n) {
  if (n == null || Number.isNaN(Number(n))) return '';
  const b = Number(n);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function shortDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()}`;
  } catch {
    return '';
  }
}

// ── Status bar ──────────────────────────────────

export function setStatus(text, color) {
  if (!dom.status) return;
  dom.status.textContent = text;
  const dot = document.querySelector('.badge .dot');
  if (dot) dot.style.background = color || '#22c55e';
}

let errorTimer = null;
export function flashError(msg) {
  if (!dom.flash) return;
  dom.flash.innerHTML = `<div class="flash">${esc(msg)}</div>`;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { dom.flash.innerHTML = ''; }, 4000);
}

// ── Welcome screen ──────────────────────────────

export function showWelcome() {
  // Only show if truly empty
  if (dom.msgs.querySelector('.mw')) return;
  dom.msgs.innerHTML = `
    <div class="welcome">
      <div class="icon">◆</div>
      <h2>Enterprise Sandbox</h2>
      <p>AI-powered sandboxed coding environment. Upload files or ask the agent to write code.</p>
      <p style="font-size:12px;color:#64748b">
        <kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline · <kbd>Ctrl+L</kbd> new chat
      </p>
    </div>`;
}

function removeWelcome() {
  const w = dom.msgs.querySelector('.welcome');
  if (w) w.remove();
}

// ── Message rendering ───────────────────────────

function renderMsg(msg, idx) {
  const div = document.createElement('div');
  const role = msg.role || 'assistant';
  const isUser = role === 'user';
  div.className = `mw ${role}`;
  div.style.animationDelay = `${idx * 40}ms`;

  let html = '';
  const parts = msg.content || [];

  for (const p of parts) {
    if (p.type === 'text' && p.text) {
      html += esc(p.text) + '\n';
    } else if (p.type === 'tool_use') {
      const st = p.isError ? 'tp-e' : p.status === 'running' ? 'tp-r' : 'tp-d';
      const icon = p.isError ? '✕' : p.status === 'running' ? '' : '✓';
      const name = esc(p.name || 'tool');
      const spinner = p.status === 'running' ? '<span class="tpd"></span>' : '';
      const args = p.input ? JSON.stringify(p.input, null, 2) : '';
      const res = p.result ? (typeof p.result === 'string' ? p.result : JSON.stringify(p.result, null, 2)) : '';
      const detail = esc(args || res || '(no data)');
      html += `<span class="tp ${st}" onclick="const p=this.querySelector('.tp-pop');if(p)p.classList.toggle('hide')">${spinner}🔧 ${name} ${icon}<span class="tp-pop hide">${detail}</span></span> `;
    }
  }

  // Convert download markdown to styled links
  html = html.replace(/📄 \*\*([^*]+)\*\* — \[Download\]\(([^)]+)\)\n?/g,
    (m, name, url) => `<a class="dl" href="${esc(url)}" download>⬇ ${esc(name)}</a>`);

  // File links attached to message
  if (msg._fileLinks) {
    for (const fl of msg._fileLinks) {
      html += `<a class="dl" href="${esc(fl.url)}" download>⬇ ${esc(fl.name)}</a>`;
    }
  }

  div.innerHTML = `<div class="av">${isUser ? '🧑' : '●'}</div>
    <div class="body">
      <div class="bubble">${html || '<em style="color:#64748b">(empty)</em>'}</div>
      <div class="time">${time()}</div>
    </div>`;
  return div;
}

// ── Sidebar conversations ───────────────────────

/**
 * Render conversation list in the left sidebar.
 * @param {object} state
 * @param {{ onSelect?: (id:string)=>void, onDelete?: (id:string)=>void }} [handlers]
 */
export function renderConversationList(state, handlers = {}) {
  const list = dom.conversationList;
  if (!list) return;

  const convs = state.conversations || [];
  if (!convs.length) {
    list.innerHTML = `<div class="sidebar-empty">No conversations yet.<br/>Start a new chat.</div>`;
    return;
  }

  list.innerHTML = '';
  for (const conv of convs) {
    const item = document.createElement('div');
    item.className = `conv-item${conv.id === state.conversationId ? ' active' : ''}`;
    item.setAttribute('role', 'listitem');
    item.dataset.id = conv.id;

    const title = document.createElement('span');
    title.className = 'conv-title';
    title.textContent = conversationTitle(conv);
    title.title = title.textContent;

    const meta = document.createElement('span');
    meta.className = 'conv-meta';
    meta.textContent = shortDate(conv.updated_at || conv.created_at);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn-del-conv';
    del.title = 'Delete conversation';
    del.textContent = '🗑';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onDelete?.(conv.id);
    });

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(del);
    item.addEventListener('click', () => handlers.onSelect?.(conv.id));
    list.appendChild(item);
  }
}

/**
 * Apply sidebar open/collapsed classes for desktop + mobile.
 */
export function applySidebarLayout(state) {
  const sidebar = dom.sidebar;
  const backdrop = dom.sidebarBackdrop;
  if (!sidebar) return;

  const open = state.sidebarOpen !== false;
  const isMobile = window.matchMedia('(max-width: 768px)').matches;

  if (isMobile) {
    sidebar.classList.remove('collapsed');
    sidebar.classList.toggle('open-mobile', open);
    if (backdrop) backdrop.hidden = !open;
  } else {
    sidebar.classList.remove('open-mobile');
    sidebar.classList.toggle('collapsed', !open);
    if (backdrop) backdrop.hidden = true;
  }
}

// ── Deliverables ────────────────────────────────

/**
 * Render artifacts chips for current session.
 * @param {object} state
 */
export function renderDeliverables(state) {
  const panel = dom.deliverables;
  const list = dom.deliverablesList;
  const countEl = dom.deliverablesCount;
  if (!panel || !list) return;

  const artifacts = state.artifacts || [];
  if (!artifacts.length || !state.sessionId) {
    panel.hidden = true;
    list.innerHTML = '';
    if (countEl) countEl.textContent = '0';
    return;
  }

  panel.hidden = false;
  if (countEl) countEl.textContent = String(artifacts.length);
  list.innerHTML = '';

  for (const a of artifacts) {
    const id = a.artifact_id || a.id;
    const name = a.name || a.path || id || 'file';
    let url = null;
    if (id && state.sessionId) {
      url = getArtifactDownloadUrl(state.sessionId, id);
    } else if (a.path && state.sessionId) {
      url = getDownloadUrl(state.sessionId, a.path);
    }
    if (!url) continue;

    const chip = document.createElement('a');
    chip.className = 'artifact-chip';
    chip.href = url;
    chip.download = name;
    chip.title = a.path || name;
    const size = formatSize(a.size);
    chip.innerHTML = `⬇ ${esc(name)}${size ? ` <span class="chip-size">${esc(size)}</span>` : ''}`;
    list.appendChild(chip);
  }
}

// ── Full render ─────────────────────────────────

export function render(state) {
  const display = state.currentMsg
    ? [...state.messages, state.currentMsg]
    : state.messages;

  removeWelcome();

  // Append only new messages beyond current DOM length
  const startIdx = dom.msgs.querySelectorAll('.mw').length;

  for (let i = startIdx; i < display.length; i++) {
    dom.msgs.appendChild(renderMsg(display[i], i));
  }

  // Update send button
  dom.send.textContent = state.isStreaming ? '■' : '➤';
  dom.send.className = `btn ${state.isStreaming ? 'btn-stop' : 'btn-send'}`;
  dom.send.disabled = false;
  dom.input.disabled = state.isStreaming;

  if (!state.isStreaming && !dom.msgs.querySelector('.mw')) showWelcome();
  scrollBottom();
}

/**
 * Full message area rebuild (used when switching conversations).
 */
export function renderMessagesFull(state) {
  if (!dom.msgs) return;
  dom.msgs.innerHTML = '';
  const display = state.currentMsg
    ? [...state.messages, state.currentMsg]
    : state.messages;
  if (!display.length) {
    showWelcome();
  } else {
    for (let i = 0; i < display.length; i++) {
      dom.msgs.appendChild(renderMsg(display[i], i));
    }
  }
  // Update send button
  if (dom.send) {
    dom.send.textContent = state.isStreaming ? '■' : '➤';
    dom.send.className = `btn ${state.isStreaming ? 'btn-stop' : 'btn-send'}`;
    dom.send.disabled = false;
  }
  if (dom.input) dom.input.disabled = state.isStreaming;
  scrollBottom();
}

// ── Incremental bubble update (for streaming) ──

export function incBubble(state) {
  const els = dom.msgs.querySelectorAll('.mw.assistant');
  const last = els[els.length - 1];
  if (!last || !state.currentMsg) return;

  const bubble = last.querySelector('.bubble');
  if (!bubble) return;

  const textParts = state.currentMsg.content
    .filter(p => p.type === 'text')
    .map(p => p.text).join('');

  const pills = Array.from(bubble.querySelectorAll('.tp'));
  const dls = Array.from(bubble.querySelectorAll('.dl'));

  let txt = esc(textParts);
  txt = txt.replace(/📄 \*\*([^*]+)\*\* — \[Download\]\(([^)]+)\)\n?/g,
    (m, name, url) => `<a class="dl" href="${esc(url)}" download>⬇ ${esc(name)}</a>`);

  bubble.innerHTML = txt;
  pills.forEach(el => bubble.appendChild(el));
  dls.forEach(el => bubble.appendChild(el));
  scrollBottom();
}

// ── Rerender last message (for tool card updates) ──

export function rerenderLast(state) {
  const els = dom.msgs.querySelectorAll('.mw');
  const last = els[els.length - 1];
  if (!last) return;

  const display = state.currentMsg
    ? [...state.messages, state.currentMsg]
    : state.messages;
  const idx = display.length - 1;
  last.replaceWith(renderMsg(display[idx], idx));
  scrollBottom();
}
