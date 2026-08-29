/**
 * Wave 5 策略挂载点：审批 PENDING、digest 拒绝、guard 单调、预算、post-execute 脱敏。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makePolicyDecision } from '../src/policy/decision.js';
import { runGuards } from '../src/policy/guards.js';
import { evaluatePreExecute, InMemoryApprovalStore } from '../src/policy/pre-execute.js';
import { recordLedger } from '../src/policy/post-execute.js';
import { RunBudget, wrapExecute } from '../src/policy/run-budget.js';
import { digestArgs } from '../src/policy/source-digest.js';

test('pre-execute：高风险拦截 → 持久 PENDING → WAITING_APPROVAL', async () => {
  const store = new InMemoryApprovalStore();
  const result = await evaluatePreExecute(
    {
      toolName: 'skill_install',
      args: { source: 'sandbox', path: 'pkg.skill', source_digest: 'a'.repeat(64) },
      callId: 'call-1',
    },
    store,
  );
  assert.equal(result.decision.decision, 'require_approval');
  assert.equal(result.blocked, true);
  assert.equal(result.approval?.status, 'PENDING');
  assert.equal(result.approval?.runStatusHint, 'WAITING_APPROVAL');
  assert.equal(store.records.size, 1);
});

test('pre-execute：source_digest 缺失拒绝', async () => {
  const store = new InMemoryApprovalStore();
  const result = await evaluatePreExecute(
    { toolName: 'skill_install', args: { source: 'sandbox', path: 'pkg.skill' }, callId: 'c2' },
    store,
  );
  assert.equal(result.decision.decision, 'deny');
  assert.equal(result.decision.reasonCode, 'SOURCE_DIGEST_REQUIRED');
  assert.equal(store.records.size, 0);
});

test('pre-execute：恢复重放 source_digest 不匹配拒绝', async () => {
  const args = { source: 'sandbox', path: 'pkg.skill', source_digest: 'b'.repeat(64) };
  const store = new InMemoryApprovalStore();
  const result = await evaluatePreExecute(
    { toolName: 'skill_install', args, callId: 'c3', replayDigest: digestArgs({ ...args, path: 'other.skill' }) },
    store,
  );
  assert.equal(result.decision.decision, 'deny');
  assert.equal(result.decision.reasonCode, 'SOURCE_DIGEST_MISMATCH');
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
