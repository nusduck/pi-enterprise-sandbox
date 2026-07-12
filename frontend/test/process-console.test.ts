/**
 * F4 Process Console helpers + budget display.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLogLines,
  filterLogLines,
  formatLogsForDownload,
  isProcessInteractive,
} from '../src/widgets/process-console/logHelpers.ts';
import {
  budgetTone,
  extractBudgetSnapshot,
  formatBudgetSummary,
  hasBudgetData,
  listBudgetDimensions,
} from '../src/widgets/budget-bar/budget.ts';

describe('process console log lines', () => {
  it('splits stdout/stderr into tagged lines', () => {
    const lines = buildLogLines('hello\nworld\n', 'err1\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0].stream, 'stdout');
    assert.equal(lines[0].text, 'hello');
    assert.equal(lines[1].text, 'world');
    assert.equal(lines[2].stream, 'stderr');
    assert.equal(lines[2].text, 'err1');
  });

  it('filters by stream and search', () => {
    const lines = buildLogLines('alpha\nbeta\n', 'alpha-err\n');
    const outOnly = filterLogLines(lines, { stream: 'stdout' });
    assert.equal(outOnly.length, 2);
    assert.ok(outOnly.every((l) => l.stream === 'stdout'));

    const errOnly = filterLogLines(lines, { stream: 'stderr' });
    assert.equal(errOnly.length, 1);

    const search = filterLogLines(lines, { search: 'ALPHA' });
    assert.equal(search.length, 2);
  });

  it('formats download with sections', () => {
    const text = formatLogsForDownload('out\n', 'err\n');
    assert.match(text, /=== stdout ===/);
    assert.match(text, /=== stderr ===/);
    assert.match(text, /out/);
    assert.match(text, /err/);
  });

  it('isProcessInteractive for live statuses', () => {
    assert.equal(isProcessInteractive('running'), true);
    assert.equal(isProcessInteractive('waiting_input'), true);
    assert.equal(isProcessInteractive('completed'), false);
    assert.equal(isProcessInteractive('failed'), false);
  });
});

describe('budget helpers', () => {
  it('hasBudgetData requires usage', () => {
    assert.equal(hasBudgetData(null), false);
    assert.equal(hasBudgetData({ usage: null, limits: null }), false);
    assert.equal(
      hasBudgetData({ usage: { steps: 1 }, limits: { max_steps: 10 } }),
      true,
    );
  });

  it('lists dimensions and formats summary', () => {
    const snap = {
      usage: { steps: 8, tool_calls: 3, llm_tokens: 1200 },
      limits: {
        max_steps: 10,
        max_tool_calls: 100,
        max_llm_tokens: 500_000,
      },
    };
    const dims = listBudgetDimensions(snap);
    assert.ok(dims.length >= 3);
    const steps = dims.find((d) => d.key === 'steps');
    assert.ok(steps);
    assert.equal(steps!.near, true); // 8/10 = 0.8
    assert.equal(steps!.exceeded, false);

    const summary = formatBudgetSummary(snap);
    assert.match(summary, /Steps/);
    assert.match(summary, /Tools/);
    assert.equal(budgetTone(snap), 'near');
  });

  it('budgetTone exceeded when over limit', () => {
    const snap = {
      usage: { steps: 12 },
      limits: { max_steps: 10 },
      warning: null as string | null,
    };
    assert.equal(budgetTone(snap), 'exceeded');
  });

  it('extractBudgetSnapshot from run-like object', () => {
    const snap = extractBudgetSnapshot({
      budgetUsage: { steps: 2, tool_calls: 1 },
      budgetLimits: { max_steps: 50, max_tool_calls: 100 },
      budgetWarning: 'warning',
    });
    assert.ok(snap);
    assert.equal(snap!.usage?.steps, 2);
    assert.equal(snap!.limits?.max_steps, 50);
    assert.equal(snap!.warning, 'warning');

    // API-style budget field
    const fromApi = extractBudgetSnapshot({
      budget: { steps: 1, tool_calls: 0 },
      budget_limits: { max_steps: 10 },
    });
    assert.ok(fromApi);
    assert.equal(fromApi!.usage?.steps, 1);
  });
});
