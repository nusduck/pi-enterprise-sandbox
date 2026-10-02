/**
 * F4 / D5 Process Console helpers, API client authority paths, budget display.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildLogLines,
  createProcessPoller,
  filterLogLines,
  formatLogsForDownload,
  formatProcessStatus,
  isProcessInteractive,
} from '../src/widgets/process-console/logHelpers.ts';
import {
  cancelProcess,
  getProcess,
  getProcessLogs,
  listProcesses,
  signalProcess,
  writeProcessStdin,
} from '../src/shared/api/processes.ts';
import { createEntityStore, createProcess, upsertProcess, type ProcessEntity } from '../src/entities/index.ts';
import { ProcessConsole } from '../src/widgets/process-console/ProcessConsole.tsx';
import { ProcessCard } from '../src/widgets/runtime-timeline/cards/ProcessCard.tsx';

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
    assert.equal(isProcessInteractive('created'), true);
    assert.equal(isProcessInteractive('cancel_requested'), true);
    assert.equal(isProcessInteractive('completed'), false);
    assert.equal(isProcessInteractive('failed'), false);
    assert.equal(isProcessInteractive('timeout'), false);
    assert.equal(isProcessInteractive('cancelled'), false);
    assert.equal(isProcessInteractive('orphaned'), false);
  });

  it('formatProcessStatus maps statuses to Chinese', () => {
    assert.equal(formatProcessStatus('running'), '运行中');
    assert.equal(formatProcessStatus('waiting_input'), '等待输入');
    assert.equal(formatProcessStatus('completed'), '已完成');
    assert.equal(formatProcessStatus('failed'), '失败');
    assert.equal(formatProcessStatus('cancelled'), '已取消');
    assert.equal(formatProcessStatus('cancel_requested'), '取消中');
    assert.equal(formatProcessStatus('timeout'), '超时');
    assert.equal(formatProcessStatus('orphaned'), '已遗留');
    assert.equal(formatProcessStatus('created'), '已创建');
  });
});

describe('process API client (session-scoped exec authority)', () => {
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
      const logs = await getProcessLogs('proc_auth', {
        sessionId: 'session_a',
        offset: 10,
        limit: 1000,
      });
      assert.equal(logs.stdout, 'hist-out\n');
      assert.equal(logs.stderr, 'hist-err\n');
      assert.equal(logs.next_offset, 42);
      assert.match(urls[0] || '', /\/api\/processes\/proc_auth\/logs\?/);
      assert.match(urls[0] || '', /offset=10/);
      assert.match(urls[0] || '', /limit=1000/);
      assert.match(urls[0] || '', /session_id=session_a/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('getProcess hits /api/processes/:id with session_id', async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          process_id: 'proc_single',
          session_id: 'session_s',
          status: 'running',
          command: 'sleep 5',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const proc = await getProcess('proc_single', 'session_s');
      assert.equal(proc.process_id, 'proc_single');
      assert.equal(proc.status, 'running');
      assert.match(urls[0] || '', /\/api\/processes\/proc_single\?/);
      assert.match(urls[0] || '', /session_id=session_s/);
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
      const list = await listProcesses({ runId: 'run_a', sessionId: 'session_a' });
      assert.equal(list[0]?.process_id, 'proc_a');
      assert.ok(calls.some((c) => c.url.includes('/api/processes') && c.url.includes('run_id=run_a')));

      const stdin = await writeProcessStdin('proc_a', 'session_a', 'yes\n');
      assert.equal(stdin.ok, true);
      assert.ok(
        calls.some(
          (c) =>
            c.url.includes('/api/processes/proc_a/stdin') &&
            c.method === 'POST' &&
            c.body?.includes('yes'),
        ),
      );

      const sig = await signalProcess('proc_a', 'session_a', 'SIGTERM');
      assert.equal(sig.ok, true);
      assert.ok(
        calls.some(
          (c) =>
            c.url.includes('/api/processes/proc_a/signal') &&
            c.method === 'POST' &&
            c.body?.includes('SIGTERM'),
        ),
      );

      const cancel = await cancelProcess('proc_a', 'session_a');
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
});

describe('process console polling and convergence (fake timers)', () => {
  it('打开即调用 getProcessLogs 并增量轮询，进入终态后停止轮询', async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const logCalls: Array<{ processId: string; offset: number }> = [];
    const processCalls: Array<{ processId: string }> = [];
    const receivedEntities: ProcessEntity[] = [];

    let queryCount = 0;
    const poller = createProcessPoller({
      getProcessLogs: async (pid, opts) => {
        logCalls.push({ processId: pid, offset: opts.offset ?? 0 });
        return {
          stdout: `out-${logCalls.length}\n`,
          stderr: '',
          next_offset: (opts.offset ?? 0) + 10,
          completed: false,
          truncated: false,
        };
      },
      getProcess: async (pid, sid) => {
        processCalls.push({ processId: pid });
        queryCount++;
        // 第一次和第二次运行中，第三次进入终态
        const status = queryCount >= 3 ? 'completed' : 'running';
        return {
          process_id: pid,
          session_id: sid,
          status,
          command: 'tail -f app.log',
          exit_code: status === 'completed' ? 0 : null,
        };
      },
      onProcess: (entity) => {
        receivedEntities.push(entity);
      },
    });

    try {
      const initialProc = createProcess({
        id: 'proc_poll',
        runId: 'run_1',
        sessionId: 'sess_1',
        status: 'running',
        command: 'tail -f app.log',
      });

      // 1. 打开控制台即加载日志（立即触发 pollOnce，无需等待定时器）
      poller.start('proc_poll', 'sess_1', initialProc);
      await Promise.resolve();
      await Promise.resolve();

      assert.equal(logCalls.length, 1, '打开控制台即加载日志');
      assert.equal(logCalls[0].offset, 0);
      assert.equal(processCalls.length, 1);
      assert.equal(poller.isPolling(), true);

      // 2. 2 秒后第一次增量轮询：续读 offset 并刷新状态
      mock.timers.tick(2000);
      await Promise.resolve();
      await Promise.resolve();

      assert.equal(logCalls.length, 2);
      assert.equal(logCalls[1].offset, 10, '增量续读日志');
      assert.equal(processCalls.length, 2);
      assert.equal(receivedEntities[receivedEntities.length - 1].status, 'running');
      assert.equal(poller.isPolling(), true);

      // 3. 再次推进 2 秒：第三次查询返回 completed 终态
      mock.timers.tick(2000);
      await Promise.resolve();
      await Promise.resolve();

      assert.equal(logCalls.length, 3);
      assert.equal(processCalls.length, 3);
      assert.equal(receivedEntities[receivedEntities.length - 1].status, 'completed');
      assert.equal(receivedEntities[receivedEntities.length - 1].exitCode, 0);
      assert.equal(poller.isPolling(), false, '进入终态后停止轮询');

      // 4. 终态后定时器已停止，继续推进时间不再产生任何多余调用
      mock.timers.tick(4000);
      await Promise.resolve();
      assert.equal(logCalls.length, 3);
      assert.equal(processCalls.length, 3);
    } finally {
      poller.stop();
      mock.timers.reset();
    }
  });

  it('已处于终态的进程打开时不启动轮询', async () => {
    let logCallCount = 0;
    const poller = createProcessPoller({
      getProcessLogs: async () => {
        logCallCount++;
        return { stdout: '', stderr: '', next_offset: 0, completed: true, truncated: false };
      },
      getProcess: async () => {
        return { process_id: 'proc_done', status: 'completed', command: 'cmd' };
      },
    });

    const doneProc = createProcess({
      id: 'proc_done',
      runId: 'r1',
      sessionId: 's1',
      status: 'completed',
      command: 'cmd',
    });

    poller.start('proc_done', 's1', doneProc);
    await Promise.resolve();

    assert.equal(logCallCount, 1, '终态进程打开也加载一次日志');
    assert.equal(poller.isPolling(), false, '终态不启动轮询');
    poller.stop();
  });

  it('cancel 后立即重新查询状态与日志并更新显示写回 store', async () => {
    let cancelCalled = false;
    let processQueryCount = 0;
    let logQueryCount = 0;
    let updatedEntity: ProcessEntity | null = null;

    const poller = createProcessPoller({
      getProcessLogs: async () => {
        logQueryCount++;
        return { stdout: 'final-log\n', stderr: '', next_offset: 50, completed: true, truncated: false };
      },
      getProcess: async (pid, sid) => {
        processQueryCount++;
        return {
          process_id: pid,
          session_id: sid,
          status: cancelCalled ? 'cancelled' : 'running',
          command: 'sleep 100',
          exit_code: cancelCalled ? 130 : null,
        };
      },
      onProcess: (entity) => {
        updatedEntity = entity;
      },
    });

    const currentProc = createProcess({
      id: 'proc_cancel',
      runId: 'r1',
      sessionId: 'sess_cancel',
      status: 'running',
      command: 'sleep 100',
    });

    // 模拟取消进程调用
    cancelCalled = true;
    const res = await poller.pollOnce('proc_cancel', 'sess_cancel', currentProc);

    assert.ok(res.entity);
    assert.equal(res.entity.status, 'cancelled');
    assert.equal(res.entity.exitCode, 130);
    assert.equal(updatedEntity?.status, 'cancelled');
    assert.equal(updatedEntity?.exitCode, 130);
    assert.equal(processQueryCount, 1);
    assert.equal(logQueryCount, 1);

    // 同步写回实体 store
    let store = createEntityStore();
    store = upsertProcess(store, updatedEntity!);
    assert.equal(store.processesById.proc_cancel.status, 'cancelled');
    assert.equal(store.processesById.proc_cancel.exitCode, 130);
  });
});

describe('process UI rendering and localization', () => {
  it('ProcessConsole ships dialog, history load, stream filter, download (structural D5)', () => {
    const src = readFileSync(
      join(here, '..', 'src', 'widgets', 'process-console', 'ProcessConsole.tsx'),
      'utf8',
    );
    assert.match(src, /getProcessLogs/);
    assert.match(src, /getProcess/);
    assert.match(src, /writeProcessStdin/);
    assert.match(src, /signalProcess/);
    assert.match(src, /cancelProcess/);
    assert.match(src, /role=["']dialog["']/);
    assert.match(src, /aria-label=["']进程控制台["']/);
    assert.match(src, /加载历史/);
    assert.match(src, /下载日志/);
    assert.match(src, /取消进程/);
    assert.match(src, /确认取消？/);
    assert.doesNotMatch(src, /window\.confirm/);
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
    assert.match(workbench, /onUpdateProcess=\{updateProcess\}/);
  });

  it('ProcessConsole 渲染结果包含关键中文按钮且无英文残留', () => {
    const proc = createProcess({
      id: 'p_zh_test',
      runId: 'r1',
      sessionId: 'sess_1',
      status: 'running',
      command: 'python app.py',
    });

    const html = renderToStaticMarkup(
      React.createElement(ProcessConsole, {
        process: proc,
        open: true,
        onClose: () => {},
      }),
    );

    // 断言关键中文元素与按钮
    assert.match(html, /进程控制台/);
    assert.match(html, /加载历史/);
    assert.match(html, /下载日志/);
    assert.match(html, /取消进程/);
    assert.match(html, /自动滚动/);
    assert.match(html, /搜索日志/);
    assert.match(html, /标准输入/);
    assert.match(html, /发送 EOF/);
    assert.match(html, /全部/);
    assert.match(html, /标准输出/);
    assert.match(html, /标准错误/);
    assert.match(html, /暂无日志输出/);
    assert.match(html, /运行中/);

    // 断言无英文残留
    assert.doesNotMatch(html, /Process Console/);
    assert.doesNotMatch(html, /Open Console/);
    assert.doesNotMatch(html, /Cancel process/);
    assert.doesNotMatch(html, /Cancel this process\?/);
    assert.doesNotMatch(html, /Load history/);
    assert.doesNotMatch(html, /Search logs…/);
    assert.doesNotMatch(html, /Auto-scroll/);
    assert.doesNotMatch(html, /No log output yet/);
    assert.doesNotMatch(html, /Loaded history/);
    assert.doesNotMatch(html, /window\.confirm/);
  });

  it('ProcessCard 渲染包含中文按钮且无英文残留', () => {
    const proc = createProcess({
      id: 'p_card_test',
      runId: 'r1',
      sessionId: 'sess_1',
      status: 'running',
      command: 'tail -f app.log',
    });

    const html = renderToStaticMarkup(
      React.createElement(ProcessCard, {
        process: proc,
      }),
    );

    assert.match(html, /打开控制台/);
    assert.match(html, /运行中/);
    assert.doesNotMatch(html, /Open Console/);
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
        exitCode: 0,
      }),
    );
    const proc = store.processesById.done_p;
    assert.equal(isProcessInteractive(proc.status), false);
    assert.equal(proc.command, 'echo hi');
    assert.equal(proc.exitCode, 0);
  });
});
