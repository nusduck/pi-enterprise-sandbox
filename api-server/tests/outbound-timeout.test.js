/**
 * Every BFF → downstream call must be time-bounded.
 *
 * Reproduction: point the client at an upstream that accepts the connection
 * and then never answers. Without a timeout the fetch never settles — the
 * browser request, its socket and the Node handles stay pinned for as long as
 * the upstream keeps the connection open, so one stuck dependency turns into
 * exhausted sockets across the whole BFF.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import http from 'node:http';

/** Upstream that accepts and then goes silent. */
const blackhole = http.createServer(() => {});
const held = [];
blackhole.on('connection', (socket) => held.push(socket));

await new Promise((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
const port = blackhole.address().port;

process.env.AGENT_BASE_URL = `http://127.0.0.1:${port}`;
process.env.SANDBOX_BASE_URL = `http://127.0.0.1:${port}`;
process.env.AGENT_REQUEST_TIMEOUT_MS = '300';
process.env.SANDBOX_REQUEST_TIMEOUT_MS = '300';
process.env.AUTH_ENABLED = 'false';

const agentClient = await import(`../src/services/agent-client.js?t=${Date.now()}`);
const { createSandboxClient } = await import(
  `../src/services/sandbox-client.js?t=${Date.now()}`
);

const AUTH = { actingUserId: 'u', actingOrganizationId: 'o' };

describe('outbound calls are time-bounded', () => {
  after(() => {
    for (const socket of held) socket.destroy();
    blackhole.close();
  });

  /** Fails by hanging when the call has no timeout. */
  async function mustSettle(label, call) {
    const outcome = await Promise.race([
      call().then(
        () => 'resolved',
        (err) => err,
      ),
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 3000)),
    ]);
    assert.notEqual(outcome, 'HUNG', `${label} never settled against a dead upstream`);
    return outcome;
  }

  it('Agent conversation reads give up', async () => {
    const err = await mustSettle('listAgentConversations', () =>
      agentClient.listAgentConversations({ auth: AUTH }),
    );
    assert.match(String(err?.message ?? err), /timed out|aborted/i);
  });

  it('Agent run creation gives up', async () => {
    await mustSettle('createAgentRun', () =>
      agentClient.createAgentRun(
        { conversationId: 'c', message: 'hi' },
        { auth: AUTH, idempotencyKey: 'k' },
      ),
    );
  });

  it('Agent process control gives up', async () => {
    await mustSettle('signalAgentProcess', () =>
      agentClient.signalAgentProcess('p', { signal: 'SIGTERM' }, { auth: AUTH }),
    );
  });

  it('Agent capability diagnostics give up', async () => {
    await mustSettle('getAgentExtensionDiagnostics', () =>
      agentClient.getAgentExtensionDiagnostics('coding-agent', { auth: AUTH }),
    );
  });

  it('Sandbox calls carry a default deadline of their own', async () => {
    const sandbox = createSandboxClient();
    await mustSettle('sandbox.authMe', () => sandbox.authMe());
  });
});
