/**
 * Message bubble action helpers: copy text extraction, regenerate source
 * lookup, scroll-to-bottom gating and memo fingerprints.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  findRegenerateSource,
  lastAssistantIndex,
  messageFingerprint,
  messagePlainText,
  shouldShowJumpToBottom,
} from '../src/widgets/message-list/messageActions.ts';
import type { ChatMessage } from '../src/shared/state/types.ts';

function userMsg(text: string, id = `u-${text.slice(0, 6)}`): ChatMessage {
  return { role: 'user', content: [{ type: 'text', text }], _messageId: id };
}

function asstMsg(text: string, id = `a-${text.slice(0, 6)}`): ChatMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    _messageId: id,
  };
}

describe('messagePlainText', () => {
  it('joins text parts and ignores non-text parts', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'tool_use', id: 't1', name: 'bash', input: {} },
        { type: 'text', text: 'world' },
      ],
    };
    assert.equal(messagePlainText(msg), 'Hello world');
  });

  it('returns empty string when there is no text', () => {
    assert.equal(messagePlainText(asstMsg('')), '');
  });
});

describe('lastAssistantIndex / findRegenerateSource', () => {
  it('finds the last assistant bubble', () => {
    const msgs = [userMsg('a'), asstMsg('x'), userMsg('b'), asstMsg('y')];
    assert.equal(lastAssistantIndex(msgs), 3);
    assert.equal(lastAssistantIndex([userMsg('only')]), -1);
    assert.equal(lastAssistantIndex([]), -1);
  });

  it('regenerate source is the nearest preceding user text', () => {
    const msgs = [userMsg('first question'), asstMsg('answer'), userMsg('second'), asstMsg('reply')];
    assert.equal(findRegenerateSource(msgs, 3), 'second');
    assert.equal(findRegenerateSource(msgs, 1), 'first question');
  });

  it('returns null when no preceding user turn has text', () => {
    assert.equal(findRegenerateSource([asstMsg('orphan')], 0), null);
    assert.equal(
      findRegenerateSource([userMsg('   '), asstMsg('blank user skipped')], 1),
      null,
    );
  });
});

describe('shouldShowJumpToBottom', () => {
  it('shows only when scrolled away from the bottom with messages present', () => {
    assert.equal(shouldShowJumpToBottom(500), true);
    assert.equal(shouldShowJumpToBottom(121), true);
    assert.equal(shouldShowJumpToBottom(120), false);
    assert.equal(shouldShowJumpToBottom(10), false);
  });

  it('never shows for an empty transcript', () => {
    assert.equal(shouldShowJumpToBottom(9999, { hasMessages: false }), false);
  });
});

describe('messageFingerprint (memo comparator)', () => {
  it('matches structurally equal messages even when identities differ', () => {
    // Projection layers rebuild bubble objects on every store tick; the
    // fingerprint lets React.memo skip re-renders when nothing changed.
    assert.equal(
      messageFingerprint(asstMsg('same', 'id-1')),
      messageFingerprint(asstMsg('same', 'id-2')),
    );
  });

  it('diverges on role, text, thinking or interruption changes', () => {
    const base = asstMsg('hello');
    assert.notEqual(
      messageFingerprint(base),
      messageFingerprint(asstMsg('hello!')),
    );
    assert.notEqual(
      messageFingerprint(base),
      messageFingerprint(userMsg('hello')),
    );
    const thinking = asstMsg('hello');
    thinking.thinking = 'reasoning…';
    assert.notEqual(messageFingerprint(base), messageFingerprint(thinking));
    const interrupted = asstMsg('hello');
    interrupted.interrupted = true;
    assert.notEqual(messageFingerprint(base), messageFingerprint(interrupted));
  });

  it('diverges when the attachment list grows', () => {
    const base = userMsg('with file');
    const withFile: ChatMessage = {
      ...base,
      attachments: [{ attachment_id: 'f1', filename: 'a.txt' }],
    };
    assert.notEqual(messageFingerprint(base), messageFingerprint(withFile));
  });
});

describe('chat UX surfaces (static structure)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const readSrc = (...parts: string[]) =>
    readFileSync(join(here, '..', 'src', ...parts), 'utf8');

  it('MessageList offers a labelled jump-to-latest control', () => {
    const list = readSrc('widgets', 'message-list', 'MessageList.tsx');
    assert.match(list, /className="jump-to-bottom"/);
    assert.match(list, /aria-label=["']Jump to latest messages["']/);
    assert.match(list, /shouldShowJumpToBottom\(/);
    const css = readSrc('shared', 'styles', 'app.css');
    assert.match(css, /\.jump-to-bottom/);
    assert.match(css, /position:\s*sticky/);
  });

  it('assistant bubbles expose copy + regenerate actions', () => {
    const bubble = readSrc('widgets', 'message-list', 'MessageBubble.tsx');
    assert.match(bubble, /aria-label=["']Copy message text["']/);
    assert.match(bubble, /aria-label=["']Regenerate answer["']/);
    assert.match(bubble, /messagePlainText\(msg\)/);
    const css = readSrc('shared', 'styles', 'app.css');
    assert.match(css, /\.msg-actions/);
    assert.match(css, /\.msg-action-btn/);
  });

  it('MessageBubble is memoized with a content fingerprint comparator', () => {
    const bubble = readSrc('widgets', 'message-list', 'MessageBubble.tsx');
    assert.match(bubble, /export const MessageBubble = memo\(/);
    assert.match(bubble, /messageFingerprint\(prev\.msg\) === messageFingerprint\(next\.msg\)/);
    // Context subscription inside the bubble would defeat memo entirely.
    assert.doesNotMatch(
      bubble,
      /useChat\(\)/,
      'MessageBubble must stay context-free for React.memo to hold',
    );
  });
});
