/**
 * Wave 5 策略挂载点：审批 PENDING、digest 拒绝、guard 单调、预算、post-execute 脱敏。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makePolicyDecision } from '../../src/runtime/policy/decision.js';
import { runGuards } from '../../src/runtime/policy/guards.js';
import { evaluatePreExecute, InMemoryApprovalStore } from '../../src/runtime/policy/pre-execute.js';
import { recordLedger } from '../../src/runtime/policy/post-execute.js';
import { RunBudget, wrapExecute } from '../../src/runtime/policy/run-budget.js';
import { digestArgs } from '../../src/runtime/policy/source-digest.js';

test('pre-execute：高风险拦截 → 持久 PENDING → WAITING_APPROVAL', async () => {
  const store = new InMemoryApprovalStore();
  // 2026-08-31（ADR 0009 D4/D7）：原来这里用 `skill_install`，它被平台默认表
  // override 到 high。那个工具整套取消之后，平台默认表里**没有**任何 high 的
  // 本地工具了——高风险现在只来自运维覆盖或 MCP。所以夹具改成运维把 `bash`
  // 抬到 high，测的仍然是同一条路径：ask → 落 PENDING → WAITING_APPROVAL。
  const result = await evaluatePreExecute(
    {
      toolName: 'bash',
      args: { command: 'rm -rf /tmp/x' },
      callId: 'call-1',
    },
    store,
    undefined,
    { bash: 'high' },
  );
  assert.equal(result.decision.decision, 'require_approval');
  assert.equal(result.blocked, true);
  assert.equal(result.approval?.status, 'PENDING');
  assert.equal(result.approval?.runStatusHint, 'WAITING_APPROVAL');
  assert.equal(store.records.size, 1);
});

test('pre-execute：续跑重放时参数指纹不匹配则拒绝（ADR 0009 D5）', async () => {
  // 原来这里有两条用例，都绑在 `skill_install(source=sandbox)` 必带 source_digest 上。
  // D7 取消了那个工具，那条专用校验随之退役（见 source-digest.ts 顶部）。
  // **通用的那条留着而且更重要**：人点同意之后、工具真正落地之前，参数被换过就必须拒。
  const approved = { command: 'ls /home/sandbox/workspace' };
  const store = new InMemoryApprovalStore();
  const result = await evaluatePreExecute(
    {
      toolName: 'bash',
      args: { command: 'rm -rf /' }, // 落地时的参数已经不是被批准的那个
      callId: 'c3',
      replayDigest: digestArgs(approved),
    },
    store,
  );
  assert.equal(result.decision.decision, 'deny');
  assert.equal(result.decision.reasonCode, 'SOURCE_DIGEST_MISMATCH');
  assert.equal(store.records.size, 0, '拒绝的调用不该再落一条 PENDING');
});

test('pre-execute：指纹一致时放行（否则上一条用例恒真）', async () => {
  const args = { command: 'ls /home/sandbox/workspace' };
  const store = new InMemoryApprovalStore();
  const result = await evaluatePreExecute(
    { toolName: 'bash', args, callId: 'c4', replayDigest: digestArgs(args) },
    store,
  );
  assert.equal(result.decision.decision, 'allow');
});

// ── 续跑：按参数指纹认已落库的决定（ADR 0009 D5 / 计划 H4.4）─────────────

test('H4.4 续跑：批准过的同一组参数直接放行，且换了 callId 也认', async () => {
  const store = new InMemoryApprovalStore();
  const args = { command: 'ls /home/sandbox/workspace' };

  // 第一次：撞审批，铸 PENDING。
  const first = await evaluatePreExecute(
    { toolName: 'bash', args, callId: 'call-1' },
    store,
    undefined,
    { bash: 'high' },
  );
  assert.equal(first.decision.decision, 'require_approval');
  const approvalId = first.approval?.id ?? '';

  // 人批准。
  await store.persistPending({ ...(first.approval as never), status: 'APPROVED' });

  // 续跑是**重建会话后让模型重新发起同一个调用**，callId 是新的。
  // 只按 callId 查会查不到——ADR D5 说的「callId + digest」，跨会话时
  // 能对上的只有 digest 这一半。
  const replay = await evaluatePreExecute(
    { toolName: 'bash', args, callId: 'call-2-different' },
    store,
    undefined,
    { bash: 'high' },
  );
  assert.equal(replay.decision.decision, 'allow', '批准过的同一组参数必须放行');
  assert.equal(replay.decision.reasonCode, 'APPROVAL_GRANTED_ONCE');
  assert.equal(replay.blocked, false);
  assert.equal(replay.approval, null, '不该再铸一条 PENDING');

  // 一次性：出厂词表只有 allowed-once，没有 allow-always。
  const third = await evaluatePreExecute(
    { toolName: 'bash', args, callId: 'call-3' },
    store,
    undefined,
    { bash: 'high' },
  );
  assert.equal(
    third.decision.decision,
    'require_approval',
    '同一条批准不得被重复使用——那是越权',
  );
  assert.notEqual(approvalId, '');
});

test('H4.4 续跑：参数被改过就查不到那条批准，重新走审批', async () => {
  const store = new InMemoryApprovalStore();
  const approved = { command: 'ls /home/sandbox/workspace' };
  const first = await evaluatePreExecute(
    { toolName: 'bash', args: approved, callId: 'c1' },
    store,
    undefined,
    { bash: 'high' },
  );
  await store.persistPending({ ...(first.approval as never), status: 'APPROVED' });

  // 人批准的是 A 这组参数；模型落地时换成了 B。
  const tampered = await evaluatePreExecute(
    { toolName: 'bash', args: { command: 'rm -rf /' }, callId: 'c2' },
    store,
    undefined,
    { bash: 'high' },
  );
  assert.equal(
    tampered.decision.decision,
    'require_approval',
    '指纹绑的是字节：改一个字符就不该沿用那条批准',
  );
});

test('H4.4 续跑：被人拒过的同一组参数直接拒，理由码稳定', async () => {
  const store = new InMemoryApprovalStore();
  const args = { command: 'shutdown now' };
  const first = await evaluatePreExecute(
    { toolName: 'bash', args, callId: 'c1' },
    store,
    undefined,
    { bash: 'high' },
  );
  await store.persistPending({ ...(first.approval as never), status: 'DENIED' });

  const again = await evaluatePreExecute(
    { toolName: 'bash', args, callId: 'c2' },
    store,
    undefined,
    { bash: 'high' },
  );
  assert.equal(again.decision.decision, 'deny');
  assert.equal(again.decision.reasonCode, 'APPROVAL_REJECTED');
  assert.equal(again.blocked, true);
});

test('guard：拒绝后后续监听器无法放行', () => {
  const deny = () =>
    makePolicyDecision({
      decision: 'deny',
      reasonCode: 'TENANT',
      reason: 'no',
      policyId: 'g1',
      riskLevel: 'critical',
    });
  const allow = () =>
    makePolicyDecision({
      decision: 'allow',
      reasonCode: 'OK',
      reason: 'yes',
      policyId: 'g2',
    });
  const merged = runGuards([deny, allow], 'bash', { command: 'pwd' });
  assert.equal(merged?.decision, 'deny');
  assert.equal(merged?.reasonCode, 'TENANT');
});

test('execute 环绕：预算超限停止继续工具', async () => {
  const budget = new RunBudget({
    maxToolCalls: 1,
    maxModelTurns: 10,
    runDeadlineMs: 60_000,
    startedAt: Date.now(),
  });
  await wrapExecute(budget, async () => 1);
  await assert.rejects(() => wrapExecute(budget, async () => 2), /tool call budget exceeded/);
});

test('post-execute：裸 Error 物理路径脱敏入账本', () => {
  const entry = recordLedger({
    callId: 'c',
    toolName: 'bash',
    ok: false,
    error: new Error('boom /var/sandbox/workspaces/secret/file'),
    physicalRoots: ['/var/sandbox/workspaces/secret'],
  });
  assert.equal(entry.ok, false);
  assert.equal(entry.error?.message.includes('/var/sandbox/workspaces/secret'), false);
  assert.equal(entry.error?.message.includes('<workspace>'), true);
});
