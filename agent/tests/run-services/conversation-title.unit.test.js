/**
 * ensureDerivedConversationTitle unit tests (C2 收敛钉子)。
 *
 * 收敛 `create-run-service` / `conversation-service`（列表 + 详情）三处
 * 「占位检查 → 派生」：非占位原样返回，占位才从消息派生。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureDerivedConversationTitle } from '../../src/application/conversation-title.js';

const USER_MESSAGE = [{ role: 'user', content: '分析一下这个问题' }];

describe('ensureDerivedConversationTitle', () => {
  it('derives from the first user message when the current title is a placeholder', () => {
    for (const placeholder of [null, '', 'New chat', 'New conversation', '  new chat  ']) {
      assert.equal(
        ensureDerivedConversationTitle(placeholder, USER_MESSAGE),
        '分析一下这个问题',
      );
    }
  });

  it('keeps a caller-set title untouched (success对照：非占位不派生)', () => {
    assert.equal(
      ensureDerivedConversationTitle('Q3 复盘', USER_MESSAGE),
      'Q3 复盘',
    );
  });

  it('falls back to the default placeholder when messages yield nothing', () => {
    assert.equal(ensureDerivedConversationTitle(null, []), 'New chat');
    assert.equal(
      ensureDerivedConversationTitle('New chat', [{ role: 'assistant', content: 'hi' }]),
      'New chat',
    );
  });
});
