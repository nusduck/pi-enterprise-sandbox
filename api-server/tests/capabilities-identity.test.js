/**
 * Capability/diagnostics BFF identity forwarding.
 * Run: node --test api-server/tests/capabilities-identity.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const capabilitiesSrc = readFileSync(join(__dirname, '../routes/capabilities.js'), 'utf8');
const serverSrc = readFileSync(join(__dirname, '../server.js'), 'utf8');
const agentClientSrc = readFileSync(join(__dirname, '../services/agent-client.js'), 'utf8');

const originalFetch = globalThis.fetch;
process.env.AUTH_ENABLED = 'false';
process.env.AGENT_BASE_URL = 'http://agent.test';

const { getAgentExtensionDiagnostics } = await import(
  `../services/agent-client.js?test=${Date.now()}`
);

describe('capability diagnostics identity forwarding', () => {
  it('handlers accept req and resolve trusted auth before agent call', () => {
    assert.match(capabilitiesSrc, /export async function handleExtensionDiagnostics\(parsedUrl, res, req\)/);
    assert.match(capabilitiesSrc, /export async function handleCapabilityRegistry\(kind, parsedUrl, res, req\)/);
    assert.match(capabilitiesSrc, /resolveTrustedAuth\(req\)/);
    assert.match(capabilitiesSrc, /getAgentExtensionDiagnostics\(profileId, \{ auth, traceId \}\)/);
  });

  it('server passes req into capability and diagnostics handlers', () => {
    assert.match(serverSrc, /handleExtensionDiagnostics\(parsedUrl, res, req\)/);
    assert.match(serverSrc, /handleCapabilityRegistry\(capability\[1\], parsedUrl, res, req\)/);
  });

  it('agent-client diagnostics uses requestHeaders for acting identity', () => {
    assert.match(
      agentClientSrc,
      /export async function getAgentExtensionDiagnostics\([\s\S]*?\{ auth = null, traceId = null \} = \{\}\)/,
    );
    assert.match(agentClientSrc, /headers: requestHeaders\(\{ auth, traceId \}\)/);
  });

  it('forwards trusted acting headers to Agent diagnostics', async () => {
    let captured = null;
    globalThis.fetch = async (input, init) => {
      captured = { url: String(input), headers: init?.headers || {} };
      return new Response(JSON.stringify({ status: 'ok', view: 'configured' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      await getAgentExtensionDiagnostics('coding-agent', {
        auth: {
          authorization: 'Bearer trusted-token',
          actingUserId: 'user_a',
          actingOrganizationId: 'org_a',
          actingRole: 'user',
        },
        traceId: 'trace-123',
      });
      assert.equal(captured.url, 'http://agent.test/internal/extensions/diagnostics?profile_id=coding-agent');
      assert.equal(captured.headers.Authorization, 'Bearer trusted-token');
      assert.equal(captured.headers['X-Acting-User-Id'], 'user_a');
      assert.equal(captured.headers['X-Acting-Organization-Id'], 'org_a');
      assert.equal(captured.headers['X-Acting-Role'], 'user');
      assert.equal(captured.headers['X-Trace-Id'], 'trace-123');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});