import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInternalSessionProvisioner,
  SESSION_ENSURE_HTU,
  SESSION_ENSURE_SCOPE,
  SESSION_ENSURE_TOOL_NAME,
} from '../../src/infrastructure/sandbox/internal-session-http.js';
import { verifyInternalToken } from '../../src/infrastructure/sandbox/internal-hmac.js';

const KEYRING = { 'kid-1': Buffer.alloc(32, 7).toString('base64url') };
const NOW = 1_700_000_000;
const INPUT = {
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN53',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN54',
  workspaceId: '01K0G2PAV8FPMVC9QHJG7JPN55',
  executionFenceToken: 4,
  traceId: '0123456789abcdef0123456789abcdef',
};

describe('internal session HTTP transport', () => {
  it('binds HMAC claims to the exact workspace request and response tuple', async () => {
    let captured;
    const provisioner = createInternalSessionProvisioner({
      baseUrl: 'http://sandbox:8081',
      allowInsecureHttp: true,
      keyring: KEYRING,
      activeKid: 'kid-1',
      clock: () => NOW,
      fetchImpl: async (url, init) => {
        captured = { url, init };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            sandboxSessionId: INPUT.sandboxSessionId,
            agentSessionId: INPUT.agentSessionId,
            workspaceId: INPUT.workspaceId,
            status: 'ACTIVE',
          }),
        };
      },
    });

    const result = await provisioner.ensure(INPUT);

    assert.equal(captured.url, `http://sandbox:8081${SESSION_ENSURE_HTU}`);
    assert.equal(
      captured.init.body.toString('utf8'),
      JSON.stringify({ workspaceId: INPUT.workspaceId }),
    );
    assert.equal(
      captured.init.headers['content-length'],
      undefined,
      'undici derives Content-Length from the Buffer body',
    );
    const token = captured.init.headers.authorization.slice('Bearer '.length);
    const claims = verifyInternalToken(token, {
      keyring: KEYRING,
      clock: () => NOW,
    });
    assert.equal(claims.htu, SESSION_ENSURE_HTU);
    assert.equal(claims.tool_name, SESSION_ENSURE_TOOL_NAME);
    assert.deepEqual(claims.scope, [SESSION_ENSURE_SCOPE]);
    assert.equal(claims.sandbox_session_id, INPUT.sandboxSessionId);
    assert.equal(claims.agent_session_id, INPUT.agentSessionId);
    assert.equal(captured.init.headers['X-Trace-Id'], INPUT.traceId);
    assert.match(
      captured.init.headers.traceparent,
      new RegExp(`^00-${INPUT.traceId}-[0-9a-f]{16}-01$`),
    );
    assert.equal(result.status, 'ACTIVE');
  });

  it('rejects a successful HTTP response with a different binding', async () => {
    const provisioner = createInternalSessionProvisioner({
      baseUrl: 'http://sandbox:8081',
      allowInsecureHttp: true,
      keyring: KEYRING,
      activeKid: 'kid-1',
      clock: () => NOW,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          sandboxSessionId: INPUT.sandboxSessionId,
          agentSessionId: INPUT.agentSessionId,
          workspaceId: '01K0G2PAV8FPMVC9QHJG7JPN56',
          status: 'ACTIVE',
        }),
      }),
    });

    await assert.rejects(provisioner.ensure(INPUT), /response binding mismatch/);
  });

  it('uses the scoped pre-run claim profile when no Run exists yet', async () => {
    let token;
    const provisioner = createInternalSessionProvisioner({
      baseUrl: 'http://sandbox:8081',
      allowInsecureHttp: true,
      keyring: KEYRING,
      activeKid: 'kid-1',
      clock: () => NOW,
      fetchImpl: async (_url, init) => {
        token = init.headers.authorization.slice('Bearer '.length);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            sandboxSessionId: INPUT.sandboxSessionId,
            agentSessionId: INPUT.agentSessionId,
            workspaceId: INPUT.workspaceId,
            status: 'ACTIVE',
          }),
        };
      },
    });

    const { runId: _runId, executionFenceToken: _fence, ...preRun } = INPUT;
    await provisioner.ensure(preRun);
    const claims = verifyInternalToken(token, {
      keyring: KEYRING,
      clock: () => NOW,
    });
    assert.equal(claims.run_id, null);
    assert.equal(claims.execution_fence_token, null);
    assert.equal(claims.tool_name, SESSION_ENSURE_TOOL_NAME);
    assert.deepEqual(claims.scope, [SESSION_ENSURE_SCOPE]);
  });

  it('does not allow a partial Run/fence identity', async () => {
    const provisioner = createInternalSessionProvisioner({
      baseUrl: 'http://sandbox:8081',
      allowInsecureHttp: true,
      keyring: KEYRING,
      activeKid: 'kid-1',
      fetchImpl: async () => assert.fail('must fail before fetch'),
    });
    await assert.rejects(
      provisioner.ensure({ ...INPUT, executionFenceToken: null }),
      /must be provided together/,
    );
  });
});
