/**
 * PlatformEventProjector pure mapping tests (PR-05).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PlatformEventProjector,
  projectPiEvent,
  PROJECTOR_EVENT_TYPES,
  redactInlineSecrets,
} from '../../src/infrastructure/pi/platform-event-projector.js';

const CTX = {
  runId: '01K0G2PAV8FPMVC9QHJG7JPN53',
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  traceId: 'a'.repeat(32),
};

describe('PlatformEventProjector', () => {
  it('maps message_update text_delta → message.delta', () => {
    const p = new PlatformEventProjector();
    const [ev] = p.project({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    });
    assert.equal(ev.type, 'message.delta');
    assert.equal(ev.payload.delta, 'hello');
  });

  it('message_end → message.completed + tool.call.proposed for toolCall blocks', () => {
    const p = new PlatformEventProjector();
    const events = p.project(
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'x' },
            {
              type: 'toolCall',
              id: 'tc1',
              name: 'bash',
              arguments: { command: 'ls', password: 'secret' },
            },
            {
              type: 'toolCall',
              id: 'tc2',
              name: 'read',
              arguments: { path: 'a' },
            },
          ],
        },
      },
      CTX,
    );
    assert.equal(events[0].type, 'message.completed');
    assert.ok(events[0].payload.message);
    assert.equal(events[1].type, 'tool.call.proposed');
    assert.equal(events[1].payload.toolCallId, 'tc1');
    assert.equal(events[1].payload.args.password, '[redacted]');
    assert.equal(events[2].type, 'tool.call.proposed');
    assert.equal(events[2].payload.toolCallId, 'tc2');
  });

  it('marks a bounded assistant text projection as truncated', () => {
    const [event] = new PlatformEventProjector().project({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'x'.repeat(513) }],
      },
    }, CTX);

    assert.equal(event.type, 'message.completed');
    assert.equal(event.payload.message.textTruncated, true);
    assert.equal(event.payload.message.content[0].truncated, true);
  });

  it('maps tool start/update/end using event fields (stateless)', () => {
    const p = new PlatformEventProjector();
    const events = p.projectMany(
      [
        {
          type: 'tool_execution_start',
          toolCallId: 'tc1',
          toolName: 'bash',
          args: { command: 'echo' },
        },
        {
          type: 'tool_execution_update',
          toolCallId: 'tc1',
          toolName: 'bash',
          partialResult: { line: 1 },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tc1',
          toolName: 'bash',
          isError: false,
          result: 'ok',
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tc2',
          toolName: 'bash',
          isError: true,
          result: 'boom',
        },
      ],
      CTX,
    );
    assert.equal(events[0].type, 'tool.execution.started');
    assert.equal(events[1].type, 'tool.execution.progress');
    assert.equal(events[2].type, 'tool.execution.completed');
    assert.equal(events[3].type, 'tool.execution.failed');
  });

  it('compaction_end success only with result, not aborted, no error', () => {
    const p = new PlatformEventProjector();
    assert.equal(
      p.project({
        type: 'compaction_end',
        reason: 'threshold',
        result: { tokens: 1 },
        aborted: false,
      })[0].type,
      'session.compacted',
    );
    assert.equal(
      p.project({
        type: 'compaction_end',
        reason: 'threshold',
        aborted: true,
      })[0].type,
      'error.occurred',
    );
    assert.equal(
      p.project({
        type: 'compaction_end',
        reason: 'threshold',
        errorMessage: 'fail',
        result: {},
      })[0].type,
      'error.occurred',
    );
    assert.deepEqual(
      p.project({
        type: 'compaction_end',
        reason: 'threshold',
        aborted: false,
      }),
      [],
    );
  });

  it('agent_start/agent_end are not mapped to model.request.*', () => {
    const p = new PlatformEventProjector();
    assert.deepEqual(p.project({ type: 'agent_start' }, CTX), []);
    assert.deepEqual(p.project({ type: 'agent_end', willRetry: true }, CTX), []);
    assert.deepEqual(p.project({ type: 'agent_end', willRetry: false }, CTX), []);
  });

  it('base context includes userId and conversationId', () => {
    const p = new PlatformEventProjector();
    const [ev] = p.project(
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'hi' },
      },
      CTX,
    );
    assert.equal(ev.payload.userId, CTX.userId);
    assert.equal(ev.payload.conversationId, CTX.conversationId);
    assert.equal(ev.payload.orgId, CTX.orgId);
  });

  it('inline secret redaction preserves safe prose containing the word token', () => {
    assert.equal(
      redactInlineSecrets('please use a short token of gratitude'),
      'please use a short token of gratitude',
    );
    assert.match(
      redactInlineSecrets('Authorization: Bearer sk-abc1234567890secret'),
      /\[redacted\]/,
    );
    assert.doesNotMatch(
      redactInlineSecrets('Authorization: Bearer sk-abc1234567890secret'),
      /sk-abc/,
    );
    const p = new PlatformEventProjector();
    const [ev] = p.project({
      type: 'tool_execution_end',
      toolCallId: 't1',
      toolName: 'bash',
      isError: false,
      result: 'Bearer supersecretTOKEN999 and keep me',
    });
    assert.match(String(ev.payload.result.text), /\[redacted\]/);
    assert.match(String(ev.payload.result.text), /keep me/);
  });

  it('redacts credential-bearing URLs and generic token fields', () => {
    for (const value of [
      'mysql://reporter:SuperSecretPassw0rd@db.internal:3306/prod',
      'redis://:redis-password@cache.internal:6379/0',
      'https://svc-user:basic-password@example.test/private',
    ]) {
      const redacted = redactInlineSecrets(value);
      assert.equal(redacted.includes('password'), false);
      assert.equal(redacted.includes('SuperSecretPassw0rd'), false);
      assert.match(redacted, /REDACTED/i);
    }

    const [ev] = new PlatformEventProjector().project({
      type: 'tool_execution_end',
      toolCallId: 't-url-secret',
      toolName: 'mcp__db__query',
      isError: false,
      result: {
        token: 'opaque-secret-value',
        text: 'mysql://user:dsn-password@db.internal/prod',
      },
    });
    const encoded = JSON.stringify(ev);
    assert.doesNotMatch(encoded, /opaque-secret-value|dsn-password/);
  });

  it('unknown → [] and is deterministic', () => {
    assert.deepEqual(projectPiEvent({ type: 'totally_unknown', secret: 'x' }), []);
    const events = [
      { type: 'agent_start' },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'a' },
      },
    ];
    const a = new PlatformEventProjector().projectMany(events, CTX);
    const b = new PlatformEventProjector().projectMany(events, CTX);
    assert.deepEqual(a, b);
    assert.equal(a.length, 1);
    assert.ok(PROJECTOR_EVENT_TYPES.includes('tool.call.proposed'));
    assert.ok(PROJECTOR_EVENT_TYPES.includes('artifact.ready'));
  });
});
