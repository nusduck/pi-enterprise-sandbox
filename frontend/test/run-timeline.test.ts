/**
 * 管理端 Run 详情时间线。事件形状取自真实会话的持久事件
 * （GET /api/conversations/:id/events，payload.data 包裹）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunTimeline, formatSpan, toolLabel } from '../src/pages/runs/runTimeline.ts';

const RUN = 'run_1';
let seq = 0;
function ev(type: string, at: string, data: Record<string, unknown> = {}, runId = RUN) {
  seq += 1;
  return { run_id: runId, sequence: seq, event_id: `e${seq}`, type, payload: { data, context: { runId } }, created_at: `2026-09-25T04:00:${at}Z` };
}

function fixture() {
  seq = 0;
  return [
    ev('run.accepted', '00.000', { status: 'ACCEPTED' }),
    ev('run.status.changed', '02.000', { from: 'STARTING', to: 'RUNNING' }),
    ev('thinking.delta', '03.000', { delta: 'I' }),
    ev('thinking.completed', '04.000', { text: '需要最新数据' }),
    // DSH emits the tool start just before the round's message.completed.
    ev('tool.execution.started', '04.990', { toolName: 'mcp__exa__web_search_exa', toolCallId: 'call_a', args: { query: 'Go 最新版本' } }),
    ev('message.completed', '05.000', {
      text: '先搜索一下。',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          { type: 'reasoning', text: '需要最新…', truncated: true },
          { type: 'text', text: '先搜索一下。' },
          { type: 'tool-call' },
        ],
      },
    }),
    ev('approval.requested', '05.200', { approvalId: 'ap_1', toolName: 'mcp__exa__web_search_exa', toolCallId: 'call_a', riskLevel: 'high' }),
    ev('approval.resolved', '15.200', { approvalId: 'ap_1', decision: 'approve', status: 'APPROVED', decisionBy: 'u1' }),
    ev('tool.execution.completed', '16.000', { toolCallId: 'call_a', result: { content: [{ type: 'text', text: 'Go 1.25.1' }], isError: false } }),
    ev('message.delta', '17.000', { delta: 'Go' }),
    ev('message.completed', '18.000', { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '最新版本是 Go 1.25.1。' }] } }),
    ev('run.completed', '18.500', { status: 'SUCCEEDED' }),
    ev('message.delta', '19.000', { delta: 'other run' }, 'run_other'),
  ];
}

describe('buildRunTimeline', () => {
  it('rebuilds queue, model rounds, tools and approval waits in order', () => {
    const tl = buildRunTimeline({
      runId: RUN,
      events: fixture(),
      tools: [{ tool_call_id: 'call_a', run_id: RUN, status: 'SUCCEEDED', risk_level: 'high', tool_source: 'mcp' }],
      userInput: 'Go 最新版本是多少？',
    });
    assert.deepEqual(
      tl.nodes.map((n) => [n.kind, n.depth, n.name, n.status]),
      [
        ['run', 0, '运行', 'ok'],
        ['queue', 1, '排队等待', 'ok'],
        ['model', 1, '模型 · 第 1 轮', 'ok'],
        ['tool', 2, 'mcp__exa__web_search_exa · Go 最新版本', 'ok'],
        ['wait', 2, '审批等待 · mcp__exa__web_search_exa', 'approved'],
        ['model', 1, '模型 · 第 2 轮（最终回答）', 'ok'],
      ],
    );
    assert.equal(tl.modelRounds, 2);
    assert.equal(tl.toolCalls, 1);
    assert.equal(tl.approvals, 1);
    assert.equal(tl.end - tl.start, 18_500);
  });

  it('carries the content an admin needs: thinking, output, tool calls, args and results', () => {
    const tl = buildRunTimeline({ runId: RUN, events: fixture(), userInput: 'Go 最新版本是多少？' });
    const [root, , first, tool, wait, last] = tl.nodes;
    assert.deepEqual(root.blocks, [{ title: '用户输入', kind: 'text', body: 'Go 最新版本是多少？' }]);
    assert.deepEqual(first.blocks.map((b) => [b.title, b.body]), [
      ['思考', '需要最新数据'],
      ['输出', '先搜索一下。'],
      ['工具调用', 'mcp__exa__web_search_exa({"query":"Go 最新版本"})'],
    ]);
    // A round starts when the model was asked (run → RUNNING), not at its first token.
    assert.equal(first.start, Date.parse('2026-09-25T04:00:02.000Z'));
    assert.deepEqual(tool.blocks.map((b) => b.title), ['参数', '结果']);
    assert.equal(tool.blocks[1].body, 'Go 1.25.1');
    assert.ok(wait.kv.some(([k, v]) => k === '等待' && v === '10.0s'));
    // The second round starts after the tool result, not after the approval.
    assert.equal(last.start, Date.parse('2026-09-25T04:00:16.000Z'));
  });

  it('says so when a round called tools that were never started', () => {
    seq = 0;
    const events = [
      ev('message.completed', '01.000', { message: { content: [{ type: 'tool-call' }, { type: 'tool-call' }] } }),
    ];
    const [, round] = buildRunTimeline({ runId: RUN, events }).nodes;
    assert.deepEqual(round.blocks, [{ title: '工具调用', kind: 'text', body: '2 次（参数未持久化）' }]);
  });

  it('shows bash stdout and the subtask prompt / conclusion instead of raw JSON', () => {
    seq = 0;
    const events = [
      ev('tool.execution.started', '01.000', { toolName: 'bash', toolCallId: 'b', args: { command: 'ls -la /tmp' } }),
      ev('tool.execution.completed', '01.500', { toolCallId: 'b', result: { value: { stdout: { text: 'total 0\n' }, stderr: { text: '' }, exitCode: 0 } } }),
      ev('tool.execution.started', '02.000', { toolName: 'subagent', toolCallId: 's', args: { description: 'Inspect /tmp', prompt: '检查 /tmp' } }),
      ev('tool.execution.completed', '09.000', { toolCallId: 's', result: { value: { runId: 'sub_1', output: [{ type: 'text', text: '/tmp 是空的' }] } } }),
    ];
    const tl = buildRunTimeline({ runId: RUN, events });
    const bash = tl.nodes.find((n) => n.id === 'tool-b')!;
    assert.deepEqual(bash.blocks, [
      { title: '命令', kind: 'pre', body: 'ls -la /tmp' },
      { title: 'stdout', kind: 'pre', body: 'total 0\n' },
    ]);
    assert.ok(bash.kv.some(([k, v]) => k === '退出码' && v === '0'));
    const sub = tl.nodes.find((n) => n.id === 'tool-s')!;
    assert.equal(sub.kind, 'sub');
    assert.equal(sub.name, 'subagent · Inspect /tmp');
    assert.deepEqual(sub.blocks.map((b) => [b.title, b.body]), [['完整 prompt', '检查 /tmp'], ['结论', '/tmp 是空的']]);
  });

  it('leaves unfinished nodes open while the run is still going', () => {
    seq = 0;
    const events = [ev('run.accepted', '00.000'), ev('message.delta', '01.000', { delta: 'x' })];
    const tl = buildRunTimeline({ runId: RUN, events, now: Date.parse('2026-09-25T04:00:05.000Z') });
    assert.equal(tl.nodes[0].status, 'running');
    assert.equal(tl.nodes[1].status, 'running');
    assert.equal(tl.nodes[1].end, null);
    assert.equal(tl.end - tl.start, 5000);
  });
});

describe('labels', () => {
  it('names tools by their most telling argument', () => {
    assert.equal(toolLabel('read', { path: 'a.md' }), 'read · a.md');
    assert.equal(toolLabel('todo_write', { todos: [{}, {}] }), 'todo_write · 2 项');
    assert.equal(toolLabel('job_list', {}), 'job_list');
  });

  it('formats span durations', () => {
    assert.equal(formatSpan(420), '420ms');
    assert.equal(formatSpan(6400), '6.4s');
    assert.equal(formatSpan(124_000), '2m04s');
  });
});
