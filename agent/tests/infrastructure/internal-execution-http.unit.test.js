import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeToolRequestHashV1 } from '../../src/domain/tool/tool-request-hash.js';
import {
  BASH_EXECUTION_HTU,
  BASH_EXECUTION_SCOPE,
  InternalExecutionTransportError,
  PYTHON_EXECUTION_HTU,
  PYTHON_EXECUTION_SCOPE,
  buildInternalExecutionBodyBytes,
  createInternalExecutionTransport,
} from '../../src/infrastructure/sandbox/internal-execution-http.js';
import { verifyInternalToken } from '../../src/infrastructure/sandbox/internal-hmac.js';

const KEY = Buffer.from('formal-execution-unit-test-key-32bytes').toString(
  'base64url',
);
const KEYRING = { current: KEY };
const IDENTITY = Object.freeze({
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
  traceId: 'b'.repeat(32),
  executionFenceToken: 7,
});
const TOOL_EXECUTION_ID = '01K0G2PAV8FPMVC9QHJG7JPN70';

function payload(toolName, args) {
  const hash = computeToolRequestHashV1({ toolName, args });
  return {
    ...args,
    identity: { ...IDENTITY },
    toolExecutionId: TOOL_EXECUTION_ID,
    toolCallId: `${toolName}-call-1`,
    requestHash: hash.requestHash,
    requestHashVersion: hash.requestHashVersion,
  };
}

function jsonResponse(status, value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === 'content-length') {
          return String(bytes.byteLength);
        }
        return 'application/json';
      },
    },
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    },
  };
}

function authClaims(call) {
  const token = call.init.headers.Authorization.slice('Bearer '.length);
  return verifyInternalToken(token, {
    keyring: KEYRING,
    clock: () => 1_800_000_001,
  });
}

describe('createInternalExecutionTransport', () => {
  it('binds the exact bash body, HMAC claims, route, and response', async () => {
    const calls = [];
    const args = {
      command: 'printf ok',
      timeoutSeconds: 30,
      env: { MODE: 'test' },
    };
    const input = payload('bash', args);
    const transport = createInternalExecutionTransport({
      baseUrl: 'http://127.0.0.1:8081',
      keyring: KEYRING,
      activeKid: 'current',
      clock: () => 1_800_000_000,
      randomBytes: () => new Uint8Array(16).fill(4),
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(200, {
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
          truncated: false,
          durationMs: 12.5,
        });
      },
    });

    const result = await transport.bash(input);

    assert.equal(result.stdout, 'ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `http://127.0.0.1:8081${BASH_EXECUTION_HTU}`);
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(Buffer.from(calls[0].init.body).toString()), input);
    const bodySha256 = createHash('sha256')
      .update(calls[0].init.body)
      .digest('hex');
    const claims = authClaims(calls[0]);
    assert.equal(claims.tool_name, 'bash');
    assert.deepEqual(claims.scope, [BASH_EXECUTION_SCOPE]);
    assert.equal(claims.htu, BASH_EXECUTION_HTU);
    assert.equal(claims.body_sha256, bodySha256);
    assert.equal(claims.request_hash, input.requestHash);
    assert.equal(claims.tool_execution_id, input.toolExecutionId);
    assert.equal(claims.tool_call_id, input.toolCallId);
    assert.equal(claims.execution_fence_token, IDENTITY.executionFenceToken);
    assert.equal(calls[0].init.headers['X-Trace-Id'], IDENTITY.traceId);
    assert.match(
      calls[0].init.headers.traceparent,
      new RegExp(`^00-${IDENTITY.traceId}-[0-9a-f]{16}-01$`),
    );
  });

  it('binds Python to its own route/scope and keeps materialization fields', async () => {
    const calls = [];
    const args = {
      code: 'print("hello")',
      args: ['one'],
      timeoutSeconds: 45,
    };
    const input = payload('python', args);
    const transport = createInternalExecutionTransport({
      baseUrl: 'https://sandbox.internal',
      keyring: KEYRING,
      activeKid: 'current',
      clock: () => 1_800_000_000,
      randomBytes: () => new Uint8Array(16).fill(5),
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(200, {
          exitCode: 0,
          stdout: 'hello\n',
          stderr: '',
          truncated: false,
          durationMs: 9,
          materializedPath: '/home/sandbox/workspace/.runtime/python/a.py',
          pythonVersion: '3.12.1',
          pythonMode: 'file',
        });
      },
    });

    const result = await transport.python(input);

    assert.equal(result.pythonMode, 'file');
    assert.equal(calls[0].url, `https://sandbox.internal${PYTHON_EXECUTION_HTU}`);
    const claims = authClaims(calls[0]);
    assert.equal(claims.tool_name, 'python');
    assert.deepEqual(claims.scope, [PYTHON_EXECUTION_SCOPE]);
    assert.equal(claims.htu, PYTHON_EXECUTION_HTU);
  });

  it('rejects a hash mismatch before issuing any network request', async () => {
    let networkCalls = 0;
    const input = payload('bash', {
      command: 'true',
      timeoutSeconds: 5,
      env: {},
    });
    input.command = 'false';
    const transport = createInternalExecutionTransport({
      baseUrl: 'http://localhost:8081',
      keyring: KEYRING,
      activeKid: 'current',
      fetchImpl: async () => {
        networkCalls += 1;
        return jsonResponse(500, {});
      },
    });

    await assert.rejects(
      () => transport.bash(input),
      (error) =>
        error instanceof InternalExecutionTransportError &&
        error.code === 'EXECUTION_HASH_INVALID',
    );
    assert.equal(networkCalls, 0);
  });

  it('preserves ledger conflict codes and marks ambiguous dispatch failures unknown', async () => {
    const input = payload('bash', {
      command: 'sleep 1',
      timeoutSeconds: 5,
      env: {},
    });
    const conflict = createInternalExecutionTransport({
      baseUrl: 'http://localhost:8081',
      keyring: KEYRING,
      activeKid: 'current',
      fetchImpl: async () =>
        jsonResponse(409, {
          error: { code: 'IN_PROGRESS', message: 'Tool execution unavailable' },
        }),
    });
    await assert.rejects(
      () => conflict.bash(input),
      (error) => error.code === 'IN_PROGRESS' && error.httpStatus === 409,
    );

    const ambiguous = createInternalExecutionTransport({
      baseUrl: 'http://localhost:8081',
      keyring: KEYRING,
      activeKid: 'current',
      fetchImpl: async () => {
        throw new TypeError('socket closed');
      },
    });
    await assert.rejects(
      () => ambiguous.bash(input),
      (error) =>
        error.code === 'TOOL_OUTCOME_UNKNOWN' && error.outcomeUnknown === true,
    );

    const interrupted = createInternalExecutionTransport({
      baseUrl: 'http://localhost:8081',
      keyring: KEYRING,
      activeKid: 'current',
      fetchImpl: async () => ({
        ...jsonResponse(200, {}),
        async arrayBuffer() {
          throw new TypeError('response stream reset');
        },
      }),
    });
    await assert.rejects(
      () => interrupted.bash(input),
      (error) =>
        error.code === 'TOOL_OUTCOME_UNKNOWN' && error.outcomeUnknown === true,
    );

    const malformedSuccess = createInternalExecutionTransport({
      baseUrl: 'http://localhost:8081',
      keyring: KEYRING,
      activeKid: 'current',
      fetchImpl: async () => ({
        ...jsonResponse(200, {}),
        async arrayBuffer() {
          const bytes = Buffer.from('{"exitCode":', 'utf8');
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          );
        },
      }),
    });
    await assert.rejects(
      () => malformedSuccess.bash(input),
      (error) =>
        error.code === 'TOOL_OUTCOME_UNKNOWN' && error.outcomeUnknown === true,
    );

    const malformedShutdown = createInternalExecutionTransport({
      baseUrl: 'http://localhost:8081',
      keyring: KEYRING,
      activeKid: 'current',
      fetchImpl: async () => ({
        ...jsonResponse(503, {}),
        async arrayBuffer() {
          const bytes = Buffer.from('upstream closed during shutdown', 'utf8');
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          );
        },
      }),
    });
    await assert.rejects(
      () => malformedShutdown.bash(input),
      (error) =>
        error.code === 'TOOL_OUTCOME_UNKNOWN' && error.outcomeUnknown === true,
    );
  });
});

describe('buildInternalExecutionBodyBytes', () => {
  it('rejects extra root fields and sensitive bash env keys', () => {
    const base = payload('bash', {
      command: 'true',
      timeoutSeconds: 5,
      env: {},
    });
    assert.throws(
      () => buildInternalExecutionBodyBytes('bash', { ...base, extra: true }),
      /keys do not match/,
    );
    const sensitive = payload('bash', {
      command: 'true',
      timeoutSeconds: 5,
      env: { API_KEY: 'secret' },
    });
    assert.throws(
      () => buildInternalExecutionBodyBytes('bash', sensitive),
      /invalid or denied/,
    );
  });
});
