/**
 * Approval decision UX helpers (D6).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveApprovalDecision,
  type ApprovalDecisionDeps,
} from '../src/features/chat/approvalDecision.ts';
import {
  canDecideApproval,
  mergeApprovalRows,
  normalizeApprovalStatus,
} from '../src/pages/approvals/approvalHelpers.ts';
import {
  createApproval,
  createEntityStore,
  createRun,
  upsertApproval,
  upsertRun,
} from '../src/entities/index.ts';

const here = dirname(fileURLToPath(import.meta.url));

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
    // Failed decision must NOT mark approved/rejected — pending stays.
    assert.deepEqual(calls, [['error', 'owner scope rejected']]);
    assert.ok(!calls.some((c) => c[0] === 'mark'));
    assert.ok(!calls.some((c) => c[0] === 'status'));
  });

  it('failed decide leaves store approval pending and still decidable (D6)', async () => {
    let store = createEntityStore();
    store = upsertRun(
      store,
      createRun({
        id: 'run_ap',
        conversationId: 'conv_ap',
        status: 'waiting_approval',
      }),
    );
    store = upsertApproval(
      store,
      createApproval({
        id: 'ap_pending',
        runId: 'run_ap',
        status: 'pending',
        reason: 'external network',
        command: 'curl https://example.com',
      }),
    );

    const { calls, deps } = createDeps({
      decide: async () => {
        throw new Error('policy denied');
      },
      markApproval: (id, status) => {
        calls.push(['mark', id, status]);
        const existing = store.approvalsById[id];
        if (!existing) return;
        store = upsertApproval(store, {
          ...existing,
          status: status === 'approved' ? 'approved' : 'rejected',
        });
      },
    });

    const applied = await resolveApprovalDecision('ap_pending', 'approve', deps);
    assert.equal(applied, false);
    assert.equal(store.approvalsById.ap_pending.status, 'pending');
    assert.equal(canDecideApproval(store.approvalsById.ap_pending.status), true);

    // ApprovalsPage UX: failed applied → banner, no optimistic clear.
    const banner = !applied
      ? 'Decision failed. The approval remains pending.'
      : 'Approved';
    assert.match(banner, /remains pending/);

    const rows = mergeApprovalRows([], store);
    const pending = rows.filter((r) => canDecideApproval(r.status));
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.id, 'ap_pending');
    assert.equal(normalizeApprovalStatus(pending[0]?.status), 'pending');
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
    // Decision is durable — mark still runs even when resume is pending.
    assert.ok(calls.some((c) => c[0] === 'mark' && c[2] === 'rejected'));
  });

  it('empty approval id is a no-op (no API, no mark)', async () => {
    const { calls, deps } = createDeps();
    assert.equal(await resolveApprovalDecision('', 'approve', deps), false);
    assert.deepEqual(calls, []);
  });

  it('ApprovalsPage surfaces failed decisions without clearing pending (structural)', () => {
    const src = readFileSync(
      join(here, '..', 'src', 'pages', 'approvals', 'ApprovalsPage.tsx'),
      'utf8',
    );
    assert.match(src, /resolveApproval/);
    assert.match(src, /canDecideApproval/);
    assert.match(src, /Decision failed\. The approval remains pending\./);
    assert.match(src, /Approve/);
    assert.match(src, /Reject/);
    assert.match(src, /Open conversation/);
    assert.match(src, /role=["']tablist["']/);
    // Buttons only when pending
    assert.match(src, /pending \? \(/);
  });

  it('ChatContext wires resolveApproval through resolveApprovalDecision', () => {
    const src = readFileSync(
      join(here, '..', 'src', 'features', 'chat', 'ChatContext.tsx'),
      'utf8',
    );
    assert.match(src, /resolveApprovalDecision/);
    assert.match(src, /decideApproval/);
    assert.match(src, /markApproval/);
    assert.match(src, /flashError/);
  });
});
