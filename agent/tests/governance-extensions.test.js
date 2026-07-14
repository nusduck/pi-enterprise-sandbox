import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskPlanExtension } from '../packages/enterprise-agent-kit/extensions/task-plan/index.js';
import { createInteractionExtension } from '../packages/enterprise-agent-kit/extensions/interaction/index.js';
import {
  createContextManagementExtension,
  ENTERPRISE_COMPACTION_INSTRUCTIONS,
  transformContextMessages,
} from '../packages/enterprise-agent-kit/extensions/context-management/index.js';
import { createStructuredOutputExtension } from '../packages/enterprise-agent-kit/extensions/structured-output/index.js';

function harness(factory) {
  const tools = new Map();
  const handlers = new Map();
  const entries = [];
  factory({
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (name, handler) => handlers.set(name, handler),
    appendEntry: (type, data) => entries.push({ type, data }),
  });
  return { tools, handlers, entries };
}

test('task_plan writes Pi custom entries and database projection callback', async () => {
  const projected = [];
  const loaded = harness(createTaskPlanExtension({ project: (value) => projected.push(value) }));
  const tool = loaded.tools.get('task_plan');
  const created = await tool.execute('call_1', {
    action: 'create',
    task_id: 'T-001',
    content: 'Run integration tests',
    status: 'in_progress',
  });
  assert.equal(created.isError, false);
  await tool.execute('call_2', {
    action: 'complete',
    task_id: 'T-001',
    evidence: 'tests passed',
  });
  assert.equal(loaded.entries.at(-1).type, 'enterprise_task_plan');
  assert.equal(projected.at(-1).tasks[0].status, 'completed');
  assert.equal(projected.at(-1).tasks[0].evidence, 'tests passed');
});

test('ask_user emits durable request and suspends without a long-lived promise', async () => {
  const suspended = [];
  const loaded = harness(createInteractionExtension({
    onInputSuspend: (pending) => suspended.push(pending),
  }));
  await assert.rejects(
    loaded.tools.get('ask_user').execute('call_ask', {
      interaction_type: 'select',
      title: 'Environment',
      options: ['dev', 'prod'],
    }),
    { name: 'InputSuspendedError' },
  );
  assert.match(suspended[0].interaction_id, /^interaction_/);
  assert.equal(suspended[0].tool_call_id, 'call_ask');
});

test('context extension emits warning and requests structured manual compaction', async () => {
  const events = [];
  const loaded = harness(createContextManagementExtension({
    policy: { warningThreshold: 0.8 },
    emit: (event) => events.push(event),
  }));
  loaded.handlers.get('turn_start')({}, {
    getContextUsage: () => ({ tokens: 90, contextWindow: 100, percent: 0.9 }),
  });
  assert.equal(events.some((event) => event.type === 'context_warning'), true);
  let compactOptions = null;
  await loaded.tools.get('context_compact').execute(
    'call_c',
    {},
    null,
    null,
    {
      getContextUsage: () => ({ tokens: 90, contextWindow: 100, percent: 0.9 }),
      compact: (options) => { compactOptions = options; },
    },
  );
  assert.equal(compactOptions.customInstructions, ENTERPRISE_COMPACTION_INSTRUCTIONS);
});

test('structured_output validates JSON Schema and persists valid values', async () => {
  const loaded = harness(createStructuredOutputExtension());
  const tool = loaded.tools.get('structured_output');
  const schema = {
    type: 'object',
    required: ['status'],
    properties: { status: { enum: ['ok'] } },
    additionalProperties: false,
  };
  const invalid = await tool.execute('call_invalid', { schema, value: { status: 'bad' } });
  assert.equal(invalid.isError, true);
  const valid = await tool.execute('call_valid', { schema, value: { status: 'ok' } });
  assert.equal(valid.isError, false);
  assert.equal(loaded.entries.at(-1).type, 'enterprise_structured_output');
});

test('context transform redacts and truncates tool results before provider calls', () => {
  const messages = transformContextMessages([{
    role: 'toolResult',
    content: [{ type: 'text', text: `token=secret ${'x'.repeat(50)}` }],
  }], 24);
  assert.doesNotMatch(messages[0].content[0].text, /token=secret/);
  assert.match(messages[0].content[0].text, /truncated/);
});
