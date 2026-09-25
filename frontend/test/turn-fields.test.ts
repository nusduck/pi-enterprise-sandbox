/**
 * 线性对话流的卡片字段。样例载荷取自 agent 工具台账的真实行
 * （tbl_agsvc_tool_executions，去掉 $v/$integrity 外壳）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDurationMs,
  jobFields,
  questionFields,
  subtaskFields,
  summarizeToolGroup,
  toolVerb,
} from '../src/features/chat/projections/turnFields.ts';

describe('summarizeToolGroup', () => {
  it('counts categories in order of first appearance', () => {
    const tools = ['read', 'bash', 'bash', 'grep'].map((name) => ({ name }));
    assert.equal(summarizeToolGroup(tools), '读取 1 个文件，运行 2 条命令，搜索 1 次内容');
  });

  it('names MCP and unknown tools without leaking wire names', () => {
    const tools = [{ name: 'mcp__exa__web_search_exa' }, { name: 'custom_tool' }];
    assert.equal(summarizeToolGroup(tools), '调用 1 次外部工具，调用 1 个工具');
    assert.equal(toolVerb('mcp__exa__web_search_exa'), '调用 exa.web_search_exa');
  });
});

describe('subtaskFields', () => {
  it('reads the conclusion from a foreground subagent result', () => {
    const f = subtaskFields({
      input: { prompt: 'You are child agent B…', description: 'Inspect frontend entry' },
      result: {
        value: { kind: 'foreground', runId: 'sub_vtjt9ow1', output: [{ text: '- **VERDICT**: NOT_FOUND' }] },
        content: [{ type: 'text', text: 'ignored' }],
        isError: false,
      },
      isError: false,
    });
    assert.equal(f.title, 'Inspect frontend entry');
    assert.equal(f.childRunId, 'sub_vtjt9ow1');
    assert.equal(f.conclusion, '- **VERDICT**: NOT_FOUND');
    assert.equal(f.agent, null);
    assert.equal(f.error, null);
  });

  it('reports a delegation to another agent that was aborted', () => {
    const f = subtaskFields({
      input: { agent: 'deleg-analyst', prompt: 'Run sleep 120', description: 'Run sleep 120 then reply' },
      result: {
        error: { info: { code: 'ABORTED' }, message: 'tool call aborted' },
        content: [{ text: 'Error: tool call aborted', type: 'text' }],
        isError: true,
      },
      isError: true,
    });
    assert.equal(f.agent, 'deleg-analyst');
    assert.equal(f.error, 'tool call aborted');
    assert.equal(f.conclusion, null);
  });

  it('marks a remote delegation rejected at the approval gate', () => {
    const f = subtaskFields({
      input: { agent: 'loopback-analyst', prompt: 'What is 19 * 21?', description: 'multiply' },
      result: { reason: null, decision: 'reject', approvalId: '01M39Z53CRVDDZ7JA0696V9DBX' },
      isError: true,
    });
    assert.equal(f.rejected, true);
    assert.equal(f.error, '审批被拒绝');
  });
});

describe('questionFields', () => {
  it('parses the DSH questions[] shape and the answer', () => {
    const f = questionFields({
      input: {
        questions: [{
          id: 'color_choice', header: 'Choose a Color', question: 'Which color do you choose?',
          multi_select: false,
          options: [{ label: 'red', description: 'Choose red.' }, { label: 'blue', description: 'Choose blue.' }],
        }],
      },
      result: { response: 'blue', interactionId: '01M2X9ENFNJ5X6JEZQAHFVYXFZ' },
    });
    assert.equal(f.question, 'Which color do you choose?');
    assert.equal(f.header, 'Choose a Color');
    assert.deepEqual(f.options.map((o) => o.label), ['red', 'blue']);
    assert.equal(f.answer, 'blue');
  });

  it('falls back to the pending interaction while the tool has no args yet', () => {
    const f = questionFields({ input: null, result: null }, { title: 'Pick one', options: ['a', 'b'] });
    assert.equal(f.question, 'Pick one');
    assert.deepEqual(f.options.map((o) => o.label), ['a', 'b']);
    assert.equal(f.answer, null);
  });
});

describe('jobFields', () => {
  it('shows the tail of the newest job_output and keeps running state', () => {
    const f = jobFields(
      { input: { command: 'for i in $(seq 1 300); do echo TICK-$i; sleep 1; done', run_in_background: true } },
      [{
        name: 'job_output',
        isError: false,
        result: {
          value: { job: { id: 'bash-70f3', kind: 'bash', status: 'running' }, text: 'TICK-1\nTICK-2\n' },
          content: [{ text: 'TICK-1\nTICK-2\n[status: running]', type: 'text' }],
          isError: false,
        },
      }],
    );
    assert.equal(f.running, true);
    assert.equal(f.outputTail, 'TICK-1\nTICK-2');
  });

  it('reports an unknown state before any job_output', () => {
    assert.equal(jobFields({ input: { command: 'sleep 5' } }, []).running, null);
  });

  it('stops after a successful job_kill', () => {
    const f = jobFields({ input: { command: 'sleep 120' } }, [{ name: 'job_kill', isError: false, result: {} }]);
    assert.equal(f.running, false);
  });
});

describe('formatDurationMs', () => {
  it('formats short and long durations', () => {
    assert.equal(formatDurationMs(420), '420ms');
    assert.equal(formatDurationMs(1900), '1.9s');
    assert.equal(formatDurationMs(34_000), '34s');
    assert.equal(formatDurationMs(124_000), '2分04秒');
    assert.equal(formatDurationMs(null), '');
  });
});
