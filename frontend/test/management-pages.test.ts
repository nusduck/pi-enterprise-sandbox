/**
 * F5 management page helpers + Zod schemas.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEntityStore,
  createRun,
  createApproval,
  upsertRun,
  upsertApproval,
} from '../src/entities/index.ts';
import {
  canCancelRun,
  formatLongDuration,
  formatRunDuration,
  normalizeRunStatus,
} from '../src/pages/runs/runHelpers.ts';
import {
  canDecideApproval,
  filterApprovalsByStatus,
  formatArgs,
  mergeApprovalRows,
  normalizeApprovalStatus,
  approvalRowFromApi,
} from '../src/pages/approvals/approvalHelpers.ts';
import {
  ApprovalListItemSchema,
  McpServerSchema,
  ModelItemSchema,
  RunListItemSchema,
  SkillItemSchema,
  ToolRegistryItemSchema,
} from '../src/shared/schemas/management.ts';
import { parseApi } from '../src/shared/schemas/api.ts';

describe('run helpers', () => {
  it('normalizes durable Agent statuses and decides cancel eligibility', () => {
    assert.equal(normalizeRunStatus('WAITING_APPROVAL'), 'waiting_approval');
    assert.equal(canCancelRun('RUNNING'), true);
    assert.equal(canCancelRun('SUCCEEDED'), false);
  });

  it('formats durations', () => {
    const start = '2026-07-12T00:00:00.000Z';
    const end = '2026-07-12T00:01:05.000Z';
    assert.equal(formatRunDuration(start, end), '01:05');
    assert.equal(formatRunDuration(null, null), '—');
    assert.equal(formatLongDuration(250_000), '4 分 10 秒');
    assert.equal(formatLongDuration(null), '—');
  });
});

describe('approval helpers', () => {
  it('normalizes backend status variants', () => {
    assert.equal(normalizeApprovalStatus('pending_approval'), 'pending');
    assert.equal(normalizeApprovalStatus('waiting_approval'), 'pending');
    assert.equal(normalizeApprovalStatus('approve'), 'approved');
    assert.equal(normalizeApprovalStatus('rejected'), 'rejected');
    assert.equal(canDecideApproval('pending'), true);
    assert.equal(canDecideApproval('approved'), false);
  });

  it('filters and merges approvals from store + API', () => {
    let store = createEntityStore();
    store = upsertRun(
      store,
      createRun({ id: 'r1', conversationId: 'c1', status: 'waiting_approval' }),
    );
    store = upsertApproval(
      store,
      createApproval({
        id: 'a_store',
        runId: 'r1',
        status: 'pending',
        reason: 'needs shell',
        command: 'ls',
      }),
    );
    const api = [
      {
        approval_id: 'a_api',
        status: 'approved',
        tool_name: 'write_file',
        run_id: 'r2',
        risk_level: 'high',
      },
    ];
    const merged = mergeApprovalRows(api, store);
    assert.equal(merged.length, 2);
    const pending = filterApprovalsByStatus(merged, 'pending');
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.id, 'a_store');
    assert.equal(pending[0]?.conversationId, 'c1');
    const approved = filterApprovalsByStatus(merged, 'approved');
    assert.equal(approved[0]?.tool, 'write_file');
    assert.equal(approved[0]?.riskLevel, 'high');
  });

  it('builds row from API and formats args', () => {
    const row = approvalRowFromApi({
      approval_id: 'ap1',
      status: 'pending_approval',
      payload: { command: 'rm -rf /', conversation_id: 'cx' },
      arguments: { path: '/tmp' },
    });
    assert.ok(row);
    assert.equal(row?.status, 'pending');
    assert.equal(row?.command, 'rm -rf /');
    assert.equal(row?.conversationId, 'cx');
    assert.ok(formatArgs({ a: 1 }).includes('"a"'));
  });
});

describe('management schemas', () => {
  it('soft-parses run / approval / capability shapes', () => {
    const run = parseApi(
      RunListItemSchema,
      { run_id: 'r1', status: 'running', extra_field: true },
      'run',
    );
    assert.equal(run.run_id, 'r1');

    const appr = parseApi(
      ApprovalListItemSchema,
      { approval_id: 'a1', risk_level: 'medium' },
      'appr',
    );
    assert.equal(appr.approval_id, 'a1');

    const skill = parseApi(
      SkillItemSchema,
      {
        name: 'docs',
        enabled: true,
        status: 'active',
        dynamic: true,
        registry_id: 'skill:docs',
      },
      'skill',
    );
    assert.equal(skill.name, 'docs');
    assert.equal(skill.status, 'active');
    assert.equal(skill.dynamic, true);

    const mcp = parseApi(
      McpServerSchema,
      {
        server_id: 'sandbox',
        tools_count: 3,
        connection_status: 'connected',
        status: 'active',
        dynamic: false,
      },
      'mcp',
    );
    assert.equal(mcp.server_id, 'sandbox');
    assert.equal(mcp.status, 'active');

    const tool = parseApi(
      ToolRegistryItemSchema,
      {
        name: 'bash',
        category: 'Sandbox',
        risk_level: 'high',
        status: 'active',
        dynamic: false,
        registry_id: 'tool:bash',
      },
      'tool',
    );
    assert.equal(tool.category, 'Sandbox');
    assert.equal(tool.status, 'active');

    const model = parseApi(
      ModelItemSchema,
      {
        model_id: 'gpt-x',
        provider: 'openai',
        context_window: 128000,
        supports_tool_call: true,
        enabled: true,
      },
      'model',
    );
    assert.equal(model.model_id, 'gpt-x');
    assert.equal(model.supports_tool_call, true);
  });
});

describe('runInputLabel', () => {
  it('keeps the words, drops the attachment manifest, folds whitespace', async () => {
    const { runInputLabel } = await import('../src/pages/runs/runHelpers.ts');
    assert.equal(runInputLabel('这张图片大概是什么颜色？\n\n[Attachments]\n- test-chart.png → datasets/x'), '这张图片大概是什么颜色？');
    assert.equal(runInputLabel('  晚上好\n  你好  '), '晚上好 你好');
    assert.equal(runInputLabel('\n\n[Attachments]\n- a.png'), '（仅附件）');
    assert.equal(runInputLabel(null), null);
    assert.equal(runInputLabel('a'.repeat(100), 10), `${'a'.repeat(10)}…`);
  });
});
