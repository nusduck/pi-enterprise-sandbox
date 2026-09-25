/**
 * `/api/auth/profile`：BFF 只把会话 token 与请求体转给 Agent，字段是否可改由 Agent 判定。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { authProfile } from '../src/services/agent-auth-client.js';
import { asHttpError } from '../src/http/errors.js';

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/auth/profile', () => {
  it('forwards the session token and the PATCH body unchanged', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ url: String(url), init });
      return jsonResponse(200, { username: 'alice' });
    }));
    await authProfile({ authorization: 'Bearer tok' });
    await authProfile({ authorization: 'Bearer tok' }, { method: 'PATCH', body: { email: 'a@b.co', role: 'admin' } });
    assert.match(seen[0].url, /\/internal\/auth\/profile$/);
    assert.equal(seen[0].init.method, 'GET');
    assert.equal(seen[0].init.headers.Authorization, 'Bearer tok');
    assert.equal(seen[1].init.method, 'PATCH');
    // BFF does not strip fields: the Agent refuses non-editable ones explicitly.
    assert.deepEqual(JSON.parse(seen[1].init.body), { email: 'a@b.co', role: 'admin' });
  });

  it('passes the Agent’s refusal through', async (t) => {
    t.after(stubFetch(async () => jsonResponse(422, { error: 'Not editable: role', code: 'PROFILE_FIELD_NOT_EDITABLE' })));
    await assert.rejects(
      authProfile({ authorization: 'Bearer tok' }, { method: 'PATCH', body: { role: 'admin' } }),
      (err) => asHttpError(err).status === 422 && asHttpError(err).code === 'PROFILE_FIELD_NOT_EDITABLE',
    );
  });
});
