import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EntityBridge } from '../src/features/chat/entityBridge.ts';
import {
  queueConversationFollowUp,
  reconcileCancelledRun,
} from '../src/features/chat/controllers/useRunControls.ts';

describe('follow-up Run controller', () => {
  it('registers the returned Run and starts its SSE lifecycle', async () => {
    const beginCalls: unknown[] = [];
    const connected: string[] = [];
    const bridge = {
      getStore: () => ({
        activeRunId: 'run-current',
        runsById: {
          'run-current': {
            agentSessionId: 'agent-session-current',
            sandboxSessionId: 'sandbox-session-current',
          },
        },
      }),
      beginRun: (opts: unknown) => {
        beginCalls.push(opts);
        return 'run-next';
      },
      manager: {
        connect: (runId: string) => connected.push(runId),
      },
    } as unknown as EntityBridge;

    const result = await queueConversationFollowUp({
      bridge,
      conversationId: 'conversation-current',
      text: 'continue with the report',
      localMessageId: 'local-follow-1',
      request: async (conversationId, body) => {
        assert.equal(conversationId, 'conversation-current');
        assert.deepEqual(body, { text: 'continue with the report' });
        return {
          run_id: 'run-next',
          conversation_id: 'conversation-current',
          agent_session_id: 'agent-session-returned',
          status: 'ACCEPTED',
        };
      },
    });

    assert.equal(result.runId, 'run-next');
    assert.equal(result.localMessageId, 'local-follow-1');
    assert.deepEqual(beginCalls, [{
      runId: 'run-next',
      conversationId: 'conversation-current',
      agentSessionId: 'agent-session-returned',
      sessionId: 'sandbox-session-current',
    }]);
    assert.deepEqual(connected, ['run-next']);
  });
});

describe('stop Run reconciliation', () => {
  it('keeps polling after cancelling until the durable Run is terminal', async () => {
    const snapshots = [
      { status: 'cancel_requested' },
      { status: 'cancelled' },
    ];
    const statusReads: string[] = [];
    const reconcileCalls: string[] = [];
    let waits = 0;
    const bridge = {
      reconcileRun: async (runId: string) => {
        reconcileCalls.push(runId);
        return { status: 'cancelled' } as never;
      },
    } as unknown as Pick<EntityBridge, 'reconcileRun'>;

    const latest = await reconcileCancelledRun({
      bridge,
      runId: 'run-stop',
      readStatus: async () => {
        const next = snapshots.shift() || { status: 'cancelled' };
        statusReads.push(next.status);
        return next.status;
      },
      wait: async () => {
        waits += 1;
      },
    });

    assert.equal(latest?.status, 'cancelled');
    assert.deepEqual(statusReads, ['cancel_requested', 'cancelled']);
    assert.deepEqual(reconcileCalls, ['run-stop']);
    assert.equal(waits, 1);
  });
});
