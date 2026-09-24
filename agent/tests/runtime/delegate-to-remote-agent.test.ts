/**
 * `delegate_to_remote_agent`：授权、风险分类与提示段（docs/design/a2a-remote-delegation.md D3/D4）。
 * 出站 HTTP 本身见 tests/a2a-client/remote-a2a-client.test.ts。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeRemoteDelegation } from '../../src/runtime/providers/delegate-to-remote-agent.js';
import { runWithRunServices } from '../../src/runtime/providers/run-services.js';
import { runWithToolExecutionContext } from '../../src/runtime/providers/tool-execution-context.js';
import { deriveMessageId, RemoteA2aError } from '../../src/runtime/providers/a2a-remote-client.js';
import type { RemoteAgentEntry } from '../../src/runtime/providers/a2a-remote-registry.js';
import { classifyTool, decideFromRiskTable } from '../../src/runtime/policy/risk-table.js';
import { buildRunServices } from '../../src/application/durable-subagent-port.js';
import { withDelegationSection } from '../../src/application/delegation-prompt.js';

const ENTRY: RemoteAgentEntry = {
  id: 'finance-bot',
  name: '财务助手',
  description: '报销与预算',
  cardUrl: 'https://finance.example/card.json',
  authTokenRef: 'A2A_FINANCE_TOKEN',
  timeoutMs: 60_000,
};

function fakeClient() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async delegate(input: Record<string, unknown>) {
      calls.push(input);
      return { remoteAgent: 'finance-bot', taskId: 't-1', state: 'completed', text: 'ok', artifacts: [] };
    },
  };
}

function inRun<T>(remoteAgents: string[], fn: () => Promise<T>) {
  const services = buildRunServices({
    spawnPort: { spawn: async () => ({}), getStatuses: async () => [] },
    parentRunId: 'run-1',
    tenant: { orgId: 'o', userId: 'u' },
    delegation: { agents: [], remoteAgents },
  });
  return runWithRunServices(services, () =>
    runWithToolExecutionContext({ callId: 'call-1', toolName: 'delegate_to_remote_agent', args: {} }, fn),
  );
}

const ARGS = { agent: 'finance-bot', description: 'budget', prompt: 'Q3 travel budget left?' };

describe('delegate_to_remote_agent authorization', () => {
  it('refuses when the agent version authorizes no remote agent, without any outbound call', async () => {
    const client = fakeClient();
    await assert.rejects(
      inRun([], () => executeRemoteDelegation({ registry: [ENTRY], client }, ARGS)),
      (err: RemoteA2aError) => err.code === 'DELEGATION_NOT_CONFIGURED',
    );
    assert.equal(client.calls.length, 0);
  });

  it('refuses an id that is authorized but no longer registered', async () => {
    const client = fakeClient();
    await assert.rejects(
      inRun(['finance-bot'], () => executeRemoteDelegation({ registry: [], client }, ARGS)),
      (err: RemoteA2aError) => err.code === 'DELEGATION_AGENT_NOT_ALLOWED',
    );
    assert.equal(client.calls.length, 0);
  });

  it('refuses an id that is registered but not authorized for this agent', async () => {
    const client = fakeClient();
    await assert.rejects(
      inRun(['other'], () => executeRemoteDelegation({ registry: [ENTRY], client }, ARGS)),
      (err: RemoteA2aError) => err.code === 'DELEGATION_AGENT_NOT_ALLOWED',
    );
    assert.equal(client.calls.length, 0);
  });

  it('calls the registered remote with a message id derived from run and call', async () => {
    const client = fakeClient();
    const result = await inRun(['finance-bot'], () =>
      executeRemoteDelegation({ registry: [ENTRY], client }, ARGS),
    );
    assert.equal(result.text, 'ok');
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0]?.entry, ENTRY);
    assert.equal(client.calls[0]?.prompt, 'Q3 travel budget left?');
    assert.equal(client.calls[0]?.messageId, deriveMessageId('run-1', 'call-1'));
  });
});

describe('delegate_to_remote_agent risk', () => {
  it('is an external tool that needs approval by default, unlike delegate_to_agent', () => {
    assert.equal(classifyTool('delegate_to_remote_agent'), 'external_high');
    assert.equal(decideFromRiskTable('delegate_to_remote_agent').decision, 'require_approval');
    assert.equal(classifyTool('delegate_to_agent'), 'local_low');
    assert.equal(decideFromRiskTable('delegate_to_agent').decision, 'allow');
  });
});

describe('Delegation prompt lists remote agents by id', () => {
  it('adds only registered remote agents, after the local ones', async () => {
    const prompt = await withDelegationSection({
      lead: '',
      delegation: { agents: [], remoteAgents: ['finance-bot', 'gone'] },
      orgId: 'o',
      transactionManager: { run: async (fn) => fn({}) },
      createRepositories: () => ({}),
      remoteRegistry: [ENTRY],
    });
    assert.match(prompt, /^## Delegation\n/);
    assert.match(prompt, /`delegate_to_remote_agent`/);
    assert.match(prompt, /- finance-bot — 报销与预算$/);
    assert.equal(prompt.includes('gone'), false);
    assert.equal(prompt.includes('delegate_to_agent`'), false);
  });
});
