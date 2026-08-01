/**
 * PR-08: sandbox-bridge HTTP transport maps the 10 tools onto the signed
 * internal plane. There is no browser-Bearer fallback — a missing transport is
 * a wiring bug and must fail loudly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSandboxBridgeHttpTransport,
  createSandboxBridgeExtensionBundleFactory,
} from '../../src/infrastructure/sandbox/sandbox-bridge-http-transport.js';
import { SANDBOX_TRANSPORT_METHODS } from '../../src/extensions/sandbox-bridge/transport.js';
import { REQUIRED_EXTENSION_NAMES } from '../../src/extensions/index.js';

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

/** Signed-plane fakes covering every internal transport the bridge needs. */
function createInternalFakes(calls = []) {
  return {
    internalReadTransport: {
      async readFile(input) {
        calls.push({ m: 'readFile', input });
        return { content: 'formal', path: input.path, eof: true };
      },
      async readSkill(input) {
        calls.push({ m: 'readSkill', input });
        return { content: '# Skill', path: input.path, binary: false };
      },
    },
    internalFilesWriteTransport: {
      async writeFile(input) {
        calls.push({ m: 'writeFile', input });
        return { path: input.path, size: 3, hash: 'a'.repeat(64) };
      },
      async editFile(input) {
        calls.push({ m: 'editFile', input });
        return { path: input.path, hash: 'b'.repeat(64) };
      },
    },
    internalExecutionTransport: {
      async bash(input) {
        calls.push({ m: 'bash', input });
        return { exitCode: 0, stdout: 'formal-bash', stderr: '' };
      },
      async python(input) {
        calls.push({ m: 'python', input });
        return {
          exitCode: 0,
          stdout: 'formal-python',
          stderr: '',
          materializedPath: '/home/sandbox/workspace/.runtime/python/x.py',
          pythonVersion: '3.11.0',
        };
      },
    },
    internalProcessTransport: {
      async processStart(input) {
        calls.push({ m: 'processStart', input });
        return {
          processId: 'proc_abc',
          status: 'running',
          stdoutCursor: '0-0',
          stderrCursor: '0-0',
          startedAt: '2026-07-18T00:00:00Z',
        };
      },
      async processStatus(input) {
        calls.push({ m: 'processStatus', input });
        return {
          processId: input.processId,
          status: 'running',
          exitCode: null,
          elapsedSeconds: 12,
        };
      },
      async processRead(input) {
        calls.push({ m: 'processRead', input });
        return {
          processId: input.processId,
          stream: input.stream,
          cursor: input.cursor,
          nextCursor: '0-5',
          data: 'hello',
          truncated: false,
          completed: false,
        };
      },
      async processKill(input) {
        calls.push({ m: 'processKill', input });
        if (input.processId === 'proc_soft_fail') {
          return { ok: false, signaled: false, status: 'orphaned' };
        }
        if (input.processId === 'proc_undelivered') {
          const err = new Error('Process signal not delivered');
          err.status = 409;
          err.code = 'PROCESS_SIGNAL_NOT_DELIVERED';
          throw err;
        }
        return { processId: input.processId, status: 'running', signaled: true };
      },
    },
    internalArtifactTransport: {
      async submitArtifact(input) {
        calls.push({ m: 'submitArtifact', input });
        return { artifactId: '01K0G2PAV8FPMVC9QHJG7JPN56', path: input.path };
      },
    },
  };
}

describe('createSandboxBridgeHttpTransport', () => {
  it('exposes all SANDBOX_TRANSPORT_METHODS', () => {
    const t = createSandboxBridgeHttpTransport(createInternalFakes());
    for (const m of SANDBOX_TRANSPORT_METHODS) {
      assert.equal(typeof t[m], 'function', m);
    }
  });

  it('passes the frozen payload straight through to the signed transports', async () => {
    const calls = [];
    const t = createSandboxBridgeHttpTransport(createInternalFakes(calls));

    const readInput = payload({ path: '/home/sandbox/workspace/report.txt' });
    const writeInput = payload({ path: '/home/sandbox/workspace/a.txt', content: 'new' });
    const editInput = payload({
      path: '/home/sandbox/workspace/a.txt',
      oldString: 'old',
      newString: 'new',
    });
    const bashInput = payload({ command: 'printf formal', timeoutSeconds: 10 });
    const pythonInput = payload({ code: 'print("formal")', timeoutSeconds: 10 });
    const artifactInput = payload({ path: '/home/sandbox/workspace/out.pdf' });

    assert.equal((await t.readFile(readInput)).content, 'formal');
    await t.writeFile(writeInput);
    await t.editFile(editInput);
    assert.equal((await t.bash(bashInput)).stdout, 'formal-bash');
    const py = await t.python(pythonInput);
    assert.equal(py.stdout, 'formal-python');
    assert.ok(py.materializedPath.includes('.runtime/python'));
    assert.equal(
      (await t.submitArtifact(artifactInput)).artifactId,
      '01K0G2PAV8FPMVC9QHJG7JPN56',
    );

    // Identity/claim payloads must reach the signed plane unmodified.
    assert.deepEqual(
      calls.map((c) => c.m),
      ['readFile', 'writeFile', 'editFile', 'bash', 'python', 'submitArtifact'],
    );
    assert.equal(calls[0].input, readInput);
    assert.equal(calls[3].input, bashInput);
  });

  it('readSkill uses the signed skill transport, never the workspace read', async () => {
    const calls = [];
    const fakes = createInternalFakes(calls);
    fakes.internalReadTransport.readFile = async () => {
      throw new Error('workspace read must not be used for a skill');
    };
    const t = createSandboxBridgeHttpTransport(fakes);
    const input = payload({
      path: '/home/sandbox/skill/baoyu-format-markdown/SKILL.md',
    });

    assert.equal((await t.readSkill(input)).content, '# Skill');
    assert.equal(calls[0].input, input);
  });

  it('readSkill reports SKILL_READ_UNSUPPORTED when the transport lacks it', async () => {
    const fakes = createInternalFakes();
    delete fakes.internalReadTransport.readSkill;
    const t = createSandboxBridgeHttpTransport(fakes);
    await assert.rejects(
      () => t.readSkill(payload({ path: '/home/sandbox/skill/x/SKILL.md' })),
      /SKILL_READ_UNSUPPORTED/,
    );
  });

  it('fails loudly when a signed transport is not wired', async () => {
    // The container refuses to boot without an HMAC keyring, so reaching this
    // is a wiring bug — it must never degrade to an unsigned path.
    const t = createSandboxBridgeHttpTransport({});
    for (const [method, input] of [
      ['readFile', payload({ path: '/home/sandbox/workspace/a.txt' })],
      ['writeFile', payload({ path: '/home/sandbox/workspace/a.txt', content: 'x' })],
      ['bash', payload({ command: 'echo hi' })],
      ['python', payload({ code: 'print(1)' })],
      ['processStart', payload({ command: 'sleep 1' })],
      ['submitArtifact', payload({ path: '/home/sandbox/workspace/out.pdf' })],
    ]) {
      await assert.rejects(
        () => t[method](input),
        /SANDBOX_INTERNAL_TRANSPORT_UNAVAILABLE/,
        method,
      );
    }
  });

  it('processStart/Status/Read/Kill chain maps the signed process plane', async () => {
    const calls = [];
    const t = createSandboxBridgeHttpTransport(createInternalFakes(calls));

    const started = await t.processStart(
      payload({ command: 'sleep 1', timeoutSeconds: 60 }),
    );
    assert.equal(started.processId, 'proc_abc');
    assert.equal(started.status, 'running');
    assert.equal(started.stdoutCursor, '0-0');

    const st = await t.processStatus(payload({ processId: 'proc_abc' }));
    assert.equal(st.status, 'running');
    assert.equal(st.elapsedSeconds, 12);

    const rd = await t.processRead(
      payload({ processId: 'proc_abc', stream: 'stdout', cursor: '0-0', limit: 8 }),
    );
    assert.equal(rd.data, 'hello');
    assert.equal(rd.nextCursor, '0-5');

    const kill = await t.processKill(
      payload({ processId: 'proc_abc', signal: 'TERM' }),
    );
    assert.equal(kill.status, 'running');
    assert.equal(kill.signaled, true);
  });

  it('normalizes formal process statuses to the shared lowercase contract', async () => {
    const fakes = createInternalFakes();
    fakes.internalProcessTransport = {
      async processStart() { return { processId: 'p1', status: 'RUNNING' }; },
      async processStatus() { return { processId: 'p1', status: 'WAITING_INPUT' }; },
      async processRead() { return { processId: 'p1', status: 'COMPLETED', data: '' }; },
      async processKill() { return { processId: 'p1', status: 'CANCEL_REQUESTED', signaled: true }; },
    };
    const t = createSandboxBridgeHttpTransport(fakes);

    assert.equal((await t.processStart(payload({ command: 'sleep 1' }))).status, 'running');
    assert.equal((await t.processStatus(payload({ processId: 'p1' }))).status, 'running');
    assert.equal((await t.processRead(payload({ processId: 'p1' }))).status, 'completed');
    assert.equal((await t.processKill(payload({ processId: 'p1' }))).status, 'running');
  });

  it('fails closed on an unknown process status', async () => {
    const fakes = createInternalFakes();
    fakes.internalProcessTransport = {
      async processStart() { return { processId: 'p1', status: 'mystery' }; },
    };
    const t = createSandboxBridgeHttpTransport(fakes);
    await assert.rejects(
      () => t.processStart(payload({ command: 'sleep 1' })),
      /Invalid process status/,
    );
  });

  it('processKill does not fabricate SIGNALED on undelivered kill', async () => {
    const t = createSandboxBridgeHttpTransport(createInternalFakes());
    await assert.rejects(
      () => t.processKill(payload({ processId: 'proc_undelivered', signal: 'KILL' })),
      /not delivered|PROCESS_SIGNAL|409/i,
    );
  });

  it('processKill treats soft ok:false as tool error (no SIGNALED)', async () => {
    const t = createSandboxBridgeHttpTransport(createInternalFakes());
    await assert.rejects(
      () => t.processKill(payload({ processId: 'proc_soft_fail', signal: 'TERM' })),
      /not delivered|PROCESS_SIGNAL/i,
    );
  });
});

describe('createSandboxBridgeExtensionBundleFactory', () => {
  it('returns the required factories and sandbox-bridge loads with transport', async () => {
    const calls = [];
    const transport = createSandboxBridgeHttpTransport(createInternalFakes(calls));
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
    assert.equal(factories.length, REQUIRED_EXTENSION_NAMES.length);
    assert.equal(factories[0].extensionName, 'sandbox-bridge');

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
    assert.ok(calls.some((c) => c.m === 'python'));
  });
});
