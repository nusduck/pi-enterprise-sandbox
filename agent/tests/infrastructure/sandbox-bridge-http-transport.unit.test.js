/**
 * PR-08: sandbox-bridge HTTP transport maps python/process_* to sandbox client.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSandboxBridgeHttpTransport,
  createSandboxBridgeExtensionBundleFactory,
} from '../../src/infrastructure/sandbox/sandbox-bridge-http-transport.js';
import { SANDBOX_TRANSPORT_METHODS } from '../../src/extensions/sandbox-bridge/transport.js';

const SID = '01K0G2PAV8FPMVC9QHJG7JPN5F';
const RUN = Object.freeze({
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: SID,
  traceId: 'b'.repeat(32),
  executionFenceToken: 7,
});

function payload(extra = {}) {
  return {
    identity: { ...RUN },
    toolCallId: 'tc-1',
    toolExecutionId: '01K0G2PAV8FPMVC9QHJG7JPN70',
    requestHash: 'a'.repeat(64),
    requestHashVersion: 1,
    ...extra,
  };
}

function createFakeClient(calls) {
  return {
    async readFile(sessionId, path) {
      calls.push({ m: 'readFile', sessionId, path });
      return { content: 'hi', path };
    },
    async writeFile(sessionId, path, content) {
      calls.push({ m: 'writeFile', sessionId, path, content });
      return { size: content.length, path };
    },
    async editFile(sessionId, body) {
      calls.push({ m: 'editFile', sessionId, body });
      return { hash: 'abc', version: 2 };
    },
    async executeCommand(sessionId, command, timeout) {
      calls.push({ m: 'executeCommand', sessionId, command, timeout });
      return { exit_code: 0, stdout_preview: 'ok', stderr_preview: '' };
    },
    async executePython(sessionId, code, timeout, opts) {
      calls.push({ m: 'executePython', sessionId, code, timeout, opts });
      return {
        exit_code: 0,
        stdout_preview: 'py',
        stderr_preview: '',
        materialized_path: '/home/sandbox/workspace/.runtime/python/x.py',
        python_version: '3.11.0',
        python_mode: 'file',
      };
    },
    async startProcess(body) {
      calls.push({ m: 'startProcess', body });
      return {
        process_id: 'proc_abc',
        status: 'running',
        stdout_cursor: '0-0',
        stderr_cursor: '0-0',
        started_at: '2026-07-18T00:00:00Z',
      };
    },
    async getProcess(processId) {
      calls.push({ m: 'getProcess', processId });
      return {
        process_id: processId,
        status: 'running',
        exit_code: null,
        elapsed_seconds: 12,
      };
    },
    async readProcess(processId, opts) {
      calls.push({ m: 'readProcess', processId, opts });
      return {
        process_id: processId,
        stream: opts.stream,
        cursor: opts.cursor,
        next_cursor: '0-5',
        data: 'hello',
        truncated: false,
        completed: false,
      };
    },
    async signalProcess(processId, signal) {
      calls.push({ m: 'signalProcess', processId, signal });
      if (processId === 'proc_undelivered') {
        const err = new Error('Process signal not delivered');
        err.status = 409;
        err.code = 'PROCESS_SIGNAL_NOT_DELIVERED';
        throw err;
      }
      if (processId === 'proc_soft_fail') {
        return { ok: false, signaled: false, status: 'unavailable' };
      }
      return { ok: true, status: 'running', signal: 15, signaled: true };
    },
    async cancelProcess(processId) {
      calls.push({ m: 'cancelProcess', processId });
      if (processId === 'proc_undelivered' || processId === 'proc_soft_fail') {
        const err = new Error('Process cancel not delivered');
        err.status = 409;
        throw err;
      }
      return { status: 'cancelled' };
    },
    async submitArtifact(sessionId, name, path, mime) {
      calls.push({ m: 'submitArtifact', sessionId, name, path, mime });
      return {
        artifact_id: '01K0G2PAV8FPMVC9QHJG7JPN5D',
        sha256: 'c'.repeat(64),
        size: 1,
        mime_type: mime,
        path,
        name,
      };
    },
  };
}

describe('createSandboxBridgeHttpTransport', () => {
  it('exposes all SANDBOX_TRANSPORT_METHODS', () => {
    const t = createSandboxBridgeHttpTransport({
      client: createFakeClient([]),
    });
    for (const m of SANDBOX_TRANSPORT_METHODS) {
      assert.equal(typeof t[m], 'function', m);
    }
  });

  it('python maps session + args + materialization fields', async () => {
    const calls = [];
    const t = createSandboxBridgeHttpTransport({
      client: createFakeClient(calls),
    });
    const out = await t.python(
      payload({
        code: 'print(1)\nprint(2)',
        args: ['a'],
        timeoutSeconds: 30,
      }),
    );
    assert.equal(calls[0].m, 'executePython');
    assert.equal(calls[0].sessionId, SID);
    assert.equal(calls[0].code.includes('print'), true);
    assert.deepEqual(calls[0].opts.args, ['a']);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, 'py');
    assert.ok(out.materializedPath.includes('.runtime/python'));
    assert.equal(out.pythonVersion, '3.11.0');
  });

  it('processStart/Status/Read/Kill chain uses client process APIs', async () => {
    const calls = [];
    const t = createSandboxBridgeHttpTransport({
      client: createFakeClient(calls),
    });
    const started = await t.processStart(
      payload({ command: 'sleep 1', timeoutSeconds: 60 }),
    );
    assert.equal(started.processId, 'proc_abc');
    assert.equal(started.status, 'RUNNING');
    assert.equal(started.stdoutCursor, '0-0');
    assert.equal(calls[0].body.session_id, SID);
    assert.equal(calls[0].body.command, 'sleep 1');

    const st = await t.processStatus(payload({ processId: 'proc_abc' }));
    assert.equal(st.status, 'RUNNING');
    assert.equal(st.elapsedSeconds, 12);

    const rd = await t.processRead(
      payload({ processId: 'proc_abc', stream: 'stdout', cursor: '0-0', limit: 8 }),
    );
    assert.equal(rd.data, 'hello');
    assert.equal(rd.nextCursor, '0-5');
    assert.equal(calls.find((c) => c.m === 'readProcess').opts.cursor, '0-0');

    const kill = await t.processKill(
      payload({ processId: 'proc_abc', signal: 'TERM' }),
    );
    assert.equal(calls.find((c) => c.m === 'signalProcess').signal, 'SIGTERM');
    assert.ok(kill.status);
    assert.equal(kill.signaled, true);
  });

  it('processKill does not fabricate SIGNALED on undelivered kill', async () => {
    const calls = [];
    const t = createSandboxBridgeHttpTransport({
      client: createFakeClient(calls),
    });
    await assert.rejects(
      () => t.processKill(payload({ processId: 'proc_undelivered', signal: 'KILL' })),
      /not delivered|SANDBOX|409/i,
    );
    // Must not fall back to cancelProcess after a hard signal failure path
    // that already threw — and must never invent SIGNALED.
    assert.equal(
      calls.filter((c) => c.m === 'cancelProcess').length,
      0,
    );
  });

  it('processKill treats soft ok:false as tool error (no SIGNALED)', async () => {
    const calls = [];
    const t = createSandboxBridgeHttpTransport({
      client: createFakeClient(calls),
    });
    await assert.rejects(
      () => t.processKill(payload({ processId: 'proc_soft_fail', signal: 'TERM' })),
      /not delivered|PROCESS_SIGNAL/i,
    );
    assert.equal(calls.filter((c) => c.m === 'cancelProcess').length, 0);
  });

  it('fails closed without sandboxSessionId', async () => {
    const t = createSandboxBridgeHttpTransport({
      client: createFakeClient([]),
    });
    await assert.rejects(
      () => t.python({ code: 'print(1)', identity: { sandboxSessionId: '' } }),
      /SANDBOX_SESSION_REQUIRED/,
    );
  });
});

describe('createSandboxBridgeExtensionBundleFactory', () => {
  it('returns 3 factories and sandbox-bridge loads with transport', async () => {
    const calls = [];
    const transport = createSandboxBridgeHttpTransport({
      client: createFakeClient(calls),
    });
    const factory = createSandboxBridgeExtensionBundleFactory({
      sandboxTransport: transport,
    });
    const factories = factory(RUN, {
      governanceRecorder: {
        async bindSandboxRequest(input) {
          return {
            toolExecutionId: '01K0G2PAV8FPMVC9QHJG7JPN70',
            requestHash: input.requestHash,
            requestHashVersion: 1,
            bound: true,
          };
        },
      },
    });
    assert.equal(factories.length, 3);

    /** @type {any[]} */
    const tools = [];
    const pi = {
      registerTool(def) {
        tools.push(def);
      },
      on() {},
    };
    await factories[0](pi);
    assert.ok(tools.some((t) => t.name === 'python'));
    assert.ok(tools.some((t) => t.name === 'process_start'));
    assert.ok(tools.some((t) => t.name === 'process_read'));
    assert.ok(tools.some((t) => t.name === 'process_kill'));

    const py = tools.find((t) => t.name === 'python');
    const result = await py.execute('tool-call-id-1', {
      code: 'print(42)',
      timeoutSeconds: 10,
    });
    assert.ok(result);
    assert.ok(calls.some((c) => c.m === 'executePython'));
  });
});
