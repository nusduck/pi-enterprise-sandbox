/**
 * P1b：身份边界的本机清理。切号/退出（即使服务端撤销未确认、或 me 返回 401）
 * 必须清掉旧身份的会话/消息/附件/实体入口；失败登录**不**走这里，因此当前
 * 草稿与数据保留。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anonymousState, createState } from '../src/shared/state/index.ts';

function oldIdentityState() {
  const abortCtrl = new AbortController();
  return createState({
    conversationId: 'conv-old',
    sessionId: 'sess-old',
    restoringConversationId: 'conv-old',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'old draft turn' }] }],
    conversations: [{ id: 'conv-old', title: 'old' }],
    artifacts: [{ artifact_id: 'art-old' }],
    attachments: [{
      localId: 'a1', status: 'uploaded', name: 'old.txt', size: 1, mimeType: 'text/plain',
      file: null, attachmentId: 'att-old', path: null, idempotencyKey: 'k1', error: null,
      errorCode: null, traceId: null, progress: 100, abortCtrl,
    }],
    traceId: 'trace-old',
    sidebarOpen: false,
    statusLabel: 'Session sess-old',
    authUser: { username: 'alice' },
    authReady: true,
  });
}

describe('anonymousState', () => {
  it('drops every account-scoped field on the identity boundary', () => {
    const previous = oldIdentityState();
    const next = anonymousState(previous, { statusLabel: 'Logged out' });

    assert.equal(next.conversationId, null);
    assert.equal(next.sessionId, null);
    assert.equal(next.restoringConversationId, null);
    assert.deepEqual(next.messages, []);
    assert.deepEqual(next.conversations, []);
    assert.deepEqual(next.artifacts, []);
    assert.deepEqual(next.attachments, []);
    assert.equal(next.traceId, null);
    assert.equal(next.authUser, null);
    assert.equal(next.authReady, true);
    assert.equal(next.statusLabel, 'Logged out');
    // 旧身份数据不被复用：新状态不共享旧数组引用。
    assert.notEqual(next.messages, previous.messages);
  });

  it('keeps the UI-only sidebar preference and lets callers set a tone', () => {
    const next = anonymousState(oldIdentityState(), {
      statusLabel: 'Signed out',
      statusColor: '#64748b',
    });
    assert.equal(next.sidebarOpen, false);
    assert.equal(next.statusColor, '#64748b');
  });
});
