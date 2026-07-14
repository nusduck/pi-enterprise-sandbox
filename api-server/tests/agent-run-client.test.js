/**
 * Smoke tests for BFF agent-client + Run relay hooks (no live agent).
 * Run: node --test api-server/tests/agent-run-client.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
    for (const name of ['createAgentRun', 'openAgentRunEvents', 'cancelAgentRun', 'checkAgentHealth']) {
      assert.match(agentClientSrc, new RegExp(`export async function ${name}\\(`));
    }
  });

  it('Run API creates runs and streams sequenced events', () => {
    assert.match(runsSrc, /handleCreateRun/);
    assert.match(runsSrc, /createAgentRun/);
    assert.match(runsSrc, /handleRunEvents/);
    assert.match(runsSrc, /openAgentRunEvents/);
  });

  it('sandbox-client still exposes agent-run persistence helpers for conversations', () => {
    for (const name of [
      'createAgentRun',
      'appendAgentEvent',
      'listAgentEvents',
      'listAgentRuns',
      'interruptAgentRun',
      'completeAgentRun',
      'failAgentRun',
    ]) {
      assert.match(clientSrc, new RegExp(`async ${name}\\(`));
    }
  });

  it('server routes conversation events endpoint', () => {
    assert.match(serverSrc, /handleGetConversationEvents/);
    assert.match(serverSrc, /\/events/);
    assert.match(convSrc, /loadConversationTimeline/);
    assert.match(timelineSrc, /listAgentRuns/);
    assert.match(timelineSrc, /listAgentEvents/);
    assert.match(timelineSrc, /last_run/);
  });

  it('server exposes the Run list contract used by refresh recovery', () => {
    assert.match(serverSrc, /req\.method === 'GET' && path === '\/api\/runs'/);
    assert.match(runsSrc, /handleListRuns/);
    assert.match(clientSrc, /async listAgentRuns\(/);
  });
});
