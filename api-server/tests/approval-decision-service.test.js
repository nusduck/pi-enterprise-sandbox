import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideApprovalAndResume } from '../application/approval-decision-service.js';

describe('approval decision workflow', () => {
  it('retries a transient Agent notification after persisting once', async () => {
    let persisted = 0;
    let notified = 0;
    const outcome = await decideApprovalAndResume({
      sandbox: {
        async decideApproval() {
          persisted += 1;
          return { payload: { run_id: 'run-1' } };
        },
      },
      async notifyAgent(_id, payload) {
        notified += 1;
        assert.equal(payload.run_id, 'run-1');
        if (notified === 1) throw new Error('temporary outage');
        return { ok: true };
      },
      approvalId: 'approval-1',
      decision: 'approve',
    });
    assert.equal(persisted, 1);
    assert.equal(notified, 2);
    assert.equal(outcome.resumePending, false);
  });

  it('reports a durable pending state instead of hiding resume failure', async () => {
    const outcome = await decideApprovalAndResume({
      sandbox: { async decideApproval() { return { ok: true }; } },
      async notifyAgent() {
        const error = new Error('invalid run');
        error.status = 409;
        throw error;
      },
      approvalId: 'approval-2',
      decision: 'reject',
    });
    assert.equal(outcome.resumePending, true);
    assert.match(outcome.resumeError, /invalid run/);
  });
});
