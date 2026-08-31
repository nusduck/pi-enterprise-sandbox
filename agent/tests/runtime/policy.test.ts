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
