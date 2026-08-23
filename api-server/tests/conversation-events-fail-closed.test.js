/**
 * Conversation events must fail closed on the conversation, not on the runs.
 *
 * Listing runs by conversation id is a filter: another tenant's conversation,
 * a deleted one, and one that never existed all match zero runs and used to
 * answer 200 with an empty timeline — indistinguishable from an owned but idle
 * conversation, and a free existence probe. A malformed id went further still
 * and reached Agent, which answered 500.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const originalFetch = globalThis.fetch;
const originalAgentUrl = process.env.AGENT_BASE_URL;
const originalAuthEnabled = process.env.AUTH_ENABLED;

process.env.AGENT_BASE_URL = 'http://agent.conversations.test';
process.env.AUTH_ENABLED = 'false';

const { handleGetConversationEvents } = await import(
  `../src/routes/conversations.js?test=${Date.now()}`
);

const OWNED = '01K0G2PAV8FPMVC9QHJG7JPN51';
const FOREIGN = '01K0G2PAV8FPMVC9QHJG7JPN52';
const paths = [];

before(() => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname + url.search);
    if (url.pathname === `/internal/conversations/${OWNED}`) {
      return Response.json({ id: OWNED, title: 'Owned' });
    }
    if (url.pathname.startsWith('/internal/conversations/')) {
      return Response.json(
        { error: 'Conversation not found', code: 'NOT_FOUND' },
        { status: 404 },
      );
    }
    if (url.pathname === '/internal/agent-runs') {
      return Response.json({ runs: [] });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalAgentUrl === undefined) delete process.env.AGENT_BASE_URL;
  else process.env.AGENT_BASE_URL = originalAgentUrl;
  if (originalAuthEnabled === undefined) delete process.env.AUTH_ENABLED;
  else process.env.AUTH_ENABLED = originalAuthEnabled;
});

function responseCapture() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status;
    },
    end(body = '') {
      this.body = String(body);
    },
  };
}

const request = () => ({ headers: {}, traceId: 'a'.repeat(32) });

test('an owned conversation still returns its timeline', async () => {
  const res = responseCapture();
  await handleGetConversationEvents(OWNED, res, request());
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).runs, []);
  assert.ok(paths.includes(`/internal/conversations/${OWNED}`), 'ownership is checked first');
});

test('a conversation the caller does not own is 404, not an empty timeline', async () => {
  const res = responseCapture();
  await handleGetConversationEvents(FOREIGN, res, request());
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).code, 'NOT_FOUND');
});

test('a malformed id is refused without reaching Agent', async () => {
  const before = paths.length;
  const res = responseCapture();
  await handleGetConversationEvents('not-a-ulid', res, request());
  assert.equal(res.status, 404);
  assert.equal(paths.length, before, 'no Agent call for an id Agent cannot parse');
});
