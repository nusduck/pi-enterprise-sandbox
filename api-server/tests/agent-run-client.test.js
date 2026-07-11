/**
 * Smoke tests for agent-run sandbox client method shapes (no live sandbox).
 * Run: node --test api-server/tests/agent-run-client.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientSrc = readFileSync(join(__dirname, '../services/sandbox-client.js'), 'utf8');
const chatSrc = readFileSync(join(__dirname, '../routes/chat.js'), 'utf8');
const serverSrc = readFileSync(join(__dirname, '../server.js'), 'utf8');
const convSrc = readFileSync(join(__dirname, '../routes/conversations.js'), 'utf8');

describe('agent session persistence BFF hooks', () => {
  it('sandbox-client exposes agent run / event methods', () => {
    for (const name of [
      'createAgentRun',
      'appendAgentEvent',
      'listAgentEvents',
      'listConversationEvents',
      'getLatestAgentRun',
      'interruptAgentRun',
      'completeAgentRun',
      'failAgentRun',
      'prepareToolExecution',
    ]) {
      assert.match(clientSrc, new RegExp(`async ${name}\\(`));
    }
  });

  it('chat creates run, appends events, interrupts on disconnect', () => {
    assert.match(chatSrc, /createAgentRun/);
    assert.match(chatSrc, /appendAgentEvent|persistEvent/);
    assert.match(chatSrc, /interruptAgentRun|markRunInterrupted/);
    assert.match(chatSrc, /completeAgentRun/);
    assert.match(chatSrc, /token_batch/);
    assert.match(chatSrc, /client_disconnect/);
  });

  it('server routes conversation events endpoint', () => {
    assert.match(serverSrc, /handleGetConversationEvents/);
    assert.match(serverSrc, /\/events/);
    assert.match(convSrc, /listConversationEvents/);
    assert.match(convSrc, /last_run/);
  });
});
