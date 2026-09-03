/**
 * ADR 0009 D5 / 计划 H4.5：审批续跑由**循环**执行，不再由 application 自己执行。
 *
 * ## 为什么这个文件是新加的
 *
 * 2026-08-31 之前 `prepareApprovalResume` 的「已批准」分支
 * **一个测试都没有**。而那条分支在 Pi→DSH 之后一直是坏的：它调
 * `runtimeSession.getToolDefinition(...)`，而 DSH 的 session 根本没有这个方法，
 * 所以每次都抛 "Pi runtime cannot replay approved tool"——
 * 「审批能停泊，但批准之后续不回去」。没有用例，就没有人发现。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareApprovalResume } from '../../src/application/dsh-run-resume.js';

const APPROVAL_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TOOL_EXEC_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const RUN_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAX';

/** 只提供 prepareApprovalResume 真正碰到的那几样。 */
function fakeExecutor(overrides: Record<string, unknown> = {}) {
  const recorded: Array<Record<string, unknown>> = [];
  return {
    recorded,
    executor: {
      tx: { run: async (fn: (trx: unknown) => unknown) => fn({}) },
      createRepositories: () => ({
        approvals: {
          getById: async () => ({
            approvalId: APPROVAL_ID,
            runId: RUN_ID,
            toolExecutionId: TOOL_EXEC_ID,
            status: 'APPROVED',
          }),
        },
        toolExecutions: {
          getById: async () => ({
            toolExecutionId: TOOL_EXEC_ID,
            runId: RUN_ID,
            toolCallId: 'call-1',
            toolName: 'bash',
            status: 'WAITING_APPROVAL',
            argumentsJson: { command: 'ls' },
            _argsIntegrity: null,
          }),
        },
      }),
      _governanceRecorder: {
        recordToolStarted: async (e: Record<string, unknown>) => {
          recorded.push({ kind: 'started', ...e });
        },
        recordToolEnded: async (e: Record<string, unknown>) => {
          recorded.push({ kind: 'ended', ...e });
        },
        recordToolUnknown: async (e: Record<string, unknown>) => {
          recorded.push({ kind: 'unknown', ...e });
        },
      },
      _runtime: { sessionManager: {} },
      ...overrides,
    } as never,
  };
}

/** DSH 的 session：**没有** getToolDefinition —— 这正是关键。 */
const dshRuntimeSession = { agent: {}, sessionManager: {} } as never;

test('H4.5 已批准的续跑不再需要 getToolDefinition（DSH session 上根本没有这个方法）', async () => {
  const { executor } = fakeExecutor();
  const text = await prepareApprovalResume(executor, {
    approvalResume: { approvalId: APPROVAL_ID, toolExecutionId: TOOL_EXEC_ID, status: 'APPROVED' },
    runtimeSession: dshRuntimeSession,
    run: { runId: RUN_ID },
    scope: {},
    signal: undefined,
  } as never);

  assert.equal(typeof text, 'string');
  assert.match(String(text), /was granted/, '必须回一段续跑提示');
  assert.match(
    String(text),
    /same arguments/,
    '必须明确要求参数原样——改了就查不到那条批准，会重新问人',
  );
});

test('H4.5 application 不再自己执行工具：只记账，不调 execute', async () => {
  const { executor, recorded } = fakeExecutor();
  // 这个 session 故意带一个会爆炸的 getToolDefinition：一旦有人把老路径加回来，
  // 这条用例立刻红。光断言「返回了字符串」抓不到那种回退。
  const trapSession = {
    agent: {},
    sessionManager: {},
    getToolDefinition() {
      throw new Error('application must not execute the approved tool itself (ADR 0009 D5)');
    },
  } as never;

  await prepareApprovalResume(executor, {
    approvalResume: { approvalId: APPROVAL_ID, toolExecutionId: TOOL_EXEC_ID, status: 'APPROVED' },
    runtimeSession: trapSession,
    run: { runId: RUN_ID },
    scope: {},
    signal: undefined,
  } as never);

  const kinds = recorded.map((r) => r['kind']);
  assert.deepEqual(
    kinds,
    ['started'],
    '只该记一条 started：真正的执行与 ended 由循环那边的挂载点负责，' +
      '否则预算 / 账本 / 脱敏 / 租户 guard 全被绕过去了',
  );
});
