/**
 * Interrupted assistant message badge + normalizeServerMessages.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeServerMessages,
  isInterruptedMessage,
} from '../src/shared/state/index.ts';

describe('interrupted status', () => {
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
    assert.equal(msgs[1].content[0] && 'text' in msgs[1].content[0] ? msgs[1].content[0].text : '', 'partial');
  });

  it('normalizeServerMessages retains durable message ordering metadata', () => {
    const [message] = normalizeServerMessages([{
      role: 'assistant',
      content: 'durable answer',
      message_id: 'msg_01',
      run_id: 'run_01',
      sequence_no: 42,
      created_at: '2026-07-18T06:00:00.123Z',
    }]);

    assert.equal(message._messageId, 'msg_01');
    assert.equal(message._runId, 'run_01');
    assert.equal(message.sequenceNo, 42);
    assert.equal(message.createdAt, '2026-07-18T06:00:00.123Z');
  });

  it('isInterruptedMessage true for interrupted assistant', () => {
    assert.equal(
      isInterruptedMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        interrupted: true,
      }),
      true,
    );
    assert.equal(
      isInterruptedMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        stopReason: 'aborted',
      }),
      true,
    );
  });

  it('isInterruptedMessage false for normal assistant and user', () => {
    assert.equal(
      isInterruptedMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      }),
      false,
    );
    assert.equal(
      isInterruptedMessage({
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
        interrupted: true,
      }),
      false,
    );
  });
});
