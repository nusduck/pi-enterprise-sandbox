/**
 * PR-07B batch 2B: sandbox-bridge binds request-hash before transport.
 * Covers all 10 tools + skill-read, spoof prevention, post-normalization
 * hashing, binder-before-transport order, and fail-closed behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createSandboxBridgeToolDefinitions,
  SANDBOX_TOOL_NAMES,
} from '../../src/extensions/index.js';
import { computeToolRequestHashV1 } from '../../src/domain/tool/tool-request-hash.js';
import {
  DEFAULT_BASH_TIMEOUT_SEC,
  DEFAULT_PROCESS_TIMEOUT_SEC,
  DEFAULT_PYTHON_TIMEOUT_SEC,
  DEFAULT_READ_LIMIT,
  MAX_READ_BYTES,
} from '../../src/extensions/sandbox-bridge/constants.js';
import { ConflictError, NotFoundError } from '../../src/infrastructure/mysql/errors.js';
import {
  SandboxRequestBinder,
  computeSandboxToolRequestHash,
} from '../../src/application/sandbox-request-binder.js';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { ToolExecutionRepository } from '../../src/infrastructure/mysql/repositories/tool-execution-repository.js';
import { TOOL_EXECUTION_STATUS } from '../../src/domain/tool/tool-execution-status.js';
import { TransactionManager } from '../../src/infrastructure/mysql/transaction-manager.js';

const RUN = Object.freeze({
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
  traceId: 'b'.repeat(32),
  executionFenceToken: 7,
});

const TE = '01K0G2PAV8FPMVC9QHJG7JPN5K';
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5E';

function createRecordingTransport(calls) {
  const methods = [
    'readFile',
    'writeFile',
    'editFile',
    'bash',
    'python',
    'processStart',
    'processStatus',
    'processRead',
    'processKill',
    'submitArtifact',
    'readSkill',
  ];
  /** @type {Record<string, Function>} */
  const t = {};
  for (const m of methods) {
    t[m] = async (payload) => {
      calls.push({ method: m, payload, at: calls.length });
      if (m === 'readFile' || m === 'readSkill') {
        return { content: 'ok', offset: 0, size: 2 };
      }
      if (m === 'writeFile') return { size: 1 };
      if (m === 'editFile') return { hash: 'h', version: '1' };
      if (m === 'bash' || m === 'python') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (m === 'processStart') {
        return {
          processId: '01K0G2PAV8FPMVC9QHJG7JPN5C',
          status: 'running',
          stdoutCursor: '0-0',
          stderrCursor: '0-0',
        };
      }
      if (m === 'processStatus') {
        return { processId: payload.processId, status: 'running' };
      }
      if (m === 'processRead') {
        return { data: 'x', nextCursor: '0-1', stream: 'stdout' };
      }
      if (m === 'processKill') return { status: 'running' };
      if (m === 'submitArtifact') {
        return {
          artifactId: '01K0G2PAV8FPMVC9QHJG7JPN5D',
          sha256: 'a'.repeat(64),
          size: 1,
          mimeType: 'text/plain',
        };
      }
      return {};
    };
  }
  return t;
}

/**
 * @param {Array<object>} binds
 * @param {{ fail?: Error | null, delayMs?: number }} [opts]
 */
function createOrderBinder(binds, opts = {}) {
  return {
    async bindSandboxRequest(input) {
      if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      if (opts.fail) throw opts.fail;
      if (opts.badToolExecutionId) {
        binds.push({ ...input, toolExecutionId: opts.badToolExecutionId });
        return {
          toolExecutionId: opts.badToolExecutionId,
          requestHash: input.requestHash,
          requestHashVersion: input.requestHashVersion,
          bound: true,
        };
      }
      const toolExecutionId = TE;
      binds.push({
        ...input,
        toolExecutionId,
        order: binds.length,
      });
      return {
        toolExecutionId,
        requestHash: input.requestHash,
        requestHashVersion: input.requestHashVersion,
        bound: true,
      };
    },
  };
}

const BASE_PARAMS = Object.freeze({
  read: { path: 'data/a.txt' },
  write: { path: 'out.txt', content: 'hi' },
  edit: {
    path: 'out.txt',
    oldText: 'a',
    newText: 'b',
    expectedHash: 'deadbeef',
  },
  bash: { command: 'echo hi' },
  python: { code: 'print(1)' },
  process_start: { command: 'sleep 1' },
  process_status: { processId: '01K0G2PAV8FPMVC9QHJG7JPN5C' },
  process_read: { processId: '01K0G2PAV8FPMVC9QHJG7JPN5C' },
  process_kill: { processId: '01K0G2PAV8FPMVC9QHJG7JPN5C' },
  submit_artifact: { path: 'out/report.pdf' },
});

/**
 * Expected post-normalization hash args for each tool (defaults applied).
 * @param {string} name
 */
function expectedNormalizedArgs(name) {
  switch (name) {
    case 'read':
      return {
        path: '/home/sandbox/workspace/data/a.txt',
        offset: 0,
        limit: DEFAULT_READ_LIMIT,
        maxBytes: MAX_READ_BYTES,
      };
    case 'write':
      return {
        path: '/home/sandbox/workspace/out.txt',
        content: 'hi',
        encoding: 'utf-8',
      };
    case 'edit':
      return {
        path: '/home/sandbox/workspace/out.txt',
        oldText: 'a',
        newText: 'b',
        expectedHash: 'deadbeef',
      };
    case 'bash':
      return {
        command: 'echo hi',
        timeoutSeconds: DEFAULT_BASH_TIMEOUT_SEC,
        env: {},
      };
    case 'python':
      return {
        code: 'print(1)',
        args: [],
        timeoutSeconds: DEFAULT_PYTHON_TIMEOUT_SEC,
      };
    case 'process_start':
      return {
        command: 'sleep 1',
        env: {},
        timeoutSeconds: DEFAULT_PROCESS_TIMEOUT_SEC,
      };
    case 'process_status':
      return { processId: '01K0G2PAV8FPMVC9QHJG7JPN5C' };
    case 'process_read':
      return {
        processId: '01K0G2PAV8FPMVC9QHJG7JPN5C',
        stream: 'stdout',
        cursor: '0-0',
        limit: 8192,
      };
    case 'process_kill':
      return {
        processId: '01K0G2PAV8FPMVC9QHJG7JPN5C',
        signal: 'TERM',
      };
    case 'submit_artifact':
      return {
        path: '/home/sandbox/workspace/out/report.pdf',
      };
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

describe('PR-07B batch 2B: all 10 tools bind before transport', () => {
  it('binds and transports all 10 tools with claim fields + frozen identity', async () => {
    const calls = [];
    const binds = [];
    const transport = createRecordingTransport(calls);
    const defs = createSandboxBridgeToolDefinitions(RUN, transport, {
      sandboxRequestBinder: createOrderBinder(binds),
    });

    for (const name of SANDBOX_TOOL_NAMES) {
      const tool = defs.find((t) => t.name === name);
      assert.ok(tool, name);
      const exactId = `tc-${name}`;
      const result = await tool.execute(exactId, {
        ...BASE_PARAMS[name],
        // spoof attempts
        toolExecutionId: 'EVIL_TE',
        requestHash: '0'.repeat(64),
        requestHashVersion: 999,
        toolCallId: 'spoofed',
        orgId: 'EVIL',
        identity: { orgId: 'EVIL', executionFenceToken: 1 },
        executionFenceToken: 1,
      });
      assert.equal(
        result.content[0].text.includes('Error'),
        false,
        `${name}: ${result.content[0].text}`,
      );
    }

    assert.equal(binds.length, 10);
    assert.equal(calls.length, 10);

    for (let i = 0; i < SANDBOX_TOOL_NAMES.length; i += 1) {
      const name = SANDBOX_TOOL_NAMES[i];
      const expectedArgs = expectedNormalizedArgs(name);
      const expectedHash = computeToolRequestHashV1({
        toolName: name,
        args: expectedArgs,
      });

      // Binder received post-normalization hash + exact toolName (not spoofable)
      assert.equal(binds[i].toolCallId, `tc-${name}`);
      assert.equal(binds[i].toolName, name);
      assert.equal(binds[i].requestHash, expectedHash.requestHash);
      assert.equal(binds[i].requestHashVersion, 1);

      // Transport after bind with exact claim fields
      const c = calls[i];
      assert.equal(c.payload.toolCallId, `tc-${name}`);
      assert.equal(c.payload.toolExecutionId, TE);
      assert.equal(c.payload.requestHash, expectedHash.requestHash);
      assert.equal(c.payload.requestHashVersion, 1);
      assert.equal(c.payload.identity.orgId, RUN.orgId);
      assert.equal(c.payload.identity.userId, RUN.userId);
      assert.equal(c.payload.identity.conversationId, RUN.conversationId);
      assert.equal(c.payload.identity.agentSessionId, RUN.agentSessionId);
      assert.equal(c.payload.identity.runId, RUN.runId);
      assert.equal(c.payload.identity.sandboxSessionId, RUN.sandboxSessionId);
      assert.equal(c.payload.identity.executionFenceToken, RUN.executionFenceToken);
      // spoof prevention
      assert.notEqual(c.payload.toolExecutionId, 'EVIL_TE');
      assert.notEqual(c.payload.requestHash, '0'.repeat(64));
      assert.notEqual(c.payload.requestHashVersion, 999);
      assert.notEqual(c.payload.toolCallId, 'spoofed');
      assert.notEqual(c.payload.identity.orgId, 'EVIL');
    }
  });

  it('skill-read path binds with post-normalization hash and claim fields', async () => {
    const calls = [];
    const binds = [];
    const transport = createRecordingTransport(calls);
    const defs = createSandboxBridgeToolDefinitions(RUN, transport, {
      sandboxRequestBinder: createOrderBinder(binds),
    });
    const tool = defs.find((t) => t.name === 'read');
    const exactId = 'tc-skill-read';
    const result = await tool.execute(exactId, {
      path: '/home/sandbox/skill/docs/README.md',
      offset: 2,
      toolExecutionId: 'spoof',
      requestHash: 'a'.repeat(64),
    });
    assert.equal(result.content[0].text.includes('Error'), false);
    assert.equal(binds.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'readSkill');

    const expectedArgs = {
      path: '/home/sandbox/skill/docs/README.md',
      offset: 2,
      limit: DEFAULT_READ_LIMIT,
      maxBytes: MAX_READ_BYTES,
      area: 'skill',
    };
    const expectedHash = computeToolRequestHashV1({
      toolName: 'read',
      args: expectedArgs,
    });
    assert.equal(binds[0].requestHash, expectedHash.requestHash);
    assert.equal(calls[0].payload.requestHash, expectedHash.requestHash);
    assert.equal(calls[0].payload.toolExecutionId, TE);
    assert.equal(calls[0].payload.toolCallId, exactId);
    assert.equal(calls[0].payload.requestHashVersion, 1);
  });

  it('post-normalization: default timeout changes request hash', async () => {
    const binds = [];
    const transport = createRecordingTransport([]);
    const defs = createSandboxBridgeToolDefinitions(RUN, transport, {
      sandboxRequestBinder: createOrderBinder(binds),
    });
    const bash = defs.find((t) => t.name === 'bash');
    await bash.execute('tc-default', { command: 'true' });
    await bash.execute('tc-custom', {
      command: 'true',
      timeoutSeconds: 30,
    });
    assert.equal(binds.length, 2);
    assert.notEqual(binds[0].requestHash, binds[1].requestHash);

    const hDefault = computeToolRequestHashV1({
      toolName: 'bash',
      args: {
        command: 'true',
        timeoutSeconds: DEFAULT_BASH_TIMEOUT_SEC,
        env: {},
      },
    });
    const hCustom = computeToolRequestHashV1({
      toolName: 'bash',
      args: { command: 'true', timeoutSeconds: 30, env: {} },
    });
    assert.equal(binds[0].requestHash, hDefault.requestHash);
    assert.equal(binds[1].requestHash, hCustom.requestHash);
  });
});

describe('PR-07B batch 2B: binder-before-transport order + fail-closed', () => {
  it('binder is invoked before transport (order)', async () => {
    const order = [];
    const transport = createRecordingTransport([]);
    // wrap transport methods
    for (const m of Object.keys(transport)) {
      const orig = transport[m];
      transport[m] = async (payload) => {
        order.push(`transport:${m}`);
        return orig(payload);
      };
    }
    const binder = {
      async bindSandboxRequest(input) {
        order.push('bind');
        return {
          toolExecutionId: TE,
          requestHash: input.requestHash,
          requestHashVersion: input.requestHashVersion,
          bound: true,
        };
      },
    };
    const defs = createSandboxBridgeToolDefinitions(RUN, transport, {
      sandboxRequestBinder: binder,
    });
    await defs.find((t) => t.name === 'bash').execute('tc-order', {
      command: 'echo 1',
    });
    assert.deepEqual(order.slice(0, 2), ['bind', 'transport:bash']);
  });

  it('missing binder: zero transport calls for all 10 tools', async () => {
    const calls = [];
    const defs = createSandboxBridgeToolDefinitions(
      RUN,
      createRecordingTransport(calls),
      { sandboxRequestBinder: null },
    );
    for (const name of SANDBOX_TOOL_NAMES) {
      const result = await defs
        .find((t) => t.name === name)
        .execute(`tc-${name}`, BASE_PARAMS[name]);
      assert.match(result.content[0].text, /SANDBOX_REQUEST_BINDER_UNAVAILABLE/);
      assert.equal(result.details?.code, 'SANDBOX_REQUEST_BINDER_UNAVAILABLE');
    }
    assert.equal(calls.length, 0);
  });

  it('binder ConflictError: zero transport, not UNKNOWN', async () => {
    const calls = [];
    const defs = createSandboxBridgeToolDefinitions(
      RUN,
      createRecordingTransport(calls),
      {
        sandboxRequestBinder: createOrderBinder([], {
          fail: new ConflictError('bind conflict', {
            resource: 'tool_executions',
            id: TE,
          }),
        }),
      },
    );
    const result = await defs
      .find((t) => t.name === 'bash')
      .execute('tc-conflict', { command: 'true' });
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /SANDBOX_REQUEST_BIND_CONFLICT|CONFLICT/);
    assert.equal(/UNKNOWN/.test(result.content[0].text), false);
    assert.notEqual(result.details?.code, 'UNKNOWN');
    assert.notEqual(result.details?.code, 'TOOL_OUTCOME_UNKNOWN');
  });

  it('binder NotFoundError: zero transport', async () => {
    const calls = [];
    const defs = createSandboxBridgeToolDefinitions(
      RUN,
      createRecordingTransport(calls),
      {
        sandboxRequestBinder: createOrderBinder([], {
          fail: new NotFoundError('Tool execution not found', {
            resource: 'tool_executions',
            id: 'x',
          }),
        }),
      },
    );
    const result = await defs
      .find((t) => t.name === 'read')
      .execute('tc-nf', { path: 'a.txt' });
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /TOOL_EXECUTION_NOT_FOUND|NOT_FOUND/);
  });

  it('ordinary validation errors do not hit binder or transport', async () => {
    const calls = [];
    const binds = [];
    const defs = createSandboxBridgeToolDefinitions(
      RUN,
      createRecordingTransport(calls),
      { sandboxRequestBinder: createOrderBinder(binds) },
    );
    const bash = await defs
      .find((t) => t.name === 'bash')
      .execute('tc-empty', { command: '   ' });
    assert.match(bash.content[0].text, /COMMAND_REQUIRED/);
    const edit = await defs.find((t) => t.name === 'edit').execute('tc-edit', {
      path: 'a.txt',
    });
    assert.match(edit.content[0].text, /FILE_VERSION_PRECONDITION_REQUIRED/);
    assert.equal(binds.length, 0);
    assert.equal(calls.length, 0);
  });

  it('spoofed claim fields on params cannot override post-bind payload', async () => {
    const calls = [];
    const binds = [];
    const defs = createSandboxBridgeToolDefinitions(
      RUN,
      createRecordingTransport(calls),
      { sandboxRequestBinder: createOrderBinder(binds) },
    );
    await defs.find((t) => t.name === 'python').execute('tc-py', {
      code: 'print(1)',
      toolExecutionId: '01K0G2PAV8FPMVC9QHJG7EVIL',
      requestHash: 'f'.repeat(64),
      requestHashVersion: 42,
      toolCallId: 'spoofed-call',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.toolExecutionId, TE);
    assert.equal(calls[0].payload.toolCallId, 'tc-py');
    assert.equal(calls[0].payload.requestHash, binds[0].requestHash);
    assert.equal(calls[0].payload.requestHashVersion, 1);
    assert.notEqual(calls[0].payload.requestHash, 'f'.repeat(64));
    assert.equal(binds[0].toolName, 'python');
  });

  it('invalid binder toolExecutionId (non-ULID) yields zero transport', async () => {
    const calls = [];
    const defs = createSandboxBridgeToolDefinitions(
      RUN,
      createRecordingTransport(calls),
      {
        sandboxRequestBinder: createOrderBinder([], {
          badToolExecutionId: 'not-a-ulid',
        }),
      },
    );
    const result = await defs
      .find((t) => t.name === 'bash')
      .execute('tc-bad-te', { command: 'true' });
    assert.equal(calls.length, 0);
    assert.match(result.content[0].text, /SANDBOX_REQUEST_BIND_FAILED|ULID/i);
  });
});

describe('SandboxRequestBinder + ToolExecutionRepository.bindSandboxRequest', () => {
  function seed(state, toolOverrides = {}) {
    state.tables.runs = [
      {
        run_id: RUN.runId,
        org_id: RUN.orgId,
        user_id: RUN.userId,
        conversation_id: RUN.conversationId,
        agent_session_id: RUN.agentSessionId,
        agent_version_id: VER,
        status: 'RUNNING',
        created_at: '2026-07-18 00:00:00.000',
        updated_at: '2026-07-18 00:00:00.000',
      },
    ];
    state.tables.agent_sessions = [
      {
        agent_session_id: RUN.agentSessionId,
        org_id: RUN.orgId,
        user_id: RUN.userId,
        conversation_id: RUN.conversationId,
        sandbox_session_id: RUN.sandboxSessionId,
        agent_version_id: VER,
        status: 'ACTIVE',
        execution_fence_token: RUN.executionFenceToken,
        created_at: '2026-07-18 00:00:00.000',
        updated_at: '2026-07-18 00:00:00.000',
      },
    ];
    state.tables.tool_executions = [
      {
        tool_execution_id: TE,
        run_id: RUN.runId,
        agent_session_id: RUN.agentSessionId,
        tool_call_id: 'tc-bind-svc',
        tool_name: 'bash',
        tool_source: 'sandbox',
        risk_level: 'low',
        arguments_json: JSON.stringify({
          $v: 1,
          $integrity: createHash('sha256').update('{}').digest('hex'),
          $payload: {},
        }),
        result_json: null,
        status: TOOL_EXECUTION_STATUS.RUNNING,
        error_code: null,
        trace_id: RUN.traceId,
        request_hash: null,
        request_hash_version: null,
        execution_fence_token: null,
        started_at: '2026-07-18 00:00:00.000',
        completed_at: null,
        created_at: '2026-07-18 00:00:00.000',
        ...toolOverrides,
      },
    ];
  }

  it('bindSandboxRequest service binds RUNNING ledger row in a transaction', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    seed(state);
    const binder = new SandboxRequestBinder({
      transactionManager: new TransactionManager(knex),
      createRepositories: (db) => ({
        toolExecutions: new ToolExecutionRepository(db),
      }),
      context: RUN,
      executionFenceToken: RUN.executionFenceToken,
    });
    const hash = computeSandboxToolRequestHash({
      toolName: 'bash',
      args: { command: 'true', timeoutSeconds: 120, env: {} },
    });
    const out = await binder.bindSandboxRequest({
      toolCallId: 'tc-bind-svc',
      toolName: 'bash',
      requestHash: hash.requestHash,
      requestHashVersion: hash.requestHashVersion,
    });
    assert.equal(out.toolExecutionId, TE);
    assert.equal(out.bound, true);
    assert.equal(out.requestHash, hash.requestHash);
    assert.equal(state.tables.tool_executions[0].request_hash, hash.requestHash);
    assert.equal(
      state.tables.tool_executions[0].execution_fence_token,
      RUN.executionFenceToken,
    );
  });

  it('fails closed when ledger row is not RUNNING', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    seed(state, { status: TOOL_EXECUTION_STATUS.PROPOSED });
    const binder = new SandboxRequestBinder({
      transactionManager: new TransactionManager(knex),
      createRepositories: (db) => ({
        toolExecutions: new ToolExecutionRepository(db),
      }),
      context: RUN,
      executionFenceToken: RUN.executionFenceToken,
    });
    const hash = computeSandboxToolRequestHash({
      toolName: 'bash',
      args: {},
    });
    await assert.rejects(
      () =>
        binder.bindSandboxRequest({
          toolCallId: 'tc-bind-svc',
          toolName: 'bash',
          requestHash: hash.requestHash,
          requestHashVersion: 1,
        }),
      ConflictError,
    );
  });

  it('fails closed when ledger row is absent', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    seed(state);
    state.tables.tool_executions = [];
    const binder = new SandboxRequestBinder({
      transactionManager: new TransactionManager(knex),
      createRepositories: (db) => ({
        toolExecutions: new ToolExecutionRepository(db),
      }),
      context: RUN,
      executionFenceToken: RUN.executionFenceToken,
    });
    const hash = computeSandboxToolRequestHash({
      toolName: 'bash',
      args: {},
    });
    await assert.rejects(
      () =>
        binder.bindSandboxRequest({
          toolCallId: 'missing-call',
          toolName: 'bash',
          requestHash: hash.requestHash,
          requestHashVersion: 1,
        }),
      NotFoundError,
    );
  });

  it('rejects string/bool requestHashVersion at binder', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    seed(state);
    const binder = new SandboxRequestBinder({
      transactionManager: new TransactionManager(knex),
      createRepositories: (db) => ({
        toolExecutions: new ToolExecutionRepository(db),
      }),
      context: RUN,
      executionFenceToken: RUN.executionFenceToken,
    });
    const hash = computeSandboxToolRequestHash({ toolName: 'bash', args: {} });
    for (const bad of ['1', true, 1.5, NaN]) {
      await assert.rejects(
        () =>
          binder.bindSandboxRequest({
            toolCallId: 'tc-bind-svc',
            toolName: 'bash',
            requestHash: hash.requestHash,
            requestHashVersion: bad,
          }),
        /positive safe integer/,
      );
    }
  });
});
