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
} from '../src/shared/state/index.ts';

describe('createState / update', () => {
  it('copies UI snapshot arrays without runtime entity fields', () => {
    const s = createState(INITIAL);
    assert.deepEqual(s.conversations, []);
    assert.equal(s.streamGeneration, 0);
    assert.equal('currentMsg' in s, false);
    assert.equal('pendingApproval' in s, false);
    assert.equal('pendingTool' in s, false);
    assert.equal('readyFiles' in s, false);
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
    assert.equal(s.streamGeneration, 1);
  });

  it('endStream clears streaming flags', () => {
    let s = createState(INITIAL);
    s = startStream(s);
    s = endStream(s, { messages: [{ role: 'user', content: [] }] });
    assert.equal(s.isStreaming, false);
    assert.equal(s.abortCtrl, null);
    assert.equal(s.messages.length, 1);
  });

  it('abortStream aborts controller and bumps generation', () => {
    let s = createState(INITIAL);
    s = startStream(s);
    const gen = s.streamGeneration;
    const ctrl = s.abortCtrl;
    s = abortStream(s);
    assert.equal(ctrl?.signal.aborted, true);
    assert.equal(s.isStreaming, false);
    assert.equal(s.abortCtrl, null);
    assert.equal(s.streamGeneration, gen + 1);
  });

  it('errorStream ends streaming without requiring abort', () => {
    let s = createState(INITIAL);
    s = startStream(s);
    s = errorStream(s);
    assert.equal(s.isStreaming, false);
    assert.equal(s.abortCtrl, null);
  });

  it('clearEphemeral drops non-runtime UI snapshots', () => {
    let s = createState(INITIAL);
    s = update(s, {
      artifacts: [{ id: 'art1' }],
      traceId: 't1',
    });
    s = clearEphemeral(s);
    assert.deepEqual(s.artifacts, []);
    assert.equal(s.traceId, null);
  });
});

describe('conversation switch mid-stream', () => {
  it('switchConversation aborts stream and clears ephemeral state', () => {
    let s = createState(INITIAL);
    s = startStream(s);
    const ctrl = s.abortCtrl;
    const gen = s.streamGeneration;
    s = switchConversation(s, {
      conversationId: 'c2',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: 'sess-2',
    });
    assert.equal(ctrl?.signal.aborted, true);
    assert.equal(s.isStreaming, false);
    assert.equal(s.conversationId, 'c2');
    assert.equal(s.messages.length, 1);
    assert.equal(s.sessionId, 'sess-2');
    assert.deepEqual(s.artifacts, []);
    assert.deepEqual(s.attachments, []);
    assert.ok(s.streamGeneration > gen);
  });

  it('isActiveGeneration ignores late events after abort', () => {
    let s = createState(INITIAL);
    s = startStream(s);
    const gen = s.streamGeneration;
    assert.equal(isActiveGeneration(s, gen), true);
    s = abortStream(s);
    assert.equal(isActiveGeneration(s, gen), false);
    assert.equal(isActiveGeneration(s, s.streamGeneration), true);
  });
});
