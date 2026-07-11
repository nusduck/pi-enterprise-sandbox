/**
 * Cancel-on-disconnect and multi-turn resume contracts.
 * No live LLM — source + helper assertions only.
 * Run: node --test agent/tests/sdk-compat/cancel-resume.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toAgentHistoryMessages, toPersistableMessages } from '../../message-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runnerSrc = readFileSync(join(__dirname, '../../chat-runner.js'), 'utf8');
const managerSrc = readFileSync(join(__dirname, '../../run-manager.js'), 'utf8');
const bffChatSrc = readFileSync(
  join(__dirname, '../../../api-server/routes/chat.js'),
  'utf8',
);

describe('cancel on client disconnect', () => {
  it('BFF cancels agent run when the SSE client goes away', () => {
    assert.match(bffChatSrc, /cancelAgentRun/);
    assert.match(bffChatSrc, /onClientGone/);
    assert.match(bffChatSrc, /req\.on\('close',\s*onClientGone\)/);
    assert.match(bffChatSrc, /req\.on\('aborted',\s*onClientGone\)/);
    assert.match(bffChatSrc, /res\.on\('close',\s*onClientGone\)/);
  });

  it('BFF does not treat finished turns as cancel targets', () => {
    assert.match(bffChatSrc, /if\s*\(\s*finished\s*\)\s*return/);
  });

  it('agent runner cancels sandbox execution when run is cancelled', () => {
    assert.match(runnerSrc, /cancelActiveExecution/);
    assert.match(runnerSrc, /isCancelled/);
    assert.match(managerSrc, /cancelRun|run\.cancelled/);
  });
});

describe('multi-turn resume helpers', () => {
  it('restores user/assistant history into agent message shapes', () => {
    const history = toAgentHistoryMessages(
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply-1' },
        { role: 'user', content: 'second' },
      ],
      'resume-model',
    );
    // exclude last is done by the caller; helper maps all provided
    assert.equal(history.length, 3);
    assert.equal(history[0].role, 'user');
    assert.equal(history[1].role, 'assistant');
    assert.equal(history[1].model, 'resume-model');
  });

  it('toPersistableMessages keeps text-only turns', () => {
    const out = toPersistableMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
    assert.deepEqual(out, [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
  });
});
