/**
 * P1b：认证 HTTP 边界。真实（mock fetch 的）请求形状与失败分类是契约：
 * config 走 `GET /api/auth/config`，logout 保留 409/503 的 code，me 的 3xx
 * 视为未认证（不跟到登录页拿 HTML）。
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAuthConfig, login, logout, me } from '../src/shared/api/auth.ts';
import { ApiError } from '../src/shared/api/client.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('GET /api/auth/config', () => {
  it('reads the projection with credentials and parses the locked DTO', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({
        mode: 'local',
        methods: {
          local: { enabled: true, registration_enabled: false },
          sso: { enabled: false, available: false, label: '公司 SSO' },
        },
        profile_policy: { editable_fields: ['display_name'] },
      });
    }) as typeof fetch;

    const config = await getAuthConfig();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/auth/config');
    assert.equal(calls[0].init?.credentials, 'include');
    assert.equal(config.methods?.local?.enabled, true);
    assert.equal(config.methods?.sso?.available, false);
  });

  it('surfaces a 503 as an ApiError instead of an empty capability set', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: 'auth store unavailable', code: 'AUTH_STORE_UNAVAILABLE' }, 503)) as typeof fetch;
    await assert.rejects(
      () => getAuthConfig(),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).status, 503);
        assert.equal((err as ApiError).code, 'AUTH_STORE_UNAVAILABLE');
        return true;
      },
    );
  });
});

describe('GET /api/auth/config malformed 200', () => {
  /**
   * 回归：HTTP 200 的坏 DTO 是**契约错误**（失败 + 可重试），不是「部署没有
   * 开放任何登录方式」的空能力集。`parseApi` 对 schema 校验失败是软失败，
   * 所以 AuthConfigSchema 自身必须让请求 reject。
   */
  const malformed: Array<[string, unknown]> = [
    ['an empty object', {}],
    ['methods without any recognized login method', { mode: 'local', methods: {} }],
    ['a config that omits methods', { mode: 'local' }],
    ['a config that omits mode', { methods: { local: { enabled: true } } }],
    ['a blank mode', { mode: '', methods: { local: { enabled: true } } }],
  ];

  for (const [label, body] of malformed) {
    it(`rejects a 200 with ${label}`, async () => {
      globalThis.fetch = (async () => jsonResponse(body)) as typeof fetch;
      await assert.rejects(
        () => getAuthConfig(),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(String((err as Error).message), /auth config contract mismatch/);
          return true;
        },
      );
    });
  }

  it('still resolves a valid but explicitly disabled config', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        mode: 'local',
        methods: {
          local: { enabled: false, registration_enabled: false },
          sso: { enabled: false, available: false },
        },
      })) as typeof fetch;
    const config = await getAuthConfig();
    assert.equal(config.mode, 'local');
    assert.equal(config.methods?.local?.enabled, false);
    assert.equal(config.methods?.sso?.available, false);
  });
});

describe('auth responses', () => {
  it('me treats a redirect as unauthenticated rather than following it', async () => {
    globalThis.fetch = (async () => new Response('', { status: 302 })) as typeof fetch;
    await assert.rejects(
      () => me(),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).status, 401);
        return true;
      },
    );
  });

  it('me keeps the parsed role set and identity source fields', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        username: 'alice',
        roles: ['admin'],
        role: 'admin',
        login_method: 'local',
        identity_provider: null,
      })) as typeof fetch;
    const user = await me();
    assert.deepEqual(user.roles, ['admin']);
    assert.equal(user.login_method, 'local');
    assert.equal(user.identity_provider, null);
  });

  it('login never exposes a token even if the upstream body carries one', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ token: 'secret', user: { username: 'alice', login_method: 'local' } })) as typeof fetch;
    const res = await login({ username: 'alice', password: 'pw' });
    assert.equal('token' in res, false);
    assert.equal(res.user?.username, 'alice');
  });

  it('logout maps the 409 legacy contract to an ApiError with its code', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: 'legacy session', code: 'LEGACY_SESSION_NOT_REVOCABLE' }, 409)) as typeof fetch;
    await assert.rejects(
      () => logout(),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as ApiError).status, 409);
        assert.equal((err as ApiError).code, 'LEGACY_SESSION_NOT_REVOCABLE');
        return true;
      },
    );
  });

  it('logout returns the server revocation outcome on success', async () => {
    globalThis.fetch = (async () => jsonResponse({ ok: true, revocation: 'confirmed' })) as typeof fetch;
    const outcome = await logout();
    assert.equal(outcome.revocation, 'confirmed');
    assert.equal(outcome.warning, null);
  });
});
