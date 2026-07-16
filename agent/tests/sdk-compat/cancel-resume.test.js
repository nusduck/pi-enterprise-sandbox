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
import { toAgentHistoryMessages, toPersistableMessages } from '../../runtime/message-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runnerSrc = readFileSync(join(__dirname, '../../runtime/agent-runtime.js'), 'utf8');
const managerSrc = readFileSync(join(__dirname, '../../application/run-manager.js'), 'utf8');
const bffRunSrc = readFileSync(
  join(__dirname, '../../../api-server/routes/runs.js'),
  'utf8',
);

describe('durable Run SSE disconnect', () => {
  it('BFF aborts only the upstream SSE relay when the client goes away', () => {
    assert.match(bffRunSrc, /req\?\.on\('close',\s*\(\)\s*=>\s*controller\.abort\(\)\)/);
    assert.match(bffRunSrc, /openAgentRunEvents/);
  });

  it('BFF exposes explicit cancel instead of coupling cancellation to transport', () => {
    assert.match(bffRunSrc, /handleCancelRun/);
    assert.match(bffRunSrc, /cancelAgentRun/);
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
