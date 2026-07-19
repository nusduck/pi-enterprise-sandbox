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

  it('readFile uses the formal internal transport without touching legacy reads', async () => {
    const legacyCalls = [];
    const internalCalls = [];
    const client = createFakeClient(legacyCalls);
    client.readFile = async () => {
      throw new Error('legacy readFile must not be called');
    };
    const internalReadTransport = {
      async readFile(input) {
        internalCalls.push(input);
        return {
          content: 'formal',
          path: input.path,
          offset: input.offset,
          bytesRead: 6,
          eof: true,
        };
      },
    };
    const t = createSandboxBridgeHttpTransport({
      client,
      internalReadTransport,
    });
    const input = payload({
      path: '/home/sandbox/workspace/report.txt',
      offset: 2,
      limit: 64,
    });

    const out = await t.readFile(input);

    assert.equal(internalCalls.length, 1);
    assert.equal(internalCalls[0], input);
    assert.equal(out.content, 'formal');
    assert.equal(legacyCalls.some((call) => call.m === 'readFile'), false);

    await t.writeFile(
      payload({
        path: '/home/sandbox/workspace/next.txt',
        content: 'legacy-for-now',
      }),
    );
    assert.equal(legacyCalls.some((call) => call.m === 'writeFile'), true);
  });

  it('write/edit use injected formal transport and never call legacy client', async () => {
    const legacyCalls = [];
    const internalCalls = [];
    const client = createFakeClient(legacyCalls);
    const internalFilesWriteTransport = {
      async writeFile(input) { internalCalls.push(['write', input]); return { path: input.path, size: 3, hash: 'a'.repeat(64), version: 'a'.repeat(64) }; },
      async editFile(input) { internalCalls.push(['edit', input]); return { path: input.path, hash: 'b'.repeat(64), version: 'b'.repeat(64), beforeHash: 'a'.repeat(64) }; },
    };
    const t = createSandboxBridgeHttpTransport({ client, internalFilesWriteTransport });
    const w = payload({ path:'/home/sandbox/workspace/a.txt', content:'new' });
    const e = payload({ path:'/home/sandbox/workspace/a.txt', oldString:'old', newString:'new', expectedHash:'a'.repeat(64) });
    await t.writeFile(w);
    await t.editFile(e);
    assert.deepEqual(internalCalls.map((x) => x[0]), ['write', 'edit']);
    assert.equal(internalCalls[0][1], w);
    assert.equal(internalCalls[1][1], e);
    assert.equal(legacyCalls.some((call) => call.m === 'writeFile' || call.m === 'editFile'), false);
  });

  it('submitArtifact uses injected formal transport and never calls legacy client', async () => {
    let internalCalls = 0;
    let legacyCalls = 0;
    const client = {
      async submitArtifact() { legacyCalls += 1; throw new Error('legacy route used'); },
    };
    const internalArtifactTransport = {
      async submitArtifact(payload) {
        internalCalls += 1;
        return { artifactId: '01K0G2PAV8FPMVC9QHJG7JPN56', path: payload.path };
      },
    };
    const t = createSandboxBridgeHttpTransport({ client, internalArtifactTransport });
    const result = await t.submitArtifact({ identity: { sandboxSessionId: 's1' }, path: '/home/sandbox/workspace/out.pdf' });
    assert.equal(result.artifactId, '01K0G2PAV8FPMVC9QHJG7JPN56');
    assert.equal(internalCalls, 1);
    assert.equal(legacyCalls, 0);
  });

  it('bash/python use formal execution transport and leave other methods legacy', async () => {
    const legacyCalls = [];
    const internalCalls = [];
    const client = createFakeClient(legacyCalls);
    const internalExecutionTransport = {
      async bash(input) {
        internalCalls.push({ method: 'bash', input });
        return { exitCode: 0, stdout: 'formal-bash', stderr: '' };
      },
      async python(input) {
        internalCalls.push({ method: 'python', input });
        return { exitCode: 0, stdout: 'formal-python', stderr: '' };
      },
    };
    const t = createSandboxBridgeHttpTransport({
      client,
      internalExecutionTransport,
    });
    const bashInput = payload({
      command: 'printf formal',
      timeoutSeconds: 10,
      env: {},
    });
    const pythonInput = payload({
      code: 'print("formal")',
      args: [],
      timeoutSeconds: 10,
    });

    assert.equal((await t.bash(bashInput)).stdout, 'formal-bash');
    assert.equal((await t.python(pythonInput)).stdout, 'formal-python');
    assert.equal(internalCalls[0].input, bashInput);
    assert.equal(internalCalls[1].input, pythonInput);
    assert.equal(legacyCalls.some((call) => call.m === 'executeCommand'), false);
    assert.equal(legacyCalls.some((call) => call.m === 'executePython'), false);

    await t.writeFile(
      payload({ path: '/home/sandbox/workspace/still-legacy.txt', content: 'x' }),
    );
    assert.equal(legacyCalls.some((call) => call.m === 'writeFile'), true);
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
    assert.equal(started.status, 'running');
    assert.equal(started.stdoutCursor, '0-0');
    assert.equal(calls[0].body.session_id, SID);
    assert.equal(calls[0].body.command, 'sleep 1');

    const st = await t.processStatus(payload({ processId: 'proc_abc' }));
    assert.equal(st.status, 'running');
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
    assert.equal(kill.status, 'running');
    assert.equal(kill.signaled, true);
  });

  it('normalizes formal process statuses to the shared lowercase contract', async () => {
    const internalProcessTransport = {
      async processStart() { return { processId: 'p1', status: 'RUNNING' }; },
      async processStatus() { return { processId: 'p1', status: 'WAITING_INPUT' }; },
      async processRead() { return { processId: 'p1', status: 'COMPLETED', data: '' }; },
      async processKill() { return { processId: 'p1', status: 'CANCEL_REQUESTED', signaled: true }; },
    };
    const t = createSandboxBridgeHttpTransport({
      client: createFakeClient([]),
      internalProcessTransport,
    });

    assert.equal((await t.processStart(payload({ command: 'sleep 1' }))).status, 'running');
    assert.equal((await t.processStatus(payload({ processId: 'p1' }))).status, 'running');
    assert.equal((await t.processRead(payload({ processId: 'p1' }))).status, 'completed');
    assert.equal((await t.processKill(payload({ processId: 'p1' }))).status, 'running');
  });

  it('fails closed on an unknown process status', async () => {
    const t = createSandboxBridgeHttpTransport({
      client: createFakeClient([]),
      internalProcessTransport: {
        async processStart() { return { processId: 'p1', status: 'mystery' }; },
      },
    });
    await assert.rejects(
      () => t.processStart(payload({ command: 'sleep 1' })),
      /Invalid process status/,
    );
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
