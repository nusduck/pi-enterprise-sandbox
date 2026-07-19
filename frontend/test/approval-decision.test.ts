import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveApprovalDecision,
  type ApprovalDecisionDeps,
} from '../src/features/chat/approvalDecision.ts';

function createDeps(
  overrides: Partial<ApprovalDecisionDeps> = {},
): { calls: Array<unknown[]>; deps: ApprovalDecisionDeps } {
  const calls: Array<unknown[]> = [];
  return {
    calls,
    deps: {
      decide: async () => ({ agent_resume_status: 'queued' }),
      markApproval: (...args: unknown[]) => calls.push(['mark', ...args]),
      setStatus: (...args: unknown[]) => calls.push(['status', ...args]),
      flashError: (...args: unknown[]) => calls.push(['error', ...args]),
      ...overrides,
    },
  };
}

describe('approval decision UX', () => {
  it('reports success only after the durable API accepts the decision', async () => {
    const { calls, deps } = createDeps();
    assert.equal(
      await resolveApprovalDecision('approval-1', 'approve', deps),
      true,
    );
    assert.deepEqual(calls[0], ['mark', 'approval-1', 'approved']);
    assert.deepEqual(calls[1], ['status', 'Approved', '#22c55e']);
  });

  it('keeps the approval pending and reports failure when the API rejects', async () => {
    const { calls, deps } = createDeps({
      decide: async () => {
        throw new Error('owner scope rejected');
      },
    });
    assert.equal(
      await resolveApprovalDecision('approval-2', 'reject', deps),
      false,
    );
    assert.deepEqual(calls, [['error', 'owner scope rejected']]);
  });

  it('distinguishes a persisted decision whose Agent resume is pending', async () => {
    const { calls, deps } = createDeps({
      decide: async () => ({ agent_resume_status: 'pending' }),
    });
    assert.equal(
      await resolveApprovalDecision('approval-3', 'reject', deps),
      true,
    );
    assert.ok(
      calls.some(
        (call) =>
          call[0] === 'error' && String(call[1]).includes('resume is pending'),
      ),
    );
  });
});
