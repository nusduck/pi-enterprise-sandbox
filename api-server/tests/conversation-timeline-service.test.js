import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConversationTimeline,
  presentPersistedTimelineEvent,
} from '../src/application/conversation-timeline-service.js';

describe('conversation timeline', () => {
  it('loads every run in chronological order with all persisted events', async () => {
    const client = {
      async listAgentRuns() {
        return [
          { run_id: 'run-2', status: 'completed', created_at: '2026-07-14T02:00:00Z' },
          { run_id: 'run-1', status: 'completed', created_at: '2026-07-14T01:00:00Z' },
        ];
      },
      async listAgentEvents(runId) {
        return [{
          run_id: runId,
          event_id: `event-${runId}`,
          sequence: 1,
          type: 'run.completed',
          payload: { status: 'SUCCEEDED' },
        }];
      },
    };
    const timeline = await loadConversationTimeline(client, 'conversation-1');
    assert.deepEqual(timeline.runs.map((run) => run.run_id), ['run-1', 'run-2']);
    assert.deepEqual(timeline.events.map((event) => event.run_id), ['run-1', 'run-2']);
    assert.equal(timeline.last_run.run_id, 'run-2');
  });

  it('flattens the real Agent history envelope without losing platform context', () => {
    const projected = presentPersistedTimelineEvent(
      {
        sequence: 7,
        eventId: '01KXVBPS42G7MSP6Y52NG5CQWH',
        ts: 1784374620290,
        event: {
          type: 'model.request.completed',
          eventId: '01KXVBPS42G7MSP6Y52NG5CQWH',
          data: { durationMs: 16, modelId: 'gpt-5' },
          context: { runId: 'run-live', traceId: 'a'.repeat(32) },
        },
      },
      'run-fallback',
    );

    assert.equal(projected.run_id, 'run-live');
    assert.equal(projected.sequence, 7);
    assert.equal(projected.type, 'model.request.completed');
    assert.deepEqual(projected.payload.data, { durationMs: 16, modelId: 'gpt-5' });
    assert.equal(projected.payload.context.traceId, 'a'.repeat(32));
    assert.match(projected.created_at, /^2026-/);
  });

  it('fails closed when Agent history omits durable event identity', () => {
    assert.throws(
      () => presentPersistedTimelineEvent({ sequence: 1, event: {} }, 'run-1'),
      (error) => error?.status === 502 && error?.code === 'AGENT_EVENT_CONTRACT_INVALID',
    );
  });
});
