/**
 * Display parsing for the subagent-spawn and task-state tool results.
 *
 * Both Agent extensions return `toolOk(toolResultJson(...))`, i.e. a JSON
 * document inside a Pi tool-result envelope. Without these parsers the cards
 * would show the model's wire format to the user, so the envelope unwrapping
 * is the part worth pinning.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  childStatusClass,
  isCheckSubagentToolName,
  isSpawnSubagentToolName,
  isSubagentToolName,
  parseCheckSubagentFields,
  parseSpawnSubagentFields,
  parseToolResultJson,
  summarizeChildren,
  toolErrorCode,
} from '../src/widgets/runtime-steps/subagentFields.ts';
import {
  isMemoryToolName,
  isTaskStateToolName,
  isTodoToolName,
  parseMemoryFields,
  parseTodoFields,
  summarizeTodos,
  todoStatusClass,
  todoStatusIcon,
} from '../src/widgets/runtime-steps/taskStateFields.ts';

/** The exact envelope shape `toolOk(toolResultJson(payload))` produces. */
function envelope(payload: unknown, details?: Record<string, unknown>) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(details ? { details } : {}),
  };
}

const CHILD_A = '01K0G2PAV8FPMVC9QHJG7JPN60';
const CHILD_B = '01K0G2PAV8FPMVC9QHJG7JPN61';

describe('tool result envelope', () => {
  it('unwraps the JSON document out of a Pi tool result', () => {
    assert.deepEqual(parseToolResultJson(envelope({ childRunId: CHILD_A })), {
      childRunId: CHILD_A,
    });
  });

  it('accepts a bare JSON string and an already-parsed payload', () => {
    assert.deepEqual(parseToolResultJson('{"allTerminal":true}'), {
      allTerminal: true,
    });
    assert.deepEqual(parseToolResultJson({ children: [] }), { children: [] });
  });

  it('returns null rather than guessing at unrelated shapes', () => {
    assert.equal(parseToolResultJson(null), null);
    assert.equal(parseToolResultJson('not json'), null);
    assert.equal(parseToolResultJson({ stdout: 'hello' }), null);
  });

  it('surfaces the coded error from a toolErr envelope', () => {
    assert.equal(
      toolErrorCode({
        content: [{ type: 'text', text: 'Error [SUBAGENT_DEPTH_LIMIT]: ...' }],
        details: { code: 'SUBAGENT_DEPTH_LIMIT' },
      }),
      'SUBAGENT_DEPTH_LIMIT',
    );
    assert.equal(toolErrorCode(envelope({ ok: true })), null);
  });
});

describe('spawn_subagent card fields', () => {
  it('reads the task from the args and the child id from the result', () => {
    const fields = parseSpawnSubagentFields(
      { task: '  summarize docs/plan.md  ', label: 'summary' },
      envelope({ childRunId: CHILD_A, label: 'summary', replayed: false }),
    );
    assert.equal(fields.task, 'summarize docs/plan.md');
    assert.equal(fields.label, 'summary');
    assert.equal(fields.childRunId, CHILD_A);
    assert.equal(fields.errorCode, null);
  });

  it('renders a still-running spawn from the args alone', () => {
    const fields = parseSpawnSubagentFields({ task: 'go' }, undefined);
    assert.equal(fields.task, 'go');
    assert.equal(fields.childRunId, null);
    assert.equal(fields.label, null);
  });

  it('surfaces a refusal instead of a child id', () => {
    const fields = parseSpawnSubagentFields(
      { task: 'one too many' },
      {
        content: [{ type: 'text', text: 'Error [SUBAGENT_CONCURRENCY_LIMIT]' }],
        details: { code: 'SUBAGENT_CONCURRENCY_LIMIT' },
      },
    );
    assert.equal(fields.errorCode, 'SUBAGENT_CONCURRENCY_LIMIT');
    assert.equal(fields.childRunId, null);
  });
});

describe('check_subagent card fields', () => {
  it('lists children with status, label and result summary', () => {
    const fields = parseCheckSubagentFields(
      envelope({
        allTerminal: false,
        count: 2,
        children: [
          {
            runId: CHILD_A,
            status: 'SUCCEEDED',
            label: 'first',
            resultSummary: 'the answer is 42',
          },
          { runId: CHILD_B, status: 'QUEUED' },
        ],
      }),
    );
    assert.equal(fields.children.length, 2);
    assert.equal(fields.children[0].label, 'first');
    assert.equal(fields.children[0].resultSummary, 'the answer is 42');
    assert.equal(fields.children[1].status, 'QUEUED');
    assert.equal(fields.children[1].resultSummary, null);
    assert.equal(fields.allTerminal, false);
  });

  it('never reports an empty fan-out as finished', () => {
    const fields = parseCheckSubagentFields(
      envelope({ allTerminal: true, count: 0, children: [] }),
    );
    assert.equal(fields.allTerminal, false, 'no children is not "all done"');
    assert.deepEqual(fields.children, []);
  });

  it('does not trust allTerminal against a non-terminal child', () => {
    const fields = parseCheckSubagentFields(
      envelope({
        allTerminal: true,
        children: [
          { runId: CHILD_A, status: 'SUCCEEDED' },
          { runId: CHILD_B, status: 'RUNNING' },
        ],
      }),
    );
    assert.equal(fields.allTerminal, false);
  });

  it('drops malformed child rows instead of rendering blanks', () => {
    const fields = parseCheckSubagentFields(
      envelope({ children: [{ status: 'SUCCEEDED' }, 'nope', null] }),
    );
    assert.deepEqual(fields.children, []);
  });

  it('summarizes the fleet for the card header', () => {
    assert.equal(summarizeChildren([]), 'no children yet');
    assert.equal(
      summarizeChildren([
        { runId: 'a', status: 'SUCCEEDED', label: null, statusReason: null, resultSummary: null },
        { runId: 'b', status: 'FAILED', label: null, statusReason: null, resultSummary: null },
        { runId: 'c', status: 'RUNNING', label: null, statusReason: null, resultSummary: null },
      ]),
      '1 done · 1 stopped · 1 running',
    );
  });

  it('maps status to a pill class', () => {
    assert.equal(childStatusClass('SUCCEEDED'), 'sa-ok');
    assert.equal(childStatusClass('FAILED'), 'sa-err');
    assert.equal(childStatusClass('CANCELLED'), 'sa-cancel');
    assert.equal(childStatusClass('QUEUED'), 'sa-run');
  });
});

describe('tool name detectors', () => {
  it('recognises the subagent tools only', () => {
    assert.ok(isSpawnSubagentToolName('spawn_subagent'));
    assert.ok(isCheckSubagentToolName('check_subagent'));
    assert.ok(isSubagentToolName('check_subagent'));
    assert.equal(isSubagentToolName('bash'), false);
    assert.equal(isSubagentToolName(null), false);
  });

  it('recognises the task-state tools only', () => {
    assert.ok(isTodoToolName('todo_write'));
    assert.ok(isTodoToolName('todo_read'));
    assert.ok(isMemoryToolName('memory_write'));
    assert.ok(isMemoryToolName('memory_search'));
    assert.ok(isTaskStateToolName('memory_search'));
    assert.equal(isTaskStateToolName('read'), false);
    assert.equal(isTaskStateToolName(undefined), false);
  });
});

describe('todo card fields', () => {
  // 2026-08-31（ADR 0009 / 计划 H9.1）：这条以前叫「prefers the stored list over
  // the arguments」。方向反了——出厂 `dsh-tool-todo` 的 result **不含 todos**
  // （只有 `Updated todo list: …` 文本与 `{counts}`），清单在 `arguments.todos`
  // 与 `todo/write` 事件里。继续「result 优先」的话，换到出厂工具之后卡片会静默
  // 退化成一行文本：不报错，只是清单没了。
  it('takes the list from the arguments — the factory result has no todos', () => {
    const fields = parseTodoFields(
      {
        todos: [
          { position: 2, content: 'second', status: 'in_progress' },
          { position: 1, content: 'first', status: 'completed' },
        ],
      },
      // 出厂结果的真实形状（证据：docs/evidence/2026-08-31-dsh-tool-registry.md H0.5）
      envelope({ counts: { pending: 0, inProgress: 1, completed: 1 } }),
    );
    assert.deepEqual(
      fields.todos.map((t) => [t.position, t.content, t.status]),
      [
        [1, 'first', 'completed'],
        [2, 'second', 'in_progress'],
      ],
      'positions drive the order regardless of the order sent',
    );
  });

  it('还认旧 Pi 会话的两种形状（arguments.items 与 result.todos）', () => {
    // 历史会话里三种形状都存在，卡片要能继续渲染它们。
    const legacyArgs = parseTodoFields({ items: [{ content: 'from items' }] }, envelope({}));
    assert.deepEqual(legacyArgs.todos.map((t) => t.content), ['from items']);

    const legacyResult = parseTodoFields(
      {},
      envelope({ todos: [{ position: 1, content: 'from result', status: 'pending' }] }),
    );
    assert.deepEqual(legacyResult.todos.map((t) => t.content), ['from result']);
  });

  it('renders an in-flight write from the arguments', () => {
    const fields = parseTodoFields(
      { items: [{ content: 'read the spec' }, { content: 'write it', status: 'in_progress' }] },
      undefined,
    );
    assert.deepEqual(
      fields.todos.map((t) => [t.position, t.status]),
      [
        [1, 'pending'],
        [2, 'in_progress'],
      ],
    );
  });

  it('drops empty items and surfaces a coded failure', () => {
    assert.deepEqual(parseTodoFields({ items: [{ content: '   ' }] }).todos, []);
    const failed = parseTodoFields(
      { items: [] },
      { content: [{ type: 'text', text: 'Error' }], details: { code: 'TODO_WRITE_FAILED' } },
    );
    assert.equal(failed.errorCode, 'TODO_WRITE_FAILED');
  });

  it('summarizes progress and maps status to glyph/class', () => {
    assert.equal(summarizeTodos([]), 'empty plan');
    assert.equal(
      summarizeTodos([
        { position: 1, content: 'a', status: 'completed' },
        { position: 2, content: 'b', status: 'pending' },
      ]),
      '1/2 done',
    );
    assert.equal(todoStatusIcon('completed'), '✓');
    assert.equal(todoStatusIcon('in_progress'), '●');
    assert.equal(todoStatusIcon('pending'), '○');
    assert.equal(todoStatusClass('completed'), 'ts-done');
    assert.equal(todoStatusClass('in_progress'), 'ts-active');
    assert.equal(todoStatusClass('pending'), 'ts-todo');
  });
});

describe('memory card fields', () => {
  it('shows what memory_write stored', () => {
    const fields = parseMemoryFields(
      'memory_write',
      { key: 'deploy', content: 'staging deploys need approval' },
      envelope({ memoryId: 'mem-1', key: 'deploy', stored: true }),
    );
    assert.equal(fields.written?.key, 'deploy');
    assert.equal(fields.written?.content, 'staging deploys need approval');
    assert.equal(fields.written?.memoryId, 'mem-1');
    assert.deepEqual(fields.results, []);
  });

  it('lists what memory_search found', () => {
    const fields = parseMemoryFields(
      'memory_search',
      { query: 'approval' },
      envelope({
        count: 1,
        memories: [
          {
            memoryId: 'mem-1',
            key: 'deploy',
            content: 'staging deploys need approval',
            createdAt: '2026-08-22T06:00:00.000Z',
          },
        ],
      }),
    );
    assert.equal(fields.written, null, 'a search stores nothing');
    assert.equal(fields.query, 'approval');
    assert.equal(fields.results.length, 1);
    assert.equal(fields.results[0].key, 'deploy');
  });

  it('ignores note rows with no content', () => {
    const fields = parseMemoryFields(
      'memory_search',
      {},
      envelope({ memories: [{ memoryId: 'x' }, null, 'nope'] }),
    );
    assert.deepEqual(fields.results, []);
  });
});

// ── 工具名换代（ADR 0009 D4 / 计划 H9.3）─────────────────────────────────

describe('工具名换代后的识别', () => {
  it('新旧名字都认——历史会话里两套都存在', async () => {
    const { isAskUserToolName } = await import('../src/widgets/runtime-steps/interactionFields.js');
    const { isSpawnSubagentToolName } = await import('../src/widgets/runtime-steps/subagentFields.js');

    // 出厂名（当前）
    assert.equal(isAskUserToolName('ask_user_question'), true);
    assert.equal(isSpawnSubagentToolName('subagent'), true);
    // 旧 Pi 名（历史会话里有这些调用记录，卡片要能继续渲染）
    assert.equal(isAskUserToolName('ask_user'), true);
    assert.equal(isSpawnSubagentToolName('spawn_subagent'), true);
    // 不相干的名字仍然不认
    assert.equal(isAskUserToolName('bash'), false);
    assert.equal(isSpawnSubagentToolName('bash'), false);
  });

  it('出厂工具面被归到正确的来源类，不落进 unknown', async () => {
    const { inferToolSource } = await import('../src/shared/state/platformEventNormalize.js');
    // 落进 unknown 的后果不是报错，是卡片显示成一块无归属的原始 JSON——
    // 换工具名之后最容易出现的正是这种「不报错但看着不对」。
    for (const name of ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'job_list', 'job_output']) {
      assert.equal(inferToolSource(name, {}), 'sandbox', `${name} 应归到 sandbox`);
    }
    for (const name of ['skill', 'subagent', 'ask_user_question']) {
      assert.equal(inferToolSource(name, {}), 'internal', `${name} 应归到 internal`);
    }
    // 旧 Pi 名（历史会话）同样不能落进 unknown
    for (const name of ['ls', 'find', 'python', 'process_start', 'spawn_subagent', 'ask_user']) {
      assert.notEqual(inferToolSource(name, {}), 'unknown', `${name} 是历史会话里的名字`);
    }
  });
});
