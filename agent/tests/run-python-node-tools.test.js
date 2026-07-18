/**
 * run_python / run_node agent tool wiring.
 * Run: node --test agent/tests/run-python-node-tools.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxTools } from '../packages/enterprise-agent-kit/extensions/sandbox-tools/tool-definitions.js';
import { BASE_TOOL_NAMES } from '../runtime/tool-contract.js';
import {
  classifyToolSideEffect,
  evaluateToolPolicy,
  POLICY_DECISION,
} from '../packages/enterprise-agent-kit/extensions/policy/index.js';
import { resolveAgentProfile } from '../application/agent-profile-service.js';
import { summarizeToolArguments } from '../runtime/tool-payload-sanitizer.js';

function makeLedgerClient(overrides = {}) {
  const byId = new Map();
  const calls = {
    python: [],
    node: [],
    approvalCheck: 0,
  };
  return {
    calls,
    byId,
    async prepareToolExecution(body) {
      const id = body.tool_call_id || `prep_${byId.size}`;
      const row = {
        tool_call_id: id,
        status: 'prepared',
        idempotency_key: body.idempotency_key,
      };
      byId.set(id, row);
      return row;
    },
    async markToolWaitingApproval(id) {
      const row = byId.get(id) || { tool_call_id: id };
      row.status = 'waiting_approval';
      byId.set(id, row);
      return row;
    },
    async markToolExecuting(id) {
      const row = byId.get(id) || { tool_call_id: id };
      row.status = 'executing';
      byId.set(id, row);
      return row;
    },
    async markToolTerminal(id, body) {
      const row = byId.get(id) || { tool_call_id: id };
      Object.assign(row, body, { status: body.status || 'succeeded' });
      byId.set(id, row);
      return row;
    },
    async approvalCheck() {
      calls.approvalCheck += 1;
      return {
        status: 'approved',
        policy_version: 'test',
        risk_level: 'medium',
      };
    },
    async executePython(sessionId, code, timeout) {
      calls.python.push({ sessionId, code, timeout });
      return {
        execution_id: 'exec_py1',
        exit_code: 0,
        stdout_preview: 'hello-py\n',
        stderr_preview: '',
        duration_ms: 12,
        truncated: false,
      };
    },
    async executeNode(sessionId, code, timeout) {
      calls.node.push({ sessionId, code, timeout });
      return {
        execution_id: 'exec_js1',
        exit_code: 0,
        stdout_preview: 'hello-js\n',
        stderr_preview: '',
        duration_ms: 8,
        truncated: false,
      };
    },
    ...overrides,
  };
}

describe('run_python / run_node registration', () => {
  it('is listed in BASE_TOOL_NAMES and coding-agent profile', () => {
    assert.ok(BASE_TOOL_NAMES.includes('run_python'));
    assert.ok(BASE_TOOL_NAMES.includes('run_node'));
    const profile = resolveAgentProfile('coding-agent');
    assert.ok(profile.allowedTools.includes('run_python'));
    assert.ok(profile.allowedTools.includes('run_node'));
  });

  it('createSandboxTools exposes both tools', () => {
    const names = createSandboxTools({ sessionId: 's1' }).map((t) => t.name);
    assert.ok(names.includes('run_python'));
    assert.ok(names.includes('run_node'));
  });

  it('classifies as write-class medium allow', () => {
    assert.equal(classifyToolSideEffect('run_python'), 'write');
    assert.equal(classifyToolSideEffect('run_node'), 'write');
    const py = evaluateToolPolicy('run_python', { code: 'print(1)' });
    assert.equal(py.decision, POLICY_DECISION.ALLOW);
    assert.equal(py.risk_level, 'medium');
    const js = evaluateToolPolicy('run_node', { code: 'console.log(1)' });
    assert.equal(js.decision, POLICY_DECISION.ALLOW);
    assert.equal(js.risk_level, 'medium');
  });
});

describe('run_python / run_node execute', () => {
  it('forwards python code to client.executePython', async () => {
    const client = makeLedgerClient();
    const tools = createSandboxTools({
      client,
      sessionId: 'sess-py',
      approvalMode: 'auto_approve',
      getMeta: () => ({ run_id: 'run_1' }),
    });
    const tool = tools.find((t) => t.name === 'run_python');
    const result = await tool.execute('tc_py1', {
      code: "print('hello-py')",
      timeout: 60,
    });
    assert.equal(client.calls.python.length, 1);
    assert.equal(client.calls.python[0].sessionId, 'sess-py');
    assert.equal(client.calls.python[0].code, "print('hello-py')");
    assert.equal(client.calls.python[0].timeout, 60);
    assert.match(result.content[0].text, /hello-py/);
    assert.equal(result.isError, false);
    assert.equal(result.details.execution_id, 'exec_py1');
  });

  it('forwards node code to client.executeNode', async () => {
    const client = makeLedgerClient();
    const tools = createSandboxTools({
      client,
      sessionId: 'sess-js',
      approvalMode: 'auto_approve',
      getMeta: () => ({ run_id: 'run_1' }),
    });
    const tool = tools.find((t) => t.name === 'run_node');
    const result = await tool.execute('tc_js1', {
      code: "console.log('hello-js')",
    });
    assert.equal(client.calls.node.length, 1);
    assert.equal(client.calls.node[0].code, "console.log('hello-js')");
    assert.match(result.content[0].text, /hello-js/);
    assert.equal(result.isError, false);
  });

  it('rejects empty code without calling sandbox', async () => {
    const client = makeLedgerClient();
    const tools = createSandboxTools({
      client,
      sessionId: 'sess-empty',
      approvalMode: 'auto_approve',
      getMeta: () => ({ run_id: 'run_1' }),
    });
    const py = tools.find((t) => t.name === 'run_python');
    const result = await py.execute('tc_empty', { code: '   ' });
    assert.equal(result.isError, true);
    assert.equal(client.calls.python.length, 0);
  });

  it('hashes large code in argument summaries', () => {
    const big = 'x'.repeat(2000);
    const summary = summarizeToolArguments('run_python', { code: big, timeout: 30 });
    assert.equal(summary.code_bytes, 2000);
    assert.ok(summary.code_sha256);
    assert.equal(summary.code, undefined);
    assert.equal(summary.timeout, 30);
  });
});
