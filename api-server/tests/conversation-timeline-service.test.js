import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConversationTimeline } from '../application/conversation-timeline-service.js';

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
        return [{ run_id: runId, event_id: `event-${runId}`, sequence: 1 }];
      },
    };
    const timeline = await loadConversationTimeline(client, 'conversation-1');
    assert.deepEqual(timeline.runs.map((run) => run.run_id), ['run-1', 'run-2']);
    assert.deepEqual(timeline.events.map((event) => event.run_id), ['run-1', 'run-2']);
    assert.equal(timeline.last_run.run_id, 'run-2');
  });
});
