/**
 * State transition tests — stream lifecycle, conversation switch, generation token.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL,
  createState,
  update,
  startStream,
  endStream,
  abortStream,
  errorStream,
  clearEphemeral,
  switchConversation,
  isActiveGeneration,
} from '../src/state.js';

describe('createState / update', () => {
  it('copies Set and arrays', () => {
    const s = createState(INITIAL);
    assert.ok(s.readyFiles instanceof Set);
    assert.deepEqual(s.conversations, []);
    assert.equal(s.streamGeneration, 0);
  });

  it('update notifies only changed keys via return value', () => {
    let s = createState(INITIAL);
    s = update(s, { sessionId: 'abc' });
    assert.equal(s.sessionId, 'abc');
    assert.equal(s.isStreaming, false);
  });
});

describe('stream transitions', () => {
  it('startStream sets streaming flags and bumps generation', () => {
    let s = createState(INITIAL);
    s = startStream(s);
    assert.equal(s.isStreaming, true);
    assert.ok(s.abortCtrl instanceof AbortController);
    assert.equal(s.currentMsg.role, 'assistant');
    assert.equal(s.streamGeneration, 1);
    assert.equal(s.pendingTool, null);
    assert.equal(s.pendingApproval, null);
    assert.equal(s.readyFiles.size, 0);
  });

  it('endStream clears streaming flags', () => {
    let s = createState(INITIAL);
    s = startStream(s);
    s = endStream(s, { messages: [{ role: 'user', content: [] }] });
    assert.equal(s.isStreaming, false);
    assert.equal(s.abortCtrl, null);
    assert.equal(s.currentMsg, null);
    assert.equal(s.messages.length, 1);
  });

  it('abortStream aborts controller and bumps generation', () => {
    let s = createState(INITIAL);
    s = startStream(s);
    const gen = s.streamGeneration;
    const ctrl = s.abortCtrl;
    s = abortStream(s, { currentMsg: null });
    assert.equal(ctrl.signal.aborted, true);
    assert.equal(s.isStreaming, false);
    assert.equal(s.abortCtrl, null);
    assert.equal(s.streamGeneration, gen + 1);
    assert.equal(s.pendingApproval, null);
  });

  it('errorStream ends streaming without requiring abort', () => {
    let s = createState(INITIAL);
    s = startStream(s);
    s = errorStream(s, { currentMsg: null });
    assert.equal(s.isStreaming, false);
    assert.equal(s.abortCtrl, null);
  });

  it('clearEphemeral drops tokens/approvals/artifacts', () => {
    let s = createState(INITIAL);
    s = update(s, {
      currentMsg: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
      pendingTool: { id: '1', name: 'bash' },
      pendingApproval: { id: 'a1' },
      readyFiles: new Set(['f1']),
      artifacts: [{ id: 'art1' }],
      traceId: 't1',
    });
    s = clearEphemeral(s);
    assert.equal(s.currentMsg, null);
    assert.equal(s.pendingTool, null);
    assert.equal(s.pendingApproval, null);
    assert.equal(s.readyFiles.size, 0);
    assert.deepEqual(s.artifacts, []);
    assert.equal(s.traceId, null);
  });
});

describe('conversation switch mid-stream', () => {
  it('switchConversation aborts stream and clears ephemeral state', () => {
    let s = createState(INITIAL);
    s = startStream(s);
    s = update(s, {
      conversationId: 'conv-old',
      sessionId: 'sess-old',
      pendingTool: { id: 't1', name: 'bash' },
      pendingApproval: { id: 'ap1', reason: 'rm -rf' },
      readyFiles: new Set(['file1']),
      artifacts: [{ artifact_id: 'a1', name: 'out.txt' }],
      currentMsg: { role: 'assistant', content: [{ type: 'text', text: 'stale' }] },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    const genBefore = s.streamGeneration;
    const ctrl = s.abortCtrl;

    s = switchConversation(s, {
      conversationId: 'conv-new',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'other' }] }],
      sessionId: 'sess-new',
    });

    assert.equal(ctrl.signal.aborted, true);
    assert.equal(s.conversationId, 'conv-new');
    assert.equal(s.sessionId, 'sess-new');
    assert.equal(s.isStreaming, false);
    assert.equal(s.abortCtrl, null);
    assert.equal(s.currentMsg, null);
    assert.equal(s.pendingTool, null);
    assert.equal(s.pendingApproval, null);
    assert.equal(s.readyFiles.size, 0);
    assert.deepEqual(s.artifacts, []);
    assert.equal(s.traceId, null);
    assert.equal(s.streamGeneration, genBefore + 1);
    assert.equal(s.messages[0].content[0].text, 'other');
  });

  it('isActiveGeneration rejects late events after switch', () => {
    let s = createState(INITIAL);
    s = startStream(s);
    const gen = s.streamGeneration;
    assert.equal(isActiveGeneration(s, gen), true);

    s = switchConversation(s, { conversationId: 'other', messages: [] });
    assert.equal(isActiveGeneration(s, gen), false);
    assert.equal(isActiveGeneration(s, s.streamGeneration), true);
  });

  it('blank new-chat switch clears conversation id and session', () => {
    let s = createState({
      ...INITIAL,
      conversationId: 'c1',
      sessionId: 's1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    });
    s = switchConversation(s, {});
    assert.equal(s.conversationId, null);
    assert.equal(s.sessionId, null);
    assert.deepEqual(s.messages, []);
  });
});
