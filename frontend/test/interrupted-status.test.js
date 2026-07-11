/**
 * Interrupted assistant message badge + normalizeServerMessages.
 * Run: node --test frontend/test/interrupted-status.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('interrupted status', () => {
  let normalizeServerMessages;
  let renderMsg;
  let document;

  before(async () => {
    // Minimal DOM shim
    document = {
      createElement(tag) {
        const el = {
          tagName: String(tag).toUpperCase(),
          className: '',
          style: {},
          children: [],
          attributes: {},
          textContent: '',
          setAttribute(k, v) {
            this.attributes[k] = v;
          },
          getAttribute(k) {
            return this.attributes[k];
          },
          appendChild(child) {
            this.children.push(child);
            return child;
          },
          querySelector() {
            return null;
          },
          querySelectorAll() {
            return [];
          },
        };
        return el;
      },
      createTextNode(t) {
        return { nodeType: 3, textContent: String(t) };
      },
    };
    globalThis.document = document;

    const state = await import('../src/state.js');
    normalizeServerMessages = state.normalizeServerMessages;
    const render = await import('../src/render.js');
    renderMsg = render.renderMsg;
  });

  it('normalizeServerMessages preserves interrupted flag', () => {
    const msgs = normalizeServerMessages([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'partial',
        interrupted: true,
        status: 'interrupted',
      },
    ]);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[1].interrupted, true);
    assert.equal(msgs[1].status, 'interrupted');
    assert.equal(msgs[1].content[0].text, 'partial');
  });

  it('renderMsg shows interrupted badge for assistant', () => {
    const node = renderMsg(
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        interrupted: true,
      },
      0,
    );
    // Find badge in tree
    const flat = [];
    const walk = (n) => {
      if (!n) return;
      flat.push(n);
      for (const c of n.children || []) walk(c);
    };
    walk(node);
    const badge = flat.find(
      (el) =>
        typeof el.className === 'string' &&
        el.className.includes('msg-status-interrupted'),
    );
    assert.ok(badge, 'expected interrupted badge element');
    assert.equal(badge.textContent, 'interrupted');
  });

  it('renderMsg omits badge for normal assistant', () => {
    const node = renderMsg(
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      },
      0,
    );
    const flat = [];
    const walk = (n) => {
      if (!n) return;
      flat.push(n);
      for (const c of n.children || []) walk(c);
    };
    walk(node);
    const badge = flat.find(
      (el) =>
        typeof el.className === 'string' &&
        el.className.includes('msg-status-interrupted'),
    );
    assert.equal(badge, undefined);
  });
});
