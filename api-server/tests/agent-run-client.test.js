/**
 * Smoke tests for BFF agent-client + Run relay hooks (no live agent).
 * Run: node --test api-server/tests/agent-run-client.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  createAgentRun,
  createConversationFollowUp,
  steerAgentRun,
  getAgentRunTrace,
} from '../services/agent-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientSrc = readFileSync(join(__dirname, '../services/sandbox-client.js'), 'utf8');
const agentClientSrc = readFileSync(join(__dirname, '../services/agent-client.js'), 'utf8');
const runsSrc = readFileSync(join(__dirname, '../routes/runs.js'), 'utf8');
const serverSrc = readFileSync(join(__dirname, '../server.js'), 'utf8');
const convSrc = readFileSync(join(__dirname, '../routes/conversations.js'), 'utf8');
const timelineSrc = readFileSync(
  join(__dirname, '../application/conversation-timeline-service.js'),
  'utf8',
);
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));

describe('thin BFF agent relay', () => {
  it('preserves the Agent initialization timeout code for the public BFF error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: 'Agent run initialization timed out after 15000ms',
          code: 'RUN_INITIALIZATION_TIMEOUT',
        }),
        { status: 504, headers: { 'Content-Type': 'application/json' } },
      );
    try {
      await assert.rejects(
        createAgentRun({ messages: [{ role: 'user', content: 'timeout' }] }),
        (error) => {
          assert.equal(error.status, 504);
          assert.equal(error.code, 'RUN_INITIALIZATION_TIMEOUT');
          assert.match(error.message, /initialization timed out/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not depend on pi-coding-agent', () => {
    const deps = pkg.dependencies || {};
    assert.equal(
      deps['@earendil-works/pi-coding-agent'],
      undefined,
      'api-server must not depend on SDK after cutover',
    );
    assert.doesNotMatch(runsSrc, /createAgentSession|@earendil-works\/pi-coding-agent/);
  });

  it('agent-client exposes create / events / cancel', () => {
    for (const name of ['createAgentRun', 'openAgentRunEvents', 'cancelAgentRun', 'getAgentRunTrace', 'checkAgentHealth']) {
      assert.match(agentClientSrc, new RegExp(`export async function ${name}\\(`));
    }
  });

  it('getAgentRunTrace uses the owner-scoped Agent trace endpoint', async () => {
    const originalFetch = globalThis.fetch;
    let call = null;
    globalThis.fetch = async (url, init) => {
      call = { url: String(url), init };
      return new Response(
        JSON.stringify({ traceId: 'a'.repeat(32), spans: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    try {
      const result = await getAgentRunTrace(
        '01K0G2PAV8FPMVC9QHJG7JPN53',
        { traceId: 'a'.repeat(32), limit: 10, cursor: 'b'.repeat(16) },
      );
      assert.equal(result.spans.length, 0);
      assert.match(
        call.url,
        /\/internal\/agent-runs\/.*\/trace\?limit=10&cursor=b{16}$/,
      );
      assert.match(call.init.headers.traceparent, /^00-a{32}-[0-9a-f]{16}-01$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('forwards durable idempotency to steer and conversation follow-up', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ status: 'ACCEPTED' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      await steerAgentRun(
        '01K0G2PAV8FPMVC9QHJG7JPN53',
        { text: 'steer' },
        { idempotencyKey: 'steer-key' },
      );
      await createConversationFollowUp(
        '01K0G2PAV8FPMVC9QHJG7JPN51',
        { text: 'follow' },
        { idempotencyKey: 'follow-key' },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.match(calls[0].url, /\/internal\/agent-runs\/.*\/steer$/);
    assert.equal(calls[0].init.headers['Idempotency-Key'], 'steer-key');
    assert.match(
      calls[1].url,
      /\/internal\/conversations\/.*\/follow-ups$/,
    );
    assert.equal(calls[1].init.headers['Idempotency-Key'], 'follow-key');
    assert.match(serverSrc, /handleConversationFollowUp/);
    assert.match(serverSrc, /follow-ups/);
  });

  it('Run API creates runs and streams sequenced events', () => {
    assert.match(runsSrc, /handleCreateRun/);
    assert.match(runsSrc, /createAgentRun/);
    assert.match(runsSrc, /handleRunEvents/);
    assert.match(runsSrc, /openAgentRunEvents/);
  });

  it('PR-13: sandbox-client does not dual-write Agent Run fact state', () => {
    for (const name of [
      'createAgentRun',
      'appendAgentEvent',
      'listAgentEvents',
      'listAgentRuns',
      'interruptAgentRun',
      'completeAgentRun',
      'failAgentRun',
    ]) {
      assert.doesNotMatch(clientSrc, new RegExp(`async ${name}\\(`));
    }
  });

  it('agent-client exposes listAgentEvents for conversation timeline (MySQL)', () => {
    assert.match(agentClientSrc, /export async function listAgentEvents\(/);
    assert.match(agentClientSrc, /format.*json/);
  });

  it('server routes conversation events endpoint via Agent MySQL', () => {
    assert.match(serverSrc, /handleGetConversationEvents/);
    assert.match(serverSrc, /\/events/);
    assert.match(convSrc, /loadConversationTimeline/);
    assert.match(convSrc, /listAgentRuns/);
    assert.match(convSrc, /listAgentEvents/);
    assert.match(convSrc, /agent-client/);
    assert.match(convSrc, /resolveTrustedAuth\(req\)/);
    assert.match(timelineSrc, /listAgentRuns/);
    assert.match(timelineSrc, /listAgentEvents/);
    assert.match(timelineSrc, /last_run/);
    assert.doesNotMatch(convSrc, /createSandboxClient.*listAgentRuns|listAgentRuns.*sandbox/i);
  });

  it('routes conversation CRUD to Agent MySQL instead of Sandbox legacy storage', () => {
    for (const name of [
      'listAgentConversations',
      'getAgentConversation',
      'createAgentConversation',
      'deleteAgentConversation',
    ]) {
      assert.match(agentClientSrc, new RegExp(`export async function ${name}\\(`));
      assert.match(convSrc, new RegExp(`${name}\\(`));
    }
    assert.match(convSrc, /resolveTrustedAuth\(req\)/);
    assert.doesNotMatch(convSrc, /sandbox-client/);
    assert.doesNotMatch(convSrc, /sb\.(list|get|create|delete)Conversation/);
  });

  it('server exposes the Run list contract used by refresh recovery', () => {
    assert.match(serverSrc, /req\.method === 'GET' && path === '\/api\/runs'/);
    assert.match(runsSrc, /handleListRuns/);
    assert.match(agentClientSrc, /export async function listAgentRuns\(/);
  });

  it('GET Run uses Agent owner scope (no Sandbox status fallback)', () => {
    // PR-04/PR-10: Agent MySQL is fact source; presentRunDetail formats Agent DTO only.
    assert.match(runsSrc, /presentRunDetail\(null, live, true\)/);
    assert.match(runsSrc, /authorizeRunRequest/);
    assert.match(runsSrc, /getAgentRun/);
    assert.doesNotMatch(runsSrc, /listAgentRuns\(\s*\{\s*runId/);
  });
});
