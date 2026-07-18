import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPlatformEventType,
  makePlatformEventEnvelope,
  parsePlatformEventEnvelope,
  PLATFORM_EVENT_TYPES,
  PLATFORM_EVENT_VERSION,
} from '../src/events/index.ts';

const CONTEXT = {
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN53',
  traceId: 'b7e1f3a2c4d5060708090a0b0c0d0e0f',
  spanId: '91a2b3c4d5e6f708',
};

describe('platform event types (§15.2)', () => {
  it('includes the full catalog', () => {
    const required = [
      'run.accepted',
      'run.queued',
      'run.started',
      'run.status.changed',
      'run.completed',
      'run.failed',
      'run.cancelled',
      'message.created',
      'message.delta',
      'message.completed',
      'model.request.started',
      'model.request.completed',
      'model.request.failed',
      'tool.call.proposed',
      'tool.execution.started',
      'tool.execution.progress',
      'tool.execution.completed',
      'tool.execution.failed',
      'process.started',
      'process.output',
      'process.completed',
      'process.failed',
      'process.cancelled',
      'approval.requested',
      'approval.resolved',
      'dataset.upload.started',
      'dataset.upload.progress',
      'dataset.ready',
      'dataset.failed',
      'artifact.ready',
      'session.snapshot.saved',
      'session.compacted',
      'error.occurred',
    ];
    for (const t of required) {
      assert.ok(isPlatformEventType(t), t);
      assert.ok((PLATFORM_EVENT_TYPES as readonly string[]).includes(t), t);
    }
    assert.equal(isPlatformEventType('tool.started'), false); // old name, not platform catalog
  });
});

describe('platform event envelope (§15.3)', () => {
  it('accepts a full envelope', () => {
    const raw = {
      eventId: '01K0G2PAV8FPMVC9QHJG7JPN60',
      eventVersion: PLATFORM_EVENT_VERSION,
      sequence: 18,
      type: 'tool.execution.completed',
      timestamp: '2026-07-18T04:31:22.417Z',
      context: CONTEXT,
      data: { toolName: 'bash', exitCode: 0 },
    };
    const parsed = parsePlatformEventEnvelope(raw);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value.sequence, 18);
      assert.equal(parsed.value.type, 'tool.execution.completed');
      assert.equal(parsed.value.context.traceId, CONTEXT.traceId);
      assert.equal(parsed.value.data.toolName, 'bash');
    }
  });

  it('rejects missing required fields and invalid type', () => {
    assert.equal(
      parsePlatformEventEnvelope({
        eventId: '01K0G2PAV8FPMVC9QHJG7JPN60',
        sequence: 1,
        type: 'tool.execution.completed',
      }).ok,
      false,
    );
    assert.equal(
      parsePlatformEventEnvelope({
        eventId: '01K0G2PAV8FPMVC9QHJG7JPN60',
        eventVersion: 1,
        sequence: 1,
        type: 'not.a.real.event',
        timestamp: '2026-07-18T04:31:22.417Z',
        context: CONTEXT,
        data: {},
      }).ok,
      false,
    );
  });

  it('makePlatformEventEnvelope fills data default and validates', () => {
    const ev = makePlatformEventEnvelope({
      eventId: '01K0G2PAV8FPMVC9QHJG7JPN61',
      sequence: 0,
      type: 'run.accepted',
      timestamp: '2026-07-18T04:31:22.417Z',
      context: {
        orgId: CONTEXT.orgId,
        userId: CONTEXT.userId,
        traceId: CONTEXT.traceId,
        spanId: CONTEXT.spanId,
        runId: CONTEXT.runId,
      },
    });
    assert.deepEqual(ev.data, {});
    assert.equal(ev.eventVersion, 1);
  });

  it('formatPlatformEventSse / parseLastEventId (PR-10)', async () => {
    const { formatPlatformEventSse, formatSsePing, parseLastEventId } =
      await import('../src/events/sse.ts');
    const ev = makePlatformEventEnvelope({
      eventId: '01K0G2PAV8FPMVC9QHJG7JPN61',
      sequence: 18,
      type: 'tool.execution.completed',
      timestamp: '2026-07-18T04:31:22.417Z',
      context: {
        orgId: CONTEXT.orgId,
        userId: CONTEXT.userId,
        traceId: CONTEXT.traceId,
        spanId: CONTEXT.spanId,
        runId: CONTEXT.runId,
      },
      data: { toolName: 'bash' },
    });
    const frame = formatPlatformEventSse(ev);
    assert.match(frame, /^id: 01K0G2PAV8FPMVC9QHJG7JPN61\n/);
    assert.match(frame, /event: tool\.execution\.completed\n/);
    assert.match(frame, /"sequence":18/);
    assert.match(formatSsePing('2026-07-18T00:00:00.000Z'), /event: ping/);
    assert.deepEqual(parseLastEventId('18'), { sequence: 18, eventId: null });
    assert.deepEqual(parseLastEventId('01K0G2PAV8FPMVC9QHJG7JPN61'), {
      sequence: null,
      eventId: '01K0G2PAV8FPMVC9QHJG7JPN61',
    });
  });
});
