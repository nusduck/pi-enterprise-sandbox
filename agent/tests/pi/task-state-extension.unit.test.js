/**
 * task-state extension + its bundle wiring.
 *
 * The store this extension talks to is the one the container used to build
 * from `createRepositories().taskState` — a key that did not exist, so every
 * call would have thrown at the first tool use. These tests pin the port
 * contract on both sides: the tools call it with owner scope, and the bundle
 * refuses to build the extension without it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createEnterpriseExtensionBundle,
  createTaskStateExtension,
  extensionFactoryNames,
  REQUIRED_EXTENSION_NAMES,
  TASK_STATE_TOOL_NAMES,
} from '../../src/extensions/index.js';
import { classifyTool } from '../../src/extensions/enterprise-policy/tool-risk-classifier.js';

const RUN_CTX = Object.freeze({
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
  traceId: 'b'.repeat(32),
  executionFenceToken: 3,
});

/** In-memory stand-in for the MySQL-backed store port. */
function fakeStore(overrides = {}) {
  const calls = [];
  let todos = [];
  const memories = [];
  return {
    calls,
    replaceTodos: async (input) => {
      calls.push(['replaceTodos', input]);
      todos = input.items.map((item, index) => ({
        position: index + 1,
        content: item.content,
        status: item.status ?? 'pending',
      }));
      return todos;
    },
    getTodos: async (input) => {
      calls.push(['getTodos', input]);
      return todos;
    },
    appendMemory: async (input) => {
      calls.push(['appendMemory', input]);
      const memory = {
        memoryId: `mem-${memories.length + 1}`,
        key: input.key ?? null,
        content: input.content,
        createdAt: '2026-08-22T06:00:00.000Z',
      };
      memories.push(memory);
      return memory;
    },
    searchMemory: async (input) => {
      calls.push(['searchMemory', input]);
      const q = String(input.query ?? '').toLowerCase();
      return memories.filter(
        (m) => !q || m.content.toLowerCase().includes(q),
      );
    },
    ...overrides,
  };
}

function collectTools(factory) {
  const tools = new Map();
  factory({ registerTool: (d) => tools.set(d.name, d), on: () => {} });
  return tools;
}

function tools(store) {
  return collectTools(
    createTaskStateExtension({
      runContext: RUN_CTX,
      deps: { taskStateStore: store },
    }),
  );
}

function assertToolResultEnvelope(result) {
  assert.ok(Array.isArray(result?.content) && result.content.length > 0);
  assert.equal(result.content[0].type, 'text');
}

describe('task-state extension', () => {
  it('registers the four working-memory tools, all classifiable', () => {
    const registered = [...tools(fakeStore()).keys()];
    assert.deepEqual(registered.sort(), [...TASK_STATE_TOOL_NAMES].sort());
    for (const name of TASK_STATE_TOOL_NAMES) {
      assert.notEqual(classifyTool(name).class, 'unknown');
    }
  });

  it('declares plan/memory usage rules on the tools that implement them', () => {
    const registered = tools(fakeStore());
    const includes = (name, snippet) => {
      const guidelines = registered.get(name).promptGuidelines || [];
      assert.ok(
        guidelines.some((line) => line.includes(snippet)),
        `${name} missing guideline containing ${JSON.stringify(snippet)}`,
      );
    };
    includes('todo_write', 'write the plan with todo_write before the first action');
    includes('todo_read', 'after a restart, compaction, or a new run');
    includes('memory_write', 'not transient run state');
    includes('memory_search', 'Search at the start of a conversation');
  });

  it('round-trips a todo list through the durable store', async () => {
    const store = fakeStore();
    const registered = tools(store);

    const written = await registered.get('todo_write').execute('c1', {
      items: [
        { content: 'read the spec', status: 'completed' },
        { content: 'write the code', status: 'in_progress' },
        { content: 'run the tests' },
      ],
    });
    assertToolResultEnvelope(written);
    assert.equal(written.details.count, 3);

    // A later Run reads the same list back — the point of storing it at all.
    const read = await tools(store).get('todo_read').execute('c2', {});
    const payload = JSON.parse(read.content[0].text);
    assert.deepEqual(
      payload.todos.map((t) => [t.position, t.content, t.status]),
      [
        [1, 'read the spec', 'completed'],
        [2, 'write the code', 'in_progress'],
        [3, 'run the tests', 'pending'],
      ],
    );
  });

  it('scopes every store call to this run’s owner and session', async () => {
    const store = fakeStore();
    const registered = tools(store);
    await registered.get('todo_write').execute('c1', { items: [] });
    await registered.get('memory_write').execute('c2', { content: 'a fact' });
    await registered.get('memory_search').execute('c3', { query: 'fact' });
    for (const [, input] of store.calls) {
      assert.equal(input.orgId, RUN_CTX.orgId);
      assert.equal(input.userId, RUN_CTX.userId);
      assert.equal(input.agentSessionId, RUN_CTX.agentSessionId);
      assert.equal(input.runId, RUN_CTX.runId);
    }
  });

  it('appends and finds durable notes', async () => {
    const store = fakeStore();
    const registered = tools(store);
    const stored = await registered
      .get('memory_write')
      .execute('c1', { key: 'deploy', content: 'staging deploys need approval' });
    assert.equal(stored.details.memoryId, 'mem-1');

    const found = await registered
      .get('memory_search')
      .execute('c2', { query: 'approval' });
    const payload = JSON.parse(found.content[0].text);
    assert.equal(payload.count, 1);
    assert.equal(payload.memories[0].key, 'deploy');
  });

  it('surfaces a store failure as a coded tool error', async () => {
    const failing = fakeStore({
      replaceTodos: async () => {
        throw Object.assign(new Error('todo list is capped at 50 items'), {
          code: 'TODO_LIMIT',
        });
      },
    });
    const result = await tools(failing)
      .get('todo_write')
      .execute('c1', { items: [{ content: 'x' }] });
    assertToolResultEnvelope(result);
    assert.equal(result.details.code, 'TODO_LIMIT');
  });

  it('fails closed when no store is injected', async () => {
    const result = await tools(null).get('todo_read').execute('c1', {});
    assert.equal(result.details.code, 'TASK_STATE_STORE_UNAVAILABLE');
  });
});

describe('task-state bundle wiring', () => {
  const extensions = [...REQUIRED_EXTENSION_NAMES, 'task-state'];

  it('maps deps.taskStateStore onto the extension', async () => {
    const store = fakeStore();
    const factories = createEnterpriseExtensionBundle(RUN_CTX, {
      extensions,
      taskStateStore: store,
      sandboxTransport: {},
    });
    assert.deepEqual(extensionFactoryNames(factories), [
      ...REQUIRED_EXTENSION_NAMES,
      'task-state',
    ]);
    const factory = factories.find((f) => f.extensionName === 'task-state');
    await collectTools(factory).get('todo_read').execute('c1', {});
    assert.deepEqual(store.calls[0][0], 'getTodos');
  });

  it('loads by default when the store is wired and the AgentVersion lists nothing', () => {
    // The shipped AgentVersion config is `extensions: []`, so without this the
    // model never sees todo_write and cannot hold a plan across a compaction.
    const names = extensionFactoryNames(
      createEnterpriseExtensionBundle(RUN_CTX, {
        taskStateStore: fakeStore(),
        sandboxTransport: {},
      }),
    );
    assert.ok(names.includes('task-state'), `expected task-state in ${names.join(', ')}`);
  });

  it('stays off when no durable store is wired', () => {
    // Registering tools that could only ever return TASK_STATE_STORE_UNAVAILABLE
    // is worse than not offering them at all.
    const names = extensionFactoryNames(
      createEnterpriseExtensionBundle(RUN_CTX, { sandboxTransport: {} }),
    );
    assert.ok(!names.includes('task-state'));
  });

  it('an explicit AgentVersion list stays authoritative and can opt out', () => {
    // pi-runtime-factory validates factories against the declared list exactly,
    // so appending to a non-empty list would turn a valid AgentVersion into a
    // PI_EXTENSIONS_COUNT error.
    const names = extensionFactoryNames(
      createEnterpriseExtensionBundle(RUN_CTX, {
        extensions: [...REQUIRED_EXTENSION_NAMES],
        taskStateStore: fakeStore(),
        sandboxTransport: {},
      }),
    );
    assert.deepEqual(names, [...REQUIRED_EXTENSION_NAMES]);
  });

  it('refuses to build the extension with an incomplete store', () => {
    assert.throws(
      () =>
        createEnterpriseExtensionBundle(RUN_CTX, {
          extensions,
          sandboxTransport: {},
          taskStateStore: { getTodos: async () => [] },
        }),
      /TASK_STATE_STORE_REQUIRED/,
    );
    assert.throws(
      () =>
        createEnterpriseExtensionBundle(RUN_CTX, {
          extensions,
          sandboxTransport: {},
        }),
      /TASK_STATE_STORE_REQUIRED/,
    );
  });
});
