/**
 * F4 / D5 Process Console helpers, API client authority paths, budget display.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import {
  cancelProcess,
  getProcessLogs,
  listProcesses,
  signalProcess,
  writeProcessStdin,
} from '../src/shared/api/processes.ts';
import { createEntityStore, createProcess, upsertProcess } from '../src/entities/index.ts';
import { reducePlatformEventBatch } from '../src/shared/state/runReducer.ts';
import { makeRuntimeEvent } from '../src/shared/schemas/events.ts';

const here = dirname(fileURLToPath(import.meta.url));

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

  it('projects rehydrated process entity buffers into console log lines (D5)', () => {
    const { store } = reducePlatformEventBatch(createEntityStore(), [
      makeRuntimeEvent({
        event_id: 'p1',
        sequence: 1,
        run_id: 'run_pc',
        type: 'process.started',
        payload: { process_id: 'proc_view', command: 'python -u app.py' },
      }),
      makeRuntimeEvent({
        event_id: 'p2',
        sequence: 2,
        run_id: 'run_pc',
        type: 'process.output',
        payload: {
          process_id: 'proc_view',
          stream: 'stdout',
          text: 'line-a\nline-b\n',
        },
      }),
      makeRuntimeEvent({
        event_id: 'p3',
        sequence: 3,
        run_id: 'run_pc',
        type: 'process.output',
        payload: {
          process_id: 'proc_view',
          stream: 'stderr',
          text: 'warn\n',
        },
      }),
    ]);
    const proc = store.processesById.proc_view;
    assert.ok(proc);
    const lines = buildLogLines(proc.stdout, proc.stderr);
    assert.deepEqual(
      lines.map((l) => [l.stream, l.text]),
      [
        ['stdout', 'line-a'],
        ['stdout', 'line-b'],
        ['stderr', 'warn'],
      ],
    );
    const download = formatLogsForDownload(proc.stdout, proc.stderr);
    assert.match(download, /line-a/);
    assert.match(download, /warn/);
  });
});

describe('process API client (owner-scoped BFF authority)', () => {
  it('getProcessLogs hits /api/processes/:id/logs with offset', async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          stdout: 'hist-out\n',
          stderr: 'hist-err\n',
          next_offset: 42,
          completed: false,
          truncated: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const logs = await getProcessLogs('proc_auth', { offset: 10, limit: 1000 });
      assert.equal(logs.stdout, 'hist-out\n');
      assert.equal(logs.stderr, 'hist-err\n');
      assert.equal(logs.next_offset, 42);
      assert.match(urls[0] || '', /\/api\/processes\/proc_auth\/logs\?/);
      assert.match(urls[0] || '', /offset=10/);
      assert.match(urls[0] || '', /limit=1000/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('listProcesses / stdin / signal / cancel use process authority routes', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        method: String(init?.method || 'GET'),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      if (url.includes('/list') || /\/api\/processes\?/.test(url) || url.endsWith('/api/processes')) {
        return new Response(
          JSON.stringify({
            processes: [
              {
                process_id: 'proc_a',
                command: 'sleep 1',
                status: 'running',
                run_id: 'run_a',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const list = await listProcesses({ runId: 'run_a' });
      assert.equal(list[0]?.process_id, 'proc_a');
      assert.ok(calls.some((c) => c.url.includes('/api/processes') && c.url.includes('run_id=run_a')));

      const stdin = await writeProcessStdin('proc_a', 'yes\n');
      assert.equal(stdin.ok, true);
      assert.ok(
        calls.some(
          (c) =>
            c.url.includes('/api/processes/proc_a/stdin') &&
            c.method === 'POST' &&
            c.body?.includes('yes'),
        ),
      );

      const sig = await signalProcess('proc_a', 'SIGTERM');
      assert.equal(sig.ok, true);
      assert.ok(
        calls.some(
          (c) =>
            c.url.includes('/api/processes/proc_a/signal') &&
            c.method === 'POST' &&
            c.body?.includes('SIGTERM'),
        ),
      );

      const cancel = await cancelProcess('proc_a');
      assert.equal(cancel.ok, true);
      assert.ok(
        calls.some(
          (c) =>
            c.url.includes('/api/processes/proc_a/cancel') && c.method === 'POST',
        ),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('ProcessConsole ships dialog, history load, stream filter, download (structural D5)', () => {
    const src = readFileSync(
      join(here, '..', 'src', 'widgets', 'process-console', 'ProcessConsole.tsx'),
      'utf8',
    );
    assert.match(src, /getProcessLogs/);
    assert.match(src, /writeProcessStdin/);
    assert.match(src, /signalProcess/);
    assert.match(src, /cancelProcess/);
    assert.match(src, /role=["']dialog["']/);
    assert.match(src, /aria-label=["']Process console["']/);
    assert.match(src, /Load history/);
    assert.match(src, /Download/);
    assert.match(src, /buildLogLines/);
    assert.match(src, /filterLogLines/);
    assert.match(src, /isProcessInteractive/);
    // Workbench wires the console to the entity process map
    const workbench = readFileSync(
      join(here, '..', 'src', 'pages', 'workbench', 'WorkbenchPage.tsx'),
      'utf8',
    );
    assert.match(workbench, /ProcessConsole/);
    assert.match(workbench, /processesById/);
  });

  it('entity process remains viewable after status completed', () => {
    let store = createEntityStore();
    store = upsertProcess(
      store,
      createProcess({
        id: 'done_p',
        runId: 'r1',
        status: 'completed',
        command: 'echo hi',
        stdout: 'hi\n',
        exitCode: 0,
      }),
    );
    const proc = store.processesById.done_p;
    assert.equal(isProcessInteractive(proc.status), false);
    const lines = buildLogLines(proc.stdout, proc.stderr);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, 'hi');
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
