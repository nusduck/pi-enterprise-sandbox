/**
 * URL allowlist + rendering security tests.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedApiUrl, safeApiUrl } from '../src/security.js';

describe('isAllowedApiUrl', () => {
  it('accepts same-origin relative /api paths', () => {
    assert.equal(isAllowedApiUrl('/api/files/download?session_id=s&path=a.txt'), true);
    assert.equal(
      isAllowedApiUrl('/api/files/artifact-download?session_id=s&artifact_id=a1'),
      true,
    );
    assert.equal(isAllowedApiUrl('/api/status'), true);
  });

  it('rejects absolute and protocol-relative URLs', () => {
    assert.equal(isAllowedApiUrl('https://evil.example/api/files'), false);
    assert.equal(isAllowedApiUrl('http://localhost/api/files'), false);
    assert.equal(isAllowedApiUrl('//evil.example/api/x'), false);
    assert.equal(isAllowedApiUrl('//api/files'), false);
  });

  it('rejects javascript/data and other schemes', () => {
    assert.equal(isAllowedApiUrl('javascript:alert(1)'), false);
    assert.equal(isAllowedApiUrl('data:text/html,<script>'), false);
    assert.equal(isAllowedApiUrl('vbscript:msgbox(1)'), false);
  });

  it('rejects non-/api paths and empty values', () => {
    assert.equal(isAllowedApiUrl('/files/download'), false);
    assert.equal(isAllowedApiUrl('api/files'), false);
    assert.equal(isAllowedApiUrl(''), false);
    assert.equal(isAllowedApiUrl(null), false);
    assert.equal(isAllowedApiUrl(undefined), false);
    assert.equal(isAllowedApiUrl(42), false);
  });

  it('rejects attribute-breakout characters', () => {
    assert.equal(isAllowedApiUrl('/api/x" onclick="alert(1)'), false);
    assert.equal(isAllowedApiUrl('/api/x\' onerror=\''), false);
    assert.equal(isAllowedApiUrl('/api/x<script>'), false);
    assert.equal(isAllowedApiUrl('/api/x y'), false);
  });

  it('rejects path traversal out of /api/', () => {
    assert.equal(isAllowedApiUrl('/api/../etc/passwd'), false);
    assert.equal(isAllowedApiUrl('/api/files/../../admin'), false);
  });

  it('safeApiUrl returns null for rejected URLs', () => {
    assert.equal(safeApiUrl('javascript:alert(1)'), null);
    assert.equal(safeApiUrl('/api/ok'), '/api/ok');
  });
});

/**
 * Minimal DOM shim so render helpers can run under node:test without jsdom.
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collectElements(root) {
  const out = [];
  const walk = (node) => {
    for (const c of node.children || []) {
      if (c.tagName && c.tagName !== '#TEXT') {
        out.push(c);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

function installMinimalDom() {
  class ClassList {
    constructor(el) {
      this.el = el;
      this._set = new Set();
    }
    _sync() {
      this.el.className = [...this._set].join(' ');
    }
    add(...c) {
      c.forEach((x) => this._set.add(x));
      this._sync();
    }
    remove(...c) {
      c.forEach((x) => this._set.delete(x));
      this._sync();
    }
    toggle(c) {
      if (this._set.has(c)) {
        this._set.delete(c);
        this._sync();
        return false;
      }
      this._set.add(c);
      this._sync();
      return true;
    }
    contains(c) {
      return this._set.has(c);
    }
  }

  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.attributes = {};
      this._text = '';
      this._html = null;
      this.style = {};
      this.listeners = {};
      this.parentNode = null;
      this.className = '';
      this.classList = new ClassList(this);
      this.dataset = {};
      this.tabIndex = 0;
      this.hidden = false;
    }
    set textContent(v) {
      this._text = v == null ? '' : String(v);
      this.children = [];
      this._html = null;
    }
    get textContent() {
      if (this.children.length) {
        return this.children.map((c) => c.textContent).join('');
      }
      return this._text || '';
    }
    set innerHTML(v) {
      this._html = String(v);
      this._text = '';
      this.children = [];
    }
    get innerHTML() {
      if (this._html != null) return this._html;
      if (this.children.length) {
        return this.children.map((c) => {
          if (c.tagName === '#TEXT') return escapeHtml(c._text || '');
          return c.outerHTML;
        }).join('');
      }
      // Mirror browser: textContent → escaped HTML entities
      return escapeHtml(this._text || '');
    }
    get outerHTML() {
      if (this.tagName === '#TEXT') return escapeHtml(this._text || '');
      const attrs = Object.entries(this.attributes)
        .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`)
        .join('');
      const cls = this.className ? ` class="${this.className}"` : '';
      return `<${this.tagName.toLowerCase()}${cls}${attrs}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'class') this.className = String(v);
    }
    getAttribute(k) {
      return this.attributes[k] ?? null;
    }
    appendChild(c) {
      c.parentNode = this;
      this.children.push(c);
      this._html = null;
      return c;
    }
    prepend(c) {
      c.parentNode = this;
      this.children.unshift(c);
      this._html = null;
      return c;
    }
    remove() {
      if (!this.parentNode) return;
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    }
    addEventListener(t, fn) {
      (this.listeners[t] ||= []).push(fn);
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const c of node.children || []) {
          if (match(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    replaceWith(other) {
      if (!this.parentNode) return;
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) {
        this.parentNode.children[i] = other;
        other.parentNode = this.parentNode;
      }
    }
    focus() {}
    closest() {
      return null;
    }
  }

  function match(el, sel) {
    if (sel.startsWith('.')) return el.classList.contains(sel.slice(1)) || el.className.split(/\s+/).includes(sel.slice(1));
    if (sel.startsWith('#')) return el.attributes.id === sel.slice(1);
    if (sel.includes('[')) {
      // [data-approval-id="x"] rough match
      const m = sel.match(/\[([^=\]]+)=["']?([^"'\]]+)["']?\]/);
      if (m) return el.attributes[m[1]] === m[2] || el.dataset?.[m[1].replace(/^data-/, '')] === m[2];
    }
    return el.tagName === sel.toUpperCase();
  }

  const doc = {
    createElement: (tag) => new El(tag),
    createTextNode: (t) => {
      const n = new El('#text');
      n.textContent = t;
      return n;
    },
    querySelector: () => null,
  };

  globalThis.document = doc;
  globalThis.CSS = { escape: (s) => String(s).replace(/"/g, '\\"') };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
  };

  return { El, doc };
}

describe('render security (no inline handlers / injection)', () => {
  let createToolPill;
  let createSafeDownloadLink;
  let renderMsg;
  let esc;

  before(async () => {
    installMinimalDom();
    const render = await import('../src/render.js');
    createToolPill = render.createToolPill;
    createSafeDownloadLink = render.createSafeDownloadLink;
    renderMsg = render.renderMsg;
    esc = render.esc;
  });

  it('escapes HTML entities in esc()', () => {
    assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(esc('"onclick="'), '&quot;onclick=&quot;');
  });

  it('createToolPill does not set onclick attribute', () => {
    const pill = createToolPill({
      name: 'bash"><img onerror=alert(1)>',
      input: { cmd: '"><script>alert(1)</script>' },
      status: 'complete',
      result: '<img src=x onerror=alert(1)>',
    });
    assert.equal(pill.getAttribute('onclick'), null);
    assert.equal(pill.attributes.onclick, undefined);
    // Name is textContent — not HTML
    assert.ok(pill.textContent.includes('bash'));
    // No raw attribute handlers on the element itself
    assert.ok(!Object.keys(pill.attributes).some((k) => k.startsWith('on')));
    // Dangerous markup is escaped in serialized HTML (not live tags)
    assert.ok(pill.outerHTML.includes('&lt;script&gt;') || pill.textContent.includes('<script>'));
    assert.ok(!/<script>/i.test(pill.outerHTML));
    // Has real listeners instead of inline handlers
    assert.ok(pill.listeners.click?.length >= 1);
    assert.ok(pill.listeners.keydown?.length >= 1);
    // Keyboard operable
    assert.equal(pill.getAttribute('role'), 'button');
    assert.equal(pill.tabIndex, 0);
  });

  it('createSafeDownloadLink rejects javascript: and external URLs', () => {
    assert.equal(createSafeDownloadLink('javascript:alert(1)', 'x'), null);
    assert.equal(createSafeDownloadLink('https://evil.example/a', 'x'), null);
    assert.equal(createSafeDownloadLink('//evil/api/x', 'x'), null);

    const ok = createSafeDownloadLink('/api/files/download?session_id=s&path=a', 'report.txt');
    assert.ok(ok);
    assert.equal(ok.href, '/api/files/download?session_id=s&path=a');
    assert.ok(ok.textContent.includes('report.txt'));
    // Filename is text, not HTML
    const evil = createSafeDownloadLink('/api/files/download?session_id=s&path=a', '<script>x</script>');
    assert.ok(evil);
    assert.ok(evil.textContent.includes('<script>x</script>'));
    assert.ok(!evil.outerHTML.includes('onclick='));
  });

  it('renderMsg treats model injection as text, not handlers', () => {
    const msg = {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Hello <script>alert(1)</script> <img src=x onerror=alert(1)>',
        },
        {
          type: 'tool_use',
          name: 'evil" onclick="alert(1)',
          input: { a: '<script>' },
          status: 'complete',
          result: '<img onerror=alert(1)>',
        },
      ],
      _fileLinks: [
        { name: 'bad" onclick="alert(1)', url: 'javascript:alert(1)' },
        { name: 'good.txt', url: '/api/files/artifact-download?session_id=s&artifact_id=1' },
      ],
    };
    const node = renderMsg(msg, 0);
    // Collect all elements and ensure none have on* attributes
    const all = [node, ...collectElements(node)];
    for (const el of all) {
      for (const key of Object.keys(el.attributes || {})) {
        assert.ok(!/^on/i.test(key), `unexpected handler attr ${key}`);
      }
    }
    // Script tags from model text must not appear as real elements
    assert.ok(!all.some((el) => el.tagName === 'SCRIPT'));
    // Unsafe download dropped
    const dls = node.querySelectorAll('.dl');
    assert.equal(dls.length, 1);
    assert.equal(dls[0].href.startsWith('/api/'), true);
    // Tool pill present without inline handler
    const pills = node.querySelectorAll('.tp');
    assert.equal(pills.length, 1);
    assert.equal(pills[0].getAttribute('onclick'), null);
    assert.ok(pills[0].listeners.click?.length >= 1);
  });

  it('markdown download with unsafe URL is not turned into a link', () => {
    const msg = {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '📄 **evil** — [Download](javascript:alert(1))\n📄 **ok** — [Download](/api/files/download?session_id=s&path=f)\n',
        },
      ],
    };
    const node = renderMsg(msg, 0);
    const dls = node.querySelectorAll('.dl');
    assert.equal(dls.length, 1);
    assert.equal(dls[0].href.startsWith('/api/'), true);
    assert.ok(node.textContent.includes('javascript:alert(1)') || node.textContent.includes('evil'));
  });
});

describe('accessibility surfaces', () => {
  it('flash zone and tool pills expose keyboard/live semantics', async () => {
    installMinimalDom();
    const render = await import('../src/render.js');
    // Re-init with a flash zone
    const flash = document.createElement('div');
    flash.id = 'flash-zone';
    const status = document.createElement('span');
    status.id = 'status-label';
    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.appendChild(status);

    // Patch closest for status badge
    status.closest = (sel) => (sel === '.badge' ? badge : null);

    render.initDOM({
      flash,
      status,
      msgs: document.createElement('div'),
      send: document.createElement('button'),
      input: document.createElement('textarea'),
    });

    assert.equal(flash.getAttribute('aria-live'), 'assertive');
    assert.equal(flash.getAttribute('role'), 'status');

    render.flashError('Boom <script>alert(1)</script>');
    const flashEl = flash.children.find((c) => c.className === 'flash') || flash.querySelector('.flash');
    assert.ok(flashEl);
    assert.equal(flashEl.getAttribute('role'), 'alert');
    // textContent, not HTML
    assert.equal(flashEl.textContent, 'Boom <script>alert(1)</script>');
    assert.equal(flashEl.innerHTML, 'Boom &lt;script&gt;alert(1)&lt;/script&gt;');

    const banner = render.showApprovalBanner({
      id: 'ap-1',
      reason: 'rm -rf / <script>',
      onApprove: () => {},
      onReject: () => {},
    });
    assert.ok(banner);
    assert.equal(banner.getAttribute('role'), 'alertdialog');
    // Our querySelectorAll is class/tag based — check children
    const kids = banner.children.filter((c) => c.tagName === 'BUTTON');
    assert.equal(kids.length, 2);
    assert.equal(kids[0].type, 'button');
    assert.equal(kids[1].type, 'button');
    assert.ok(kids[0].listeners.click?.length >= 1);
    // Reason is text
    assert.ok(banner.textContent.includes('rm -rf / <script>'));
  });
});
