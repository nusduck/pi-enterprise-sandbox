/**
 * `removeSessionWorkspace` 与 exec 新路由 `DELETE /sessions/:id` 的契约。
 *
 * exec 侧此前根本没有这条路由（只有 `/sessions/:id/files|processes|datasets`
 * 子路由），agent 的会话删除 GC 必然失败、fail-soft 只打日志，工作区从不删除。
 * 这里钉死方法/路径/鉴权头/响应形状，以及非 2xx（尤其纯文本 404）时的可读错误。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSandboxClient,
  SandboxError,
} from '../src/infrastructure/sandbox/sandbox-client.js';

function withFetch(stub) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return () => {
    globalThis.fetch = original;
  };
}

test('removeSessionWorkspace uses DELETE /sessions/:id with service + acting headers', async () => {
  const seen = {};
  const restore = withFetch(async (url, options = {}) => {
    seen.url = String(url);
    seen.method = options.method;
    seen.headers = new Headers(options.headers);
    return new Response(JSON.stringify({ removed: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    const client = createSandboxClient({
      auth: { actingUserId: 'user_1', actingOrganizationId: 'org_1', actingRole: 'member' },
    });
    const body = await client.removeSessionWorkspace('sess-1');
    assert.deepEqual(body, { removed: true });
    assert.ok(seen.url.endsWith('/sessions/sess-1'), `unexpected url: ${seen.url}`);
    assert.equal(seen.method, 'DELETE');
    assert.equal(seen.headers.get('x-acting-user-id'), 'user_1');
    assert.equal(seen.headers.get('x-acting-organization-id'), 'org_1');
  } finally {
    restore();
  }
});

test('removeSessionWorkspace encodes the session id', async () => {
  let seenUrl = '';
  const restore = withFetch(async (url) => {
    seenUrl = String(url);
    return new Response(JSON.stringify({ removed: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    await createSandboxClient().removeSessionWorkspace('a/b c');
    assert.ok(seenUrl.endsWith('/sessions/a%2Fb%20c'), `unexpected url: ${seenUrl}`);
  } finally {
    restore();
  }
});

test('removeSessionWorkspace throws a readable error on plain-text 404 (never a JSON parse crash)', async () => {
  const restore = withFetch(async () => new Response('Not Found', { status: 404 }));
  try {
    await assert.rejects(
      createSandboxClient().removeSessionWorkspace('missing'),
      (err) => {
        assert.ok(err instanceof SandboxError, `must be SandboxError, got ${err}`);
        assert.equal(err.status, 404);
        assert.match(String(err.message), /Not Found|404/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('removeSessionWorkspace rejects a well-formed 200 with an unexpected shape', async () => {
  const restore = withFetch(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  try {
    await assert.rejects(
      createSandboxClient().removeSessionWorkspace('sess-1'),
      /response shape/,
      'a 200 without {removed:boolean} must fail loudly, not flow downstream as undefined',
    );
  } finally {
    restore();
  }
});

test('removeSessionWorkspace returns removed:false without throwing', async () => {
  const restore = withFetch(
    async () =>
      new Response(JSON.stringify({ removed: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  try {
    const body = await createSandboxClient().removeSessionWorkspace('gone');
    assert.deepEqual(body, { removed: false });
  } finally {
    restore();
  }
});
