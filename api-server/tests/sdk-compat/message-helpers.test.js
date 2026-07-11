/**
 * Message extract / history helpers used when restoring multi-turn into the SDK.
 * Run: node --test api-server/tests/sdk-compat/message-helpers.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMessageText,
  toAgentHistoryMessages,
  toPersistableMessages,
} from '../../routes/chat.js';

describe('extractMessageText', () => {
  it('handles string content', () => {
    assert.equal(extractMessageText({ role: 'user', content: 'hi' }), 'hi');
  });

  it('joins array content parts', () => {
    assert.equal(
      extractMessageText({
        content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      }),
      'a\nb',
    );
  });

  it('joins parts[] shape', () => {
    assert.equal(extractMessageText({ parts: [{ text: 'x' }, { text: 'y' }] }), 'x\ny');
  });

  it('returns empty for nullish', () => {
    assert.equal(extractMessageText(null), '');
    assert.equal(extractMessageText(undefined), '');
  });
});

describe('toAgentHistoryMessages', () => {
  it('maps user/assistant and skips other roles', () => {
    const out = toAgentHistoryMessages(
      [
        { role: 'user', content: 'u1', timestamp: 1 },
        { role: 'system', content: 'nope' },
        { role: 'assistant', content: 'a1', timestamp: 2 },
        { role: 'user', content: '  ', timestamp: 3 },
      ],
      'test-model',
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].role, 'user');
    assert.equal(out[0].content, 'u1');
    assert.equal(out[1].role, 'assistant');
    assert.equal(out[1].content[0].text, 'a1');
    assert.equal(out[1].model, 'test-model');
    assert.equal(out[1].api, 'openai-completions');
    assert.equal(out[1].stopReason, 'stop');
  });
});

describe('toPersistableMessages', () => {
  it('normalizes to text-only user/assistant', () => {
    const out = toPersistableMessages([
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: 'ans' },
      { role: 'tool', content: 'skip' },
    ]);
    assert.deepEqual(out, [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'ans' },
    ]);
  });
});
