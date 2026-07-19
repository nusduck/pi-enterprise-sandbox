import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeToolRequestHashV1 } from '../../src/domain/tool/tool-request-hash.js';
import { verifyInternalToken } from '../../src/infrastructure/sandbox/internal-hmac.js';
import { createInternalProcessTransport, PROCESS_START_HTU } from '../../src/infrastructure/sandbox/internal-process-http.js';

const KEYRING = { current: Buffer.from('internal-process-test-key-material-32b').toString('base64url') };
const identity = { orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z', userId: '01K0G2PAV8FPMVC9QHJG7JPN50', conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51', agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52', runId: '01K0G2PAV8FPMVC9QHJG7JPN5H', sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F', traceId: 'b'.repeat(32), executionFenceToken: 7 };

function payload(toolName, args) {
  const hash = computeToolRequestHashV1({ toolName, args });
  return { ...args, identity, toolExecutionId: '01K0G2PAV8FPMVC9QHJG7PJN70', toolCallId: 'call-1', requestHash: hash.requestHash, requestHashVersion: 1 };
}

describe('createInternalProcessTransport', () => {
  it('binds exact start bytes and claims to the HMAC request', async () => {
    let sent;
    const transport = createInternalProcessTransport({
      baseUrl: 'http://127.0.0.1:8081', keyring: KEYRING, activeKid: 'current', allowInsecureHttp: true,
      clock: () => 1_800_000_000, randomBytes: () => new Uint8Array(16).fill(3),
      fetchImpl: async (url, init) => { sent = { url, init }; return { ok: true, status: 200, text: async () => JSON.stringify({ processId: '01K0G2PAV8FPMVC9QHJG7PJN71', status: 'RUNNING', stdoutCursor: '0-0', stderrCursor: '0-0', startedAt: null }) }; },
    });
    const input = payload('process_start', { command: 'sleep 1', env: {}, timeoutSeconds: 30 });
    const result = await transport.processStart(input);
    assert.equal(result.status, 'RUNNING');
    assert.equal(sent.url, `http://127.0.0.1:8081${PROCESS_START_HTU}`);
    assert.deepEqual(JSON.parse(Buffer.from(sent.init.body).toString()), input);
    const token = sent.init.headers.Authorization.slice('Bearer '.length);
    const claims = verifyInternalToken(token, { keyring: KEYRING, clock: () => 1_800_000_001 });
    assert.equal(claims.tool_name, 'process_start');
    assert.deepEqual(claims.scope, ['sandbox.processes.process_start']);
    assert.equal(claims.htu, PROCESS_START_HTU);
    assert.equal(claims.body_sha256, createHash('sha256').update(sent.init.body).digest('hex'));
    assert.equal(claims.sandbox_session_id, identity.sandboxSessionId);
    assert.equal(claims.request_hash, input.requestHash);
    assert.equal(sent.init.headers['X-Trace-Id'], identity.traceId);
    assert.match(sent.init.headers.traceparent, new RegExp(`^00-${identity.traceId}-[0-9a-f]{16}-01$`));
  });

  it('rejects process kill signals outside the formal allowlist before fetch', async () => {
    let fetchCalls = 0;
    const transport = createInternalProcessTransport({
      baseUrl: 'http://127.0.0.1:8081', keyring: KEYRING, activeKid: 'current', allowInsecureHttp: true,
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    });
    const input = payload('process_kill', {
      processId: '01K0G2PAV8FPMVC9QHJG7PJN71',
      signal: 'SIGSTOP',
    });

    await assert.rejects(
      transport.processKill(input),
      (err) => err?.code === 'PROCESS_PAYLOAD_INVALID',
    );
    assert.equal(fetchCalls, 0);
  });
});
