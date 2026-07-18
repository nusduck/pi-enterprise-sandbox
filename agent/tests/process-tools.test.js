/**
 * B2 process_* tool registration and client wiring.
 * Run: node --test agent/tests/process-tools.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxTools } from '../packages/enterprise-agent-kit/extensions/sandbox-tools/tool-definitions.js';
import { BASE_TOOL_NAMES } from '../runtime/tool-contract.js';
import { classifyToolSideEffect } from '../packages/enterprise-agent-kit/extensions/policy/index.js';

const PROCESS_TOOLS = [
  'process_start',
  'process_status',
  'process_logs',
  'process_wait',
  'process_write_stdin',
  'process_signal',
  'process_cancel',
];

describe('process tools registration', () => {
  it('includes all process_* tools in BASE_TOOL_NAMES', () => {
    for (const name of PROCESS_TOOLS) {
      assert.ok(BASE_TOOL_NAMES.includes(name), `missing ${name} in BASE_TOOL_NAMES`);
    }
  });

  it('createSandboxTools exposes process_* tools', () => {
    const tools = createSandboxTools({ sessionId: 'sess-proc' });
    const names = tools.map((t) => t.name);
    for (const name of PROCESS_TOOLS) {
      assert.ok(names.includes(name), `missing tool ${name}`);
    }
    // Sync bash and structured code runners remain available
    assert.ok(names.includes('bash'));
    assert.ok(names.includes('run_python'));
    assert.ok(names.includes('run_node'));
  });

  it('classifies process observe tools as read and control as write', () => {
    assert.equal(classifyToolSideEffect('process_status'), 'read');
    assert.equal(classifyToolSideEffect('process_logs'), 'read');
    assert.equal(classifyToolSideEffect('process_wait'), 'read');
    assert.equal(classifyToolSideEffect('process_start'), 'write');
    assert.equal(classifyToolSideEffect('process_cancel'), 'write');
    assert.equal(classifyToolSideEffect('process_signal'), 'write');
    assert.equal(classifyToolSideEffect('process_write_stdin'), 'write');
  });

  it('process_start defers to client.startProcess', async () => {
    const calls = [];
    const client = {
      async approvalCheck() {
        return { status: 'approved', risk_level: 'low' };
      },
      async startProcess(body) {
        calls.push(body);
        return {
          process_id: 'proc_test1',
          status: 'running',
          started_at: '2026-01-01T00:00:00Z',
        };
      },
    };
    const tools = createSandboxTools({ client, sessionId: 's1' });
    const tool = tools.find((t) => t.name === 'process_start');
    const result = await tool.execute('tc1', { command: 'python3 -m http.server 8000' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].session_id, 's1');
    assert.equal(calls[0].command, 'python3 -m http.server 8000');
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /proc_test1/);
  });

  it('process_logs defers to client.getProcessLogs', async () => {
    const calls = [];
    const client = {
      async approvalCheck() {
        return { status: 'approved', risk_level: 'low' };
      },
      async getProcessLogs(processId, offset, limit) {
        calls.push({ processId, offset, limit });
        return {
          stdout: 'hello',
          stderr: '',
          next_offset: 5,
          completed: false,
          truncated: false,
        };
      },
    };
    const tools = createSandboxTools({ client, sessionId: 's1' });
    const tool = tools.find((t) => t.name === 'process_logs');
    const result = await tool.execute('tc2', { process_id: 'proc_x', offset: 0 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].processId, 'proc_x');
    assert.match(result.content[0].text, /hello/);
  });

  it('process_cancel defers to client.cancelProcess', async () => {
    const calls = [];
    const client = {
      async approvalCheck() {
        return { status: 'approved', risk_level: 'high' };
      },
      async cancelProcess(processId) {
        calls.push(processId);
        return { process_id: processId, status: 'cancelled', exit_code: -15 };
      },
    };
    const tools = createSandboxTools({ client, sessionId: 's1' });
    const tool = tools.find((t) => t.name === 'process_cancel');
    const result = await tool.execute('tc3', { process_id: 'proc_y' });
    assert.equal(calls[0], 'proc_y');
    assert.match(result.content[0].text, /cancelled/);
  });

  it('process_write_stdin defers to client.writeProcessStdin', async () => {
    const calls = [];
    const client = {
      async approvalCheck() {
        return { status: 'approved', risk_level: 'low' };
      },
      async writeProcessStdin(processId, data, eof) {
        calls.push({ processId, data, eof });
        return { ok: true, status: 'running' };
      },
    };
    const tools = createSandboxTools({ client, sessionId: 's1' });
    const tool = tools.find((t) => t.name === 'process_write_stdin');
    await tool.execute('tc4', { process_id: 'proc_z', data: 'input\n', eof: true });
    assert.deepEqual(calls[0], { processId: 'proc_z', data: 'input\n', eof: true });
  });
});
