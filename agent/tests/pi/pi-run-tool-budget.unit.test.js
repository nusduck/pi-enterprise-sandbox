import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  installPiRunToolBudget,
  resolvePiRunToolBudget,
} from '../../src/application/pi-run-tool-budget.js';

function createSession() {
  const policyCalls = [];
  const agent = {
    state: { tools: [{ name: 'read' }, { name: 'bash' }] },
    beforeToolCall: async (context) => {
      policyCalls.push(context.toolCall.name);
      return undefined;
    },
    prepareNextTurnWithContext: async (turn) => ({
      context: {
        ...turn.context,
        tools: agent.state.tools.slice(),
      },
    }),
  };
  return { session: { agent }, agent, policyCalls };
}

function toolContext(name, args) {
  return { toolCall: { name }, args };
}

describe('Pi Run tool budget', () => {
  it('keeps existing policy hooks, then forces a no-tool final turn at the cap', async () => {
    const { session, agent, policyCalls } = createSession();
    const originalBefore = agent.beforeToolCall;
    const guard = installPiRunToolBudget(session, {
      maxToolCalls: 2,
      maxIdenticalToolCalls: 2,
      maxModelTurns: 8,
    });

    assert.equal((await agent.beforeToolCall(toolContext('read', { path: 'a' })))?.block, undefined);
    assert.equal((await agent.beforeToolCall(toolContext('bash', { command: 'ls' })))?.block, undefined);
    assert.deepEqual(policyCalls, ['read', 'bash']);

    const next = await agent.prepareNextTurnWithContext({
      context: { systemPrompt: 'base prompt', tools: agent.state.tools },
    });
    assert.deepEqual(next.context.tools, []);
    assert.match(next.context.systemPrompt, /tool call limit \(2\)/);
    assert.match(next.context.systemPrompt, /final answer now/i);

    const blocked = await agent.beforeToolCall(toolContext('read', { path: 'b' }));
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /RUN_TOOL_BUDGET_EXHAUSTED/);
    assert.equal(guard.snapshot().toolCalls, 2);

    guard.dispose();
    assert.equal(agent.beforeToolCall, originalBefore);
  });

  it('blocks repeated equivalent calls even when object key order differs', async () => {
    const { session, agent } = createSession();
    const guard = installPiRunToolBudget(session, {
      maxToolCalls: 10,
      maxIdenticalToolCalls: 1,
      maxModelTurns: 10,
    });

    assert.equal(
      (await agent.beforeToolCall(toolContext('read', { path: 'a.txt', offset: 0 })))?.block,
      undefined,
    );
    const blocked = await agent.beforeToolCall(
      toolContext('read', { offset: 0, path: 'a.txt' }),
    );
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /RUN_TOOL_REPEAT_LIMIT/);

    const next = await agent.prepareNextTurnWithContext({
      context: { systemPrompt: 'base prompt', tools: agent.state.tools },
    });
    assert.deepEqual(next.context.tools, []);
    assert.match(next.context.systemPrompt, /identical tool call limit/);
    guard.dispose();
  });

  it('limits by model turns and restores the prior hooks after the Run', async () => {
    const { session, agent } = createSession();
    const originalBefore = agent.beforeToolCall;
    const originalPrepare = agent.prepareNextTurnWithContext;
    const guard = installPiRunToolBudget(session, {
      maxToolCalls: 10,
      maxIdenticalToolCalls: 2,
      maxModelTurns: 1,
    });

    const next = await agent.prepareNextTurnWithContext({
      context: { systemPrompt: 'base prompt', tools: agent.state.tools },
    });
    assert.deepEqual(next.context.tools, []);
    assert.match(next.context.systemPrompt, /model turn limit \(1\)/);

    guard.dispose();
    assert.equal(agent.beforeToolCall, originalBefore);
    assert.equal(agent.prepareNextTurnWithContext, originalPrepare);
  });

  it('uses safe defaults and rejects invalid deployment configuration', () => {
    assert.deepEqual(resolvePiRunToolBudget({}), {
      maxToolCalls: 12,
      maxIdenticalToolCalls: 2,
      maxModelTurns: 14,
    });
    assert.throws(
      () => resolvePiRunToolBudget({ AGENT_RUN_MAX_TOOL_CALLS: '0' }),
      /AGENT_RUN_MAX_TOOL_CALLS/,
    );
  });
});
