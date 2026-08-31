/**
 * ADR 0009 D5 / 计划 H4.3：审批判定 → durable 落库 → 停泊 Run → 释放 Worker。
 *
 * ## 这条链在 2026-08-31 之前是断的
 *
 * `FencedToolGovernanceRecorder.requestApproval()` 才是真正落库并把 Run 迁到
 * WAITING_APPROVAL 的那一环，而它**只经 `extensionBundleFactory` 到达运行时**
 * ——那批 Pi Extension 在 DSH 重建时已经删掉。于是 DSH 的策略挂载点用的是进程内的
 * `InMemoryApprovalStore`：判定对，但不落库、不发事件、不停泊、不释放 Worker。
 *
 * 本文件断言的是**接线**，不是判定：判定的用例在 `policy-install.test.ts`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GovernanceApprovalStore } from '../../src/application/governance-approval-store.js';
import { installEnterprisePolicy } from '../../src/runtime/policy/install.js';

function fakeRecorder() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    recorder: {
      async requestApproval(input: Record<string, unknown>) {
        calls.push(input);
        return {
          approval: { approvalId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', status: 'PENDING' },
          durablePending: {
            kind: 'DURABLE_APPROVAL_PENDING',
            approvalId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
            runId: 'run-1',
            toolCallId: String((input as { toolCallId?: string }).toolCallId ?? ''),
            toolName: String((input as { toolName?: string }).toolName ?? ''),
          },
        };
      },
    },
  };
}

test('H4.3 铸 PENDING 会调 requestApproval，并把 durable 信号交给停泊端口', async () => {
  const { recorder, calls } = fakeRecorder();
  const parked: unknown[] = [];
  const store = new GovernanceApprovalStore({
    recorder: recorder as never,
    onDurableApprovalPending: (p) => parked.push(p),
  });

  await store.persistPending({
    id: 'appr_call-7',
    toolName: 'bash',
    sourceDigest: 'abc',
    argsCanonical: JSON.stringify({ command: 'rm -rf /tmp/x' }),
    status: 'PENDING',
    runStatusHint: 'WAITING_APPROVAL',
  });

  assert.equal(calls.length, 1, '必须落库——只判定不落库等于审批链条从判定之后就断了');
  assert.equal(calls[0]?.['toolCallId'], 'call-7', 'appr_ 前缀要剥掉，MySQL 那边存的是 toolCallId');
  assert.equal(calls[0]?.['toolName'], 'bash');
  assert.deepEqual(calls[0]?.['args'], { command: 'rm -rf /tmp/x' }, '参数要还原，审批中心要展示它');

  assert.equal(parked.length, 1, '必须把 durable 信号交出去——吞掉的话 Run 会一直跑到超时');
  assert.equal((parked[0] as Record<string, unknown>)['kind'], 'DURABLE_APPROVAL_PENDING');
});

test('H4.3 装在策略挂载点上：高风险工具一撞审批就落库并停泊', async () => {
  const { recorder, calls } = fakeRecorder();
  const parked: unknown[] = [];
  const store = new GovernanceApprovalStore({
    recorder: recorder as never,
    onDurableApprovalPending: (p) => parked.push(p),
  });

  // 最小 cordis 替身，够驱动 pre-execute 就行。
  const listeners = new Map<string, Array<(...a: never[]) => unknown>>();
  const ctx = {
    on(event: string, fn: (...a: never[]) => unknown) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => undefined;
    },
    inject(_n: readonly string[], apply: (scoped: unknown) => void) {
      apply({ tools: { guard: () => () => undefined } });
      return () => undefined;
    },
  };
  installEnterprisePolicy(ctx as never, {
    approvalStore: store,
    riskOverrides: { bash: 'high' },
  });

  const pre = listeners.get('tools/pre-execute')?.[0];
  assert.ok(pre, 'pre-execute 未注册');
  const decision = (await (pre as never as (e: unknown, n: unknown) => Promise<unknown>)(
    { name: 'bash', arguments: { command: 'x' }, id: 'c1' },
    async () => ({ kind: 'allow' }),
  )) as { kind: string };

  assert.equal(decision.kind, 'ask');
  assert.equal(calls.length, 1, '判定为 ask 时必须落一条 durable PENDING');
  assert.equal(parked.length, 1, '并且必须停泊 Run');
});

test('H4.3 argsCanonical 坏掉时不打死这次调用，只是记不到参数', async () => {
  const { recorder, calls } = fakeRecorder();
  const store = new GovernanceApprovalStore({
    recorder: recorder as never,
    onDurableApprovalPending: () => undefined,
  });
  await store.persistPending({
    id: 'appr_c1',
    toolName: 'bash',
    sourceDigest: 'd',
    argsCanonical: '{not json',
    status: 'PENDING',
    runStatusHint: 'WAITING_APPROVAL',
  });
  assert.deepEqual(calls[0]?.['args'], {}, '为记账把一次调用打死是本末倒置');
});
