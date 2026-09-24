/**
 * `delegate_to_agent` 工具体、端口与提示段（docs/design/agent-delegation.md）。
 * 端口用假的 spawn 服务；spawn 事务本身见 tests/run-services/subagent-delegation.unit.test.js。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DelegationToolError,
  executeDelegation,
} from '../../src/runtime/providers/delegate-to-agent.js';
import { runWithRunServices } from '../../src/runtime/providers/run-services.js';
import { runWithToolExecutionContext } from '../../src/runtime/providers/tool-execution-context.js';
import { buildRunServices } from '../../src/application/durable-subagent-port.js';
import {
  formatDelegationSection,
  withDelegationSection,
} from '../../src/application/delegation-prompt.js';

const TENANT = { orgId: 'org-1', userId: 'user-1' };

/** 假 spawn 服务：记录调用，状态按脚本推进。 */
function fakeSpawnPort(script: Array<Record<string, unknown>>, opts: { spawnError?: Error } = {}) {
  const spawns: Array<Record<string, unknown>> = [];
  let polls = 0;
  return {
    spawns,
    get polls() {
      return polls;
    },
    async spawn(input: Record<string, unknown>) {
      if (opts.spawnError) throw opts.spawnError;
      spawns.push(input);
      return { runId: 'child-1', replayed: false };
    },
    async getStatuses(input: Record<string, unknown>) {
      assert.deepEqual(input.childRunIds, ['child-1']);
      const row = script[Math.min(polls, script.length - 1)];
      polls += 1;
      return [{ runId: 'child-1', ...row }] as Array<{ runId: string; status: string }>;
    },
  };
}

function run<T>(port: ReturnType<typeof fakeSpawnPort>, agents: string[], fn: () => Promise<T>) {
  const services = buildRunServices({
    spawnPort: port,
    parentRunId: 'parent-1',
    tenant: TENANT,
    delegationAgents: agents,
  });
  return runWithRunServices(services, () =>
    runWithToolExecutionContext({ callId: 'call-7', toolName: 'delegate_to_agent', args: {} }, fn),
  );
}

const ARGS = { agent: 'data-analyst', description: 'sales numbers', prompt: 'sum Q3 sales' };

describe('delegate_to_agent', () => {
  it('refuses when the agent has no delegation allowlist, without spawning', async () => {
    const port = fakeSpawnPort([{ status: 'SUCCEEDED' }]);
    await assert.rejects(
      run(port, [], () => executeDelegation(ARGS)),
      (err: DelegationToolError) => err.code === 'DELEGATION_NOT_CONFIGURED',
    );
    // Outside any Run scope: same refusal, no fallback.
    await assert.rejects(executeDelegation(ARGS), (err: DelegationToolError) => err.code === 'DELEGATION_NOT_CONFIGURED');
    assert.equal(port.spawns.length, 0);
  });

  it('refuses an agent that is not on the allowlist and names the allowed ones', async () => {
    const port = fakeSpawnPort([{ status: 'SUCCEEDED' }]);
    await assert.rejects(
      run(port, ['data-analyst'], () => executeDelegation({ ...ARGS, agent: 'code-reviewer' })),
      (err: DelegationToolError) =>
        err.code === 'DELEGATION_AGENT_NOT_ALLOWED' && /available: data-analyst/.test(err.message),
    );
    assert.equal(port.spawns.length, 0);
  });

  it('spawns with the call id as idempotency key and waits for the answer', async () => {
    const port = fakeSpawnPort([
      { status: 'QUEUED' },
      { status: 'RUNNING' },
      { status: 'SUCCEEDED', resultSummary: 'Q3 sales: 42' },
    ]);
    const result = await run(port, ['data-analyst'], () => executeDelegation(ARGS));

    assert.deepEqual(port.spawns, [
      {
        toolCallId: 'call-7',
        parentRunId: 'parent-1',
        orgId: 'org-1',
        userId: 'user-1',
        task: 'sum Q3 sales',
        label: 'sales numbers',
        targetAgentName: 'data-analyst',
      },
    ]);
    assert.deepEqual(result, {
      agent: 'data-analyst',
      childRunId: 'child-1',
      status: 'SUCCEEDED',
      statusReason: null,
      resultSummary: 'Q3 sales: 42',
    });
    assert.equal(port.polls, 3);
  });

  it('reports a failed child instead of pretending it answered', async () => {
    const port = fakeSpawnPort([{ status: 'FAILED', statusReason: 'MODEL_ERROR' }]);
    const result = await run(port, ['data-analyst'], () => executeDelegation(ARGS));
    assert.equal(result.status, 'FAILED');
    assert.equal(result.statusReason, 'MODEL_ERROR');
    assert.equal(result.resultSummary, null);
  });

  it('turns a coded spawn refusal into a tool error with the same code', async () => {
    const refusal = Object.assign(new Error('agent "data-analyst" is not available for delegation'), {
      code: 'DELEGATION_TARGET_UNAVAILABLE',
    });
    const port = fakeSpawnPort([], { spawnError: refusal });
    await assert.rejects(
      run(port, ['data-analyst'], () => executeDelegation(ARGS)),
      (err: DelegationToolError) =>
        err instanceof DelegationToolError && err.code === 'DELEGATION_TARGET_UNAVAILABLE',
    );
  });

  it('stops waiting when the call is cancelled', async () => {
    const port = fakeSpawnPort([{ status: 'RUNNING' }]);
    const controller = new AbortController();
    const pending = run(port, ['data-analyst'], () => executeDelegation(ARGS, controller.signal));
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    assert.equal(result.status, 'RUNNING');
    assert.ok(port.polls <= 2, `polled ${port.polls} times after cancel`);
  });

  it('rejects missing arguments before spawning', async () => {
    const port = fakeSpawnPort([{ status: 'SUCCEEDED' }]);
    await assert.rejects(
      run(port, ['data-analyst'], () => executeDelegation({ agent: 'data-analyst', description: 'x' })),
      (err: DelegationToolError) => err.code === 'DELEGATION_ARGUMENT_INVALID',
    );
    assert.equal(port.spawns.length, 0);
  });
});

describe('buildRunServices delegation wiring', () => {
  it('attaches delegation only when the allowlist is non-empty', () => {
    const port = fakeSpawnPort([]);
    const none = buildRunServices({ spawnPort: port, parentRunId: 'p', tenant: TENANT });
    assert.equal(none.delegation, undefined);
    const some = buildRunServices({
      spawnPort: port,
      parentRunId: 'p',
      tenant: TENANT,
      delegationAgents: ['a'],
    });
    assert.deepEqual([...(some.delegation?.agents ?? [])], ['a']);
  });
});

describe('Delegation system prompt section', () => {
  function catalogWorld(definitions: Array<Record<string, unknown>>) {
    return {
      transactionManager: { run: async (fn: (trx: unknown) => Promise<unknown>) => fn({}) },
      createRepositories: () => ({
        catalog: {
          async getDefinitionByOrgAndName(orgId: string, name: string) {
            return definitions.find((d) => d.orgId === orgId && d.name === name) ?? null;
          },
        },
      }),
    };
  }

  it('lists only active targets, one line each, after the persona', async () => {
    const world = catalogWorld([
      { orgId: 'org-1', name: 'data-analyst', status: 'active', activeVersionId: 'v', description: 'SQL\nand charts' },
      { orgId: 'org-1', name: 'retired', status: 'disabled', activeVersionId: 'v', description: 'old' },
    ]);
    const prompt = await withDelegationSection({
      lead: 'You are the lead.',
      agents: ['data-analyst', 'retired', 'ghost'],
      orgId: 'org-1',
      ...world,
    });
    assert.equal(
      prompt,
      'You are the lead.\n\n## Delegation\n' +
        'You can hand a self-contained task to another agent with `delegate_to_agent`. ' +
        'It does not see this conversation or your workspace, so include everything it needs. ' +
        'Available agents:\n- data-analyst — SQL and charts',
    );
  });

  it('leaves the persona untouched when nothing is delegable', async () => {
    const world = catalogWorld([]);
    assert.equal(
      await withDelegationSection({ lead: 'lead', agents: ['ghost'], orgId: 'org-1', ...world }),
      'lead',
    );
    assert.equal(
      await withDelegationSection({ lead: 'lead', agents: [], orgId: 'org-1', ...world }),
      'lead',
    );
    assert.equal(formatDelegationSection([]), '');
  });
});
