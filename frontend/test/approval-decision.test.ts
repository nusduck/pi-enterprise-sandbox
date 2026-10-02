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
  validateApprovalReason,
} from '../src/pages/approvals/approvalHelpers.ts';
import { decideApproval } from '../src/shared/api/client.ts';
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
    assert.match(src, /操作失败，这条审批仍在等待处理。/);
    assert.match(src, /批准/);
    assert.match(src, /拒绝/);
    assert.match(src, /打开会话/);
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

describe('approval decision resumes the live stream', () => {
  // A run parked at an approval gate may have no live stream (the page was
  // refreshed while waiting). Without re-attaching one after the decision,
  // everything the resumed run does stays invisible until the next refresh.
  it('follows the run after an accepted decision', async () => {
    let followed = 0;
    const { deps } = createDeps({ followRun: () => { followed += 1; } });
    assert.equal(await resolveApprovalDecision('appr_1', 'approve', deps), true);
    assert.equal(followed, 1);
  });

  it('does not follow the run when the decision failed', async () => {
    let followed = 0;
    const { deps } = createDeps({
      decide: async () => { throw new Error('409 already decided'); },
      followRun: () => { followed += 1; },
    });
    assert.equal(await resolveApprovalDecision('appr_1', 'approve', deps), false);
    assert.equal(followed, 0);
  });
});

describe('approval decision reason handling', () => {
  it('decideApproval 带上 reason 发送请求体', async () => {
    const originalFetch = globalThis.fetch;
    try {
      let capturedBody: any = null;
      globalThis.fetch = (async (_url: string, init: any) => {
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ ok: true, status: 'approved' }), { status: 200 });
      }) as any;

      await decideApproval('appr_123', 'approve', '安全检查通过');
      assert.deepEqual(capturedBody, { decision: 'approve', reason: '安全检查通过' });

      await decideApproval('appr_123', 'reject', '高风险操作已拒绝');
      assert.deepEqual(capturedBody, { decision: 'reject', reason: '高风险操作已拒绝' });

      await decideApproval('appr_123', 'approve');
      assert.deepEqual(capturedBody, { decision: 'approve' });

      await decideApproval('appr_123', 'approve', '');
      assert.deepEqual(capturedBody, { decision: 'approve' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('resolveApprovalDecision 将 reason 透传给 decide 与 markApproval', async () => {
    const { calls, deps } = createDeps({
      decide: async (id, decision, reason) => {
        calls.push(['decide', id, decision, reason]);
        return { agent_resume_status: 'queued' };
      },
    });

    assert.equal(
      await resolveApprovalDecision('appr_test', 'reject', deps, '不符合安全规范'),
      true,
    );
    assert.deepEqual(calls[0], ['decide', 'appr_test', 'reject', '不符合安全规范']);
    assert.deepEqual(calls[1], ['mark', 'appr_test', 'rejected', '不符合安全规范']);
  });

  it('超长被拦：超过 2000 字返回校验失败并给出提示', () => {
    assert.equal(validateApprovalReason('').valid, true);
    assert.equal(validateApprovalReason('a'.repeat(2000)).valid, true);
    assert.equal(validateApprovalReason('a'.repeat(2000)).error, null);

    const invalid = validateApprovalReason('a'.repeat(2001));
    assert.equal(invalid.valid, false);
    assert.match(invalid.error!, /原因不能超过 2000 字/);
    assert.match(invalid.error!, /2001/);
  });

  it('决策入口组件包含原因输入、占位文案、超长校验拦截接线', () => {
    const approvalsPageSrc = readFileSync(
      join(here, '..', 'src', 'pages', 'approvals', 'ApprovalsPage.tsx'),
      'utf8',
    );
    assert.match(approvalsPageSrc, /validateApprovalReason/);
    assert.match(approvalsPageSrc, /拒绝原因（可选）/);
    assert.match(approvalsPageSrc, /批准原因（可选）/);
    assert.match(approvalsPageSrc, /!reasonValidation\.valid/);

    const turnCardsSrc = readFileSync(
      join(here, '..', 'src', 'widgets', 'turn-stream', 'TurnCards.tsx'),
      'utf8',
    );
    assert.match(turnCardsSrc, /validateApprovalReason/);
    assert.match(turnCardsSrc, /拒绝原因（可选）/);
    assert.match(turnCardsSrc, /批准原因（可选）/);
    assert.match(turnCardsSrc, /isTooLong/);
    assert.match(turnCardsSrc, /approval\.reason \? <span className=\{s\.muted\}>原因：\{approval\.reason\}<\/span>/);
  });

  it('失败时输入保留：API 报错时不清除草稿并展示错误', async () => {
    let preservedDraft = '这是用户输入的待保留拒绝原因';
    const { calls, deps } = createDeps({
      decide: async () => {
        throw new Error('网络超时，提交失败');
      },
    });

    const applied = await resolveApprovalDecision('appr_fail', 'reject', deps, preservedDraft);
    assert.equal(applied, false);
    // 草稿内容在调用失败后未被丢弃
    assert.equal(preservedDraft, '这是用户输入的待保留拒绝原因');
    assert.deepEqual(calls, [['error', '网络超时，提交失败']]);
  });
});

