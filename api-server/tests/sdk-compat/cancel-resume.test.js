/**
 * Cancel-on-disconnect and multi-turn resume contracts in the BFF chat path.
 * No live LLM — source + helper assertions only.
 * Run: node --test api-server/tests/sdk-compat/cancel-resume.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toAgentHistoryMessages, toPersistableMessages } from '../../routes/chat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const chatSrc = readFileSync(join(__dirname, '../../routes/chat.js'), 'utf8');

describe('cancel on client disconnect', () => {
  it('chat.js cancels active sandbox execution when the SSE client goes away', () => {
    assert.match(chatSrc, /cancelActiveExecution/);
    assert.match(chatSrc, /onClientGone/);
    assert.match(chatSrc, /req\.on\('close',\s*onClientGone\)/);
    assert.match(chatSrc, /req\.on\('aborted',\s*onClientGone\)/);
    assert.match(chatSrc, /res\.on\('close',\s*onClientGone\)/);
  });

  it('does not treat finished turns as cancel targets', () => {
    // Guard: onClientGone must early-return when finished is true
    assert.match(chatSrc, /if\s*\(\s*finished\s*\)\s*return/);
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
    assert.equal(history.length, 3);
    assert.equal(history[0].role, 'user');
    assert.equal(history[1].role, 'assistant');
    assert.equal(history[1].model, 'resume-model');
    assert.equal(history[2].content, 'second');
  });

  it('persistable snapshot stays text-only for conversation DB resume', () => {
    const out = toPersistableMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { role: 'tool', content: 'ignored' },
    ]);
    assert.deepEqual(out, [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
  });

  it('chat.js wires history restore before prompt (session.agent.state.messages)', () => {
    assert.match(chatSrc, /toAgentHistoryMessages/);
    assert.match(chatSrc, /session\.agent\.state\.messages/);
  });
});
