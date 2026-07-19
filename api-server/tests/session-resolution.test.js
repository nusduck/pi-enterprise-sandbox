import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const routeSource = readFileSync(join(__dirname, '../routes/sessions.js'), 'utf8');
const clientSource = readFileSync(
  join(__dirname, '../services/agent-client.js'),
  'utf8',
);

describe('formal session ensure authority', () => {
  it('routes pre-upload ensure through Agent and trusted owner resolution', () => {
    assert.match(routeSource, /resolveTrustedAuth\(req\)/);
    assert.match(routeSource, /ensureAgentSession\(/);
    assert.doesNotMatch(routeSource, /sandbox-client/);
    assert.doesNotMatch(routeSource, /resolveConversationAndSession/);
  });

  it('Agent client targets the formal session coordinator endpoint', () => {
    assert.match(clientSource, /export async function ensureAgentSession\(/);
    assert.match(clientSource, /\/internal\/sessions\/ensure/);
    assert.match(clientSource, /requestHeaders\(\{ auth, traceId \}\)/);
  });
});
