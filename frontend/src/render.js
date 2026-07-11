/**
 * DOM rendering helpers for the chat UI.
 * Download URLs are prebuilt in main.js (artifact-first, P7) and stored on _fileLinks.
 *
 * Security: untrusted model/tool/filename/error text uses textContent / createTextNode.
 * No inline event-handler attributes. Download hrefs must pass isAllowedApiUrl.
 */

import {
  conversationTitle,
  activeAttachments,
  canSendAttachments,
  hasUploadingAttachments,
} from './state.js';
import { getArtifactDownloadUrl, getDownloadUrl } from './api.js';
import { isAllowedApiUrl, safeApiUrl } from './security.js';

export { isAllowedApiUrl, safeApiUrl };

// ── DOM references (set once during init) ──────
export let dom = {};

export function initDOM(refs) {
  dom = refs;
  // Ensure live region semantics for status/errors
  if (dom.flash) {
    if (!dom.flash.getAttribute('aria-live')) {
      dom.flash.setAttribute('aria-live', 'assertive');
    }
    if (!dom.flash.getAttribute('role')) {
      dom.flash.setAttribute('role', 'status');
    }
  }
  if (dom.status) {
    const badge = dom.status.closest?.('.badge') || dom.status.parentElement;
    if (badge && !badge.getAttribute('aria-live')) {
      badge.setAttribute('aria-live', 'polite');
    }
  }
}

// ── Helpers ─────────────────────────────────────

/** Escape for the rare cases where we still build HTML strings from fixed templates. */
export function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
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

/**
 * Create a download anchor only if the URL passes the same-origin /api allowlist.
 * @param {string} url
 * @param {string} name
 * @param {string} [className='dl']
 * @returns {HTMLAnchorElement|null}
 */
export function createSafeDownloadLink(url, name, className = 'dl') {
  const safe = safeApiUrl(url);
  if (!safe) return null;
  const a = document.createElement('a');
  a.className = className;
  a.href = safe;
  a.download = '';
  a.appendChild(document.createTextNode('⬇ '));
  a.appendChild(document.createTextNode(name == null ? 'file' : String(name)));
  return a;
}

/**
 * Build a tool pill with event listeners (no inline onclick).
 * Untrusted name/args/result go through textContent.
 * @param {object} p tool_use content part
 * @returns {HTMLElement}
 */
export function createToolPill(p) {
  const span = document.createElement('span');
  const st = p.isError ? 'tp-e' : p.status === 'running' ? 'tp-r' : 'tp-d';
  span.className = `tp ${st}`;
  span.setAttribute('role', 'button');
  span.tabIndex = 0;
  span.setAttribute('aria-expanded', 'false');

  if (p.status === 'running') {
    const spinner = document.createElement('span');
    spinner.className = 'tpd';
    spinner.setAttribute('aria-hidden', 'true');
    span.appendChild(spinner);
  }

  const label = document.createElement('span');
  label.className = 'tp-label';
  const icon = p.isError ? '✕' : p.status === 'running' ? '' : '✓';
  label.textContent = `🔧 ${p.name || 'tool'}${icon ? ` ${icon}` : ''}`;
  span.appendChild(label);

  const pop = document.createElement('span');
  pop.className = 'tp-pop hide';
  pop.setAttribute('role', 'tooltip');
  const args = p.input ? JSON.stringify(p.input, null, 2) : '';
  const res = p.result
    ? (typeof p.result === 'string' ? p.result : JSON.stringify(p.result, null, 2))
    : '';
  pop.textContent = args || res || '(no data)';
  span.appendChild(pop);

  const toggle = () => {
    const hidden = pop.classList.toggle('hide');
    span.setAttribute('aria-expanded', hidden ? 'false' : 'true');
  };
  span.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });
  span.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });

  return span;
}

/**
 * Append text content, converting known download-markdown patterns into safe links.
 * Unknown / unsafe URLs are rendered as plain text.
 * @param {HTMLElement} parent
 * @param {string} text
 */
function appendTextWithSafeLinks(parent, text) {
  const re = /📄 \*\*([^*]+)\*\* — \[Download\]\(([^)]+)\)\n?/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    }
    const name = m[1];
    const url = m[2];
    const link = createSafeDownloadLink(url, name);
    if (link) {
      parent.appendChild(link);
    } else {
      // Unsafe URL — show as plain text, never as href
      parent.appendChild(document.createTextNode(m[0]));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parent.appendChild(document.createTextNode(text.slice(last)));
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

/**
 * Show an error in the live region using textContent (no HTML injection).
 * Focuses the flash zone for screen-reader / keyboard awareness.
 */
export function flashError(msg) {
  if (!dom.flash) return;
  // Keep non-error children (e.g. approval banners); replace only flash messages
  for (const el of Array.from(dom.flash.querySelectorAll('.flash'))) {
    el.remove();
  }
  const el = document.createElement('div');
  el.className = 'flash';
  el.setAttribute('role', 'alert');
  el.tabIndex = -1;
  el.textContent = msg == null ? '' : String(msg);
  dom.flash.prepend(el);
  try {
    el.focus({ preventScroll: true });
  } catch {
    /* focus may fail in non-browser test envs */
  }
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    el.remove();
  }, 4000);
}

/**
 * Clear approval banners from the flash zone.
 */
export function clearApprovals() {
  if (!dom.flash) return;
  for (const el of Array.from(dom.flash.querySelectorAll('.approval-banner'))) {
    el.remove();
  }
}

/**
 * Render an accessible approval banner with keyboard-usable actions.
 * @param {{ id: string, reason?: string, onApprove: () => void|Promise<void>, onReject: () => void|Promise<void> }} opts
 * @returns {HTMLElement|null}
 */
export function showApprovalBanner(opts) {
  if (!dom.flash || !opts?.id) return null;
  // One banner per approval id — compare dataset (no attribute-selector interpolation)
  for (const el of Array.from(dom.flash.querySelectorAll('.approval-banner'))) {
    if (el.dataset?.approvalId === opts.id) return el;
  }

  const banner = document.createElement('div');
  banner.className = 'approval-banner';
  banner.setAttribute('role', 'alertdialog');
  banner.setAttribute('aria-modal', 'false');
  banner.dataset.approvalId = opts.id;
  banner.tabIndex = -1;

  // Sanitize id for use as a DOM id / aria-labelledby target
  const safeDomId = `approval-label-${String(opts.id).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const label = document.createElement('span');
  label.id = safeDomId;
  label.textContent = `⚠ Approval required: ${opts.reason || opts.id}`;
  banner.setAttribute('aria-labelledby', safeDomId);
  banner.appendChild(label);

  const btnApprove = document.createElement('button');
  btnApprove.type = 'button';
  btnApprove.className = 'btn-approve';
  btnApprove.textContent = 'Approve';
  btnApprove.addEventListener('click', () => { opts.onApprove?.(); });

  const btnReject = document.createElement('button');
  btnReject.type = 'button';
  btnReject.className = 'btn-reject';
  btnReject.textContent = 'Reject';
  btnReject.addEventListener('click', () => { opts.onReject?.(); });

  banner.appendChild(btnApprove);
  banner.appendChild(btnReject);
  dom.flash.appendChild(banner);

  try {
    btnApprove.focus();
  } catch {
    /* ignore */
  }

  return banner;
}

// ── Welcome screen ──────────────────────────────

export function showWelcome() {
  // Only show if truly empty
  if (dom.msgs.querySelector('.mw')) return;
  // Static trusted template only
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

/**
 * Build a message node with DOM APIs (no untrusted innerHTML / inline handlers).
 * @param {object} msg
 * @param {number} idx
 * @returns {HTMLElement}
 */
export function renderMsg(msg, idx) {
  const div = document.createElement('div');
  const role = msg.role || 'assistant';
  const isUser = role === 'user';
  div.className = `mw ${role}`;
  div.style.animationDelay = `${idx * 40}ms`;

  const av = document.createElement('div');
  av.className = 'av';
  av.textContent = isUser ? '🧑' : '●';
  av.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'body';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const parts = msg.content || [];
  let hasContent = false;

  for (const p of parts) {
    if (p.type === 'text' && p.text) {
      appendTextWithSafeLinks(bubble, p.text);
      // Preserve pre-wrap newlines between text parts
      bubble.appendChild(document.createTextNode('\n'));
      hasContent = true;
    } else if (p.type === 'tool_use') {
      bubble.appendChild(createToolPill(p));
      bubble.appendChild(document.createTextNode(' '));
      hasContent = true;
    }
  }

  if (msg._fileLinks) {
    for (const fl of msg._fileLinks) {
      const link = createSafeDownloadLink(fl.url, fl.name || 'file');
      if (link) {
        bubble.appendChild(link);
        hasContent = true;
      }
    }
  }

  if (!hasContent) {
    const empty = document.createElement('em');
    empty.style.color = '#64748b';
    empty.textContent = '(empty)';
    bubble.appendChild(empty);
  }

  const timeEl = document.createElement('div');
  timeEl.className = 'time';
  timeEl.textContent = time();

  body.appendChild(bubble);
  body.appendChild(timeEl);
  div.appendChild(av);
  div.appendChild(body);
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
    list.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'sidebar-empty';
    empty.innerHTML = 'No conversations yet.<br/>Start a new chat.';
    list.appendChild(empty);
    return;
  }

  list.textContent = '';
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
    del.setAttribute('aria-label', 'Delete conversation');
    del.textContent = '🗑';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onDelete?.(conv.id);
    });

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(del);
    item.addEventListener('click', () => handlers.onSelect?.(conv.id));
    // Keyboard: Enter/Space on focused item
    item.tabIndex = 0;
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handlers.onSelect?.(conv.id);
      }
    });
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
    list.textContent = '';
    if (countEl) countEl.textContent = '0';
    return;
  }

  panel.hidden = false;
  if (countEl) countEl.textContent = String(artifacts.length);
  list.textContent = '';

  for (const a of artifacts) {
    const id = a.artifact_id || a.id;
    const name = a.name || a.path || id || 'file';
    let url = null;
    if (id && state.sessionId) {
      url = getArtifactDownloadUrl(state.sessionId, id);
    } else if (a.path && state.sessionId) {
      url = getDownloadUrl(state.sessionId, a.path);
    }
    const safe = safeApiUrl(url);
    if (!safe) continue;

    const chip = document.createElement('a');
    chip.className = 'artifact-chip';
    chip.href = safe;
    chip.download = '';
    chip.title = a.path || name;
    chip.appendChild(document.createTextNode('⬇ '));
    chip.appendChild(document.createTextNode(String(name)));
    const size = formatSize(a.size);
    if (size) {
      const sizeEl = document.createElement('span');
      sizeEl.className = 'chip-size';
      sizeEl.textContent = ` ${size}`;
      chip.appendChild(sizeEl);
    }
    list.appendChild(chip);
  }
}

// ── Attachment drafts (composer) ────────────────

/**
 * Render composer attachment chips.
 * @param {object} state
 * @param {{ onRemove?: (localId: string) => void, onRetry?: (localId: string) => void }} [handlers]
 */
export function renderAttachmentDrafts(state, handlers = {}) {
  const root = dom.attachmentDrafts || document.getElementById('attachment-drafts');
  if (!root) return;
  // Keep handlers for re-entry from render() without re-passing
  if (handlers.onRemove || handlers.onRetry) {
    root._handlers = handlers;
  }
  const h = root._handlers || handlers;

  const list = activeAttachments(state.attachments);
  root.textContent = '';
  if (!list.length) {
    root.hidden = true;
    return;
  }
  root.hidden = false;

  for (const a of list) {
    const chip = document.createElement('div');
    chip.className = `att-chip att-${a.status}`;
    chip.dataset.localId = a.localId;

    const icon = document.createElement('span');
    icon.className = 'att-icon';
    icon.setAttribute('aria-hidden', 'true');
    if (a.status === 'uploading' || a.status === 'queued') icon.textContent = '⏳';
    else if (a.status === 'uploaded') icon.textContent = '📎';
    else if (a.status === 'failed') icon.textContent = '⚠';
    else icon.textContent = '📎';
    chip.appendChild(icon);

    const meta = document.createElement('span');
    meta.className = 'att-meta';
    const nameEl = document.createElement('span');
    nameEl.className = 'att-name';
    nameEl.textContent = a.name || 'file';
    nameEl.title = a.path || a.name || '';
    meta.appendChild(nameEl);
    const size = formatSize(a.size);
    if (size) {
      const sizeEl = document.createElement('span');
      sizeEl.className = 'att-size';
      sizeEl.textContent = size;
      meta.appendChild(sizeEl);
    }
    if (a.status === 'failed' && a.error) {
      const errEl = document.createElement('span');
      errEl.className = 'att-error';
      const trace = a.traceId ? ` (trace ${a.traceId.slice(0, 8)})` : '';
      errEl.textContent = `${a.error}${trace}`;
      errEl.title = a.errorCode ? `${a.errorCode}: ${a.error}` : a.error;
      meta.appendChild(errEl);
    } else if (a.status === 'uploading' || a.status === 'queued') {
      const st = document.createElement('span');
      st.className = 'att-status';
      st.textContent = a.status === 'queued' ? 'queued' : 'uploading…';
      meta.appendChild(st);
    }
    chip.appendChild(meta);

    const actions = document.createElement('span');
    actions.className = 'att-actions';
    if (a.status === 'failed' && typeof h.onRetry === 'function') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'att-btn att-retry';
      retry.title = 'Retry upload';
      retry.setAttribute('aria-label', `Retry ${a.name}`);
      retry.textContent = '↻';
      retry.addEventListener('click', (e) => {
        e.preventDefault();
        h.onRetry(a.localId);
      });
      actions.appendChild(retry);
    }
    if (typeof h.onRemove === 'function') {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'att-btn att-remove';
      rm.title = 'Remove attachment';
      rm.setAttribute('aria-label', `Remove ${a.name}`);
      rm.textContent = '×';
      rm.addEventListener('click', (e) => {
        e.preventDefault();
        h.onRemove(a.localId);
      });
      actions.appendChild(rm);
    }
    chip.appendChild(actions);
    root.appendChild(chip);
  }
}

/**
 * Update send button enabled/disabled based on stream + attachment gate.
 * @param {object} state
 */
export function updateSendButton(state) {
  if (!dom.send) return;
  dom.send.textContent = state.isStreaming ? '■' : '➤';
  dom.send.className = `btn ${state.isStreaming ? 'btn-stop' : 'btn-send'}`;
  if (state.isStreaming) {
    dom.send.disabled = false;
    dom.send.setAttribute('aria-label', 'Stop generating');
    dom.send.title = 'Stop';
    return;
  }
  const gateOk = canSendAttachments(state.attachments);
  const hasText = !!(dom.input && dom.input.value.trim());
  const hasAtt = activeAttachments(state.attachments).some((a) => a.status === 'uploaded');
  // Disable only when attachments block send; empty text is handled at click time
  // unless attachments are mid-flight/failed.
  const blocked = !gateOk;
  dom.send.disabled = blocked;
  if (blocked) {
    const uploading = hasUploadingAttachments(state.attachments);
    dom.send.title = uploading
      ? 'Wait for uploads to finish'
      : 'Remove or retry failed attachments';
    dom.send.setAttribute('aria-label', dom.send.title);
  } else {
    dom.send.setAttribute('aria-label', 'Send message');
    dom.send.title = hasText || hasAtt ? 'Send (Enter)' : 'Send (Enter)';
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

  updateSendButton(state);
  renderAttachmentDrafts(state);
  if (dom.input) dom.input.disabled = state.isStreaming;

  if (!state.isStreaming && !dom.msgs.querySelector('.mw')) showWelcome();
  scrollBottom();
}

/**
 * Full message area rebuild (used when switching conversations).
 */
export function renderMessagesFull(state) {
  if (!dom.msgs) return;
  dom.msgs.textContent = '';
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
  updateSendButton(state);
  renderAttachmentDrafts(state);
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

  // Preserve tool pills and download links already in the bubble
  const pills = Array.from(bubble.querySelectorAll('.tp'));
  const dls = Array.from(bubble.querySelectorAll('.dl'));

  bubble.textContent = '';
  appendTextWithSafeLinks(bubble, textParts);
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
