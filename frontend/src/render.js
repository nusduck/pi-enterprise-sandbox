/**
 * DOM rendering helpers for the chat UI.
 */
import { getDownloadUrl } from './api.js';

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

// ── Status bar ──────────────────────────────────

export function setStatus(text, color) {
  dom.status.textContent = text;
  const dot = document.querySelector('.badge .dot');
  if (dot) dot.style.background = color || '#22c55e';
}

let errorTimer = null;
export function flashError(msg) {
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
        <kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> newline
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
