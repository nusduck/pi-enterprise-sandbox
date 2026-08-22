/**
 * subagent-spawn extension + its bundle wiring.
 *
 * Every assertion here corresponds to one way the first version of this
 * extension was inert: the container's dep name never reached the extension,
 * the executor's per-version limits never reached it either, the depth it
 * checked was never written into the run context, the concurrency cap was
 * computed and dropped, and the tool results were bare objects the SDK cannot
 * hand to a model.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertEnterpriseRunContext,
  createEnterpriseExtensionBundle,
  createSubagentSpawnExtension,
  extensionFactoryNames,
  REQUIRED_EXTENSION_NAMES,
  SUBAGENT_TOOL_NAMES,
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

const CHILD_RUN_ID = '01K0G2PAV8FPMVC9QHJG7JPN60';

function fakePort(overrides = {}) {
  const calls = { spawn: [], getStatuses: [] };
  return {
    calls,
    spawn: async (input) => {
      calls.spawn.push(input);
      return { runId: CHILD_RUN_ID, replayed: false };
    },
    getStatuses: async (input) => {
      calls.getStatuses.push(input);
      return [
        { runId: CHILD_RUN_ID, status: 'SUCCEEDED', resultSummary: 'done' },
      ];
    },
    ...overrides,
  };
}

function collectTools(factory) {
  const tools = new Map();
  factory({ registerTool: (d) => tools.set(d.name, d), on: () => {} });
  return tools;
}

/** @param {object} deps @param {object} [ctx] */
function tools(deps, ctx = RUN_CTX) {
  return collectTools(
    createSubagentSpawnExtension({ runContext: ctx, deps }),
  );
}

/** Pi requires `content` on every tool result; assert the envelope, not a bag. */
function assertToolResultEnvelope(result) {
  assert.ok(Array.isArray(result?.content), 'result.content must be an array');
  assert.ok(result.content.length > 0, 'result.content must not be empty');
  for (const part of result.content) {
    assert.equal(part.type, 'text');
    assert.equal(typeof part.text, 'string');
  }
}

describe('subagent-spawn extension', () => {
  it('registers exactly the two sub-agent tools, both classifiable', () => {
    const registered = [...tools({ spawnPort: fakePort() }).keys()];
    assert.deepEqual(registered.sort(), [...SUBAGENT_TOOL_NAMES].sort());
    for (const name of SUBAGENT_TOOL_NAMES) {
      assert.notEqual(classifyTool(name).class, 'unknown');
    }
  });

  it('returns Pi tool-result envelopes, not bare objects', async () => {
    const port = fakePort();
    const registered = tools({ spawnPort: port });

    const spawned = await registered
      .get('spawn_subagent')
      .execute('call-1', { task: 'summarize the changelog', label: 'sum' });
    assertToolResultEnvelope(spawned);
    assert.match(spawned.content[0].text, /01K0G2PAV8FPMVC9QHJG7JPN60/);
    assert.equal(spawned.details.childRunId, CHILD_RUN_ID);

    const checked = await registered.get('check_subagent').execute('call-2', {});
    assertToolResultEnvelope(checked);
    assert.equal(checked.details.allTerminal, true);
    assert.match(checked.content[0].text, /"resultSummary":"done"/);
  });

  it('passes this run identity and tool call id to the durable port', async () => {
    const port = fakePort();
    await tools({ spawnPort: port })
      .get('spawn_subagent')
      .execute('call-77', { task: '  do the thing  ' });
    assert.equal(port.calls.spawn.length, 1);
    assert.deepEqual(
      {
        toolCallId: port.calls.spawn[0].toolCallId,
        parentRunId: port.calls.spawn[0].parentRunId,
        orgId: port.calls.spawn[0].orgId,
        task: port.calls.spawn[0].task,
      },
      {
        toolCallId: 'call-77',
        parentRunId: RUN_CTX.runId,
        orgId: RUN_CTX.orgId,
        task: 'do the thing',
      },
    );
  });

  it('refuses to spawn once the run is at the depth cap', async () => {
    const port = fakePort();
    const atDepth = tools(
      { spawnPort: port, maxDepth: 2 },
      { ...RUN_CTX, subagentDepth: 2 },
    );
    const result = await atDepth
      .get('spawn_subagent')
      .execute('call-1', { task: 'go deeper' });
    assertToolResultEnvelope(result);
    assert.equal(result.details.code, 'SUBAGENT_DEPTH_LIMIT');
    assert.equal(port.calls.spawn.length, 0, 'must not reach the durable port');
  });

  it('reads maxDepth / maxConcurrent from deps and forwards them', async () => {
    const port = fakePort();
    const registered = tools({ spawnPort: port, maxDepth: 3, maxConcurrent: 2 });

    // A run one below the raised cap may still spawn.
    const deep = tools(
      { spawnPort: port, maxDepth: 3 },
      { ...RUN_CTX, subagentDepth: 2 },
    );
    const ok = await deep
      .get('spawn_subagent')
      .execute('call-1', { task: 'still allowed' });
    assert.equal(ok.details.childRunId, CHILD_RUN_ID);
    assert.equal(port.calls.spawn.at(-1).maxDepth, 3);

    // maxConcurrent is not computed-and-dropped: it bounds the poll schema and
    // travels to the port, which enforces it durably.
    await registered.get('spawn_subagent').execute('call-2', { task: 'x' });
    assert.equal(port.calls.spawn.at(-1).maxConcurrent, 2);
    assert.equal(
      registered.get('check_subagent').parameters.properties.child_run_ids
        .maxItems,
      2,
    );
  });

  it('surfaces a coded port failure as a tool error the model can read', async () => {
    const failing = fakePort({
      spawn: async () => {
        throw Object.assign(new Error('at most 5 sub-agents may run at once'), {
          code: 'SUBAGENT_CONCURRENCY_LIMIT',
        });
      },
    });
    const result = await tools({ spawnPort: failing })
      .get('spawn_subagent')
      .execute('call-1', { task: 'one too many' });
    assertToolResultEnvelope(result);
    assert.equal(result.details.code, 'SUBAGENT_CONCURRENCY_LIMIT');
  });

  it('fails closed when no durable port is injected', async () => {
    const result = await tools({})
      .get('spawn_subagent')
      .execute('call-1', { task: 'x' });
    assert.equal(result.details.code, 'SUBAGENT_PORT_UNAVAILABLE');
  });

  it('does not report an empty child list as a finished fan-out', async () => {
    const empty = fakePort({ getStatuses: async () => [] });
    const result = await tools({ spawnPort: empty })
      .get('check_subagent')
      .execute('call-1', {});
    assert.equal(result.details.allTerminal, false);
    assert.equal(result.details.count, 0);
  });
});

describe('subagent-spawn bundle wiring', () => {
  const extensions = [...REQUIRED_EXTENSION_NAMES, 'subagent-spawn'];

  it('maps deps.subagentSpawnPort onto the extension port', async () => {
    const port = fakePort();
    const factories = createEnterpriseExtensionBundle(RUN_CTX, {
      extensions,
      subagentSpawnPort: port,
      sandboxTransport: {},
    });
    assert.deepEqual(extensionFactoryNames(factories), [
      ...REQUIRED_EXTENSION_NAMES,
      'subagent-spawn',
    ]);
    const factory = factories.find((f) => f.extensionName === 'subagent-spawn');
    const registered = collectTools(factory);
    await registered.get('spawn_subagent').execute('call-1', { task: 'x' });
    assert.equal(
      port.calls.spawn.length,
      1,
      'container dep name must reach the extension',
    );
  });

  it('applies the AgentVersion subagentSpawn policy the executor passes', async () => {
    const port = fakePort();
    const factories = createEnterpriseExtensionBundle(
      { ...RUN_CTX, subagentDepth: 1 },
      {
        extensions,
        subagentSpawnPort: port,
        subagentSpawn: { maxDepth: 1, maxConcurrent: 3 },
        sandboxTransport: {},
      },
    );
    const factory = factories.find((f) => f.extensionName === 'subagent-spawn');
    const result = await collectTools(factory)
      .get('spawn_subagent')
      .execute('call-1', { task: 'x' });
    assert.equal(
      result.details.code,
      'SUBAGENT_DEPTH_LIMIT',
      'a version-scoped maxDepth of 1 must stop a depth-1 run',
    );
  });

  it('refuses to build the extension without a durable port', () => {
    assert.throws(
      () =>
        createEnterpriseExtensionBundle(RUN_CTX, {
          extensions,
          sandboxTransport: {},
        }),
      /SUBAGENT_PORT_REQUIRED/,
    );
  });

  it('does not give a child run the ask_user tool', () => {
    // A child's conversation is deliberately out of the owner's list and its
    // task prompt is contractually self-contained, so nothing routes a child's
    // question to a human. Registering ask_user would let it park in
    // WAITING_INPUT forever, waiting for an answer nobody sees it asking for.
    const port = fakePort();
    const build = (ctx) =>
      collectTools(
        createEnterpriseExtensionBundle(ctx, {
          extensions,
          subagentSpawnPort: port,
          sandboxTransport: {},
        }).find((f) => f.extensionName === 'user-interaction'),
      );

    assert.ok(build(RUN_CTX).has('ask_user'), 'a top-level run keeps ask_user');
    assert.equal(
      build({ ...RUN_CTX, subagentDepth: 1 }).has('ask_user'),
      false,
      'a sub-agent run must not be able to park on ask_user',
    );
  });

  it('carries subagentDepth through the frozen run context', () => {
    assert.equal(assertEnterpriseRunContext(RUN_CTX).subagentDepth, 0);
    assert.equal(
      assertEnterpriseRunContext({ ...RUN_CTX, subagentDepth: 2 })
        .subagentDepth,
      2,
    );
    for (const bad of [-1, 1.5, '1', {}]) {
      assert.throws(
        () => assertEnterpriseRunContext({ ...RUN_CTX, subagentDepth: bad }),
        /subagentDepth/,
        `subagentDepth ${JSON.stringify(bad)} must be refused, not coerced`,
      );
    }
  });
});
