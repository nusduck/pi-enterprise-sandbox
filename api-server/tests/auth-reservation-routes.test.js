/**
 * Production-entry integration: real `dist/server.js` + a fake Agent.
 *
 * Proves the wiring (not just the handler functions): `GET /api/auth/config`
 * proxy, precise logout classification with Cookie clearing, Origin/Fetch
 * Metadata rejection for auth writes, same-origin and no-Origin Bearer
 * success, and that a cross-site request never reaches the Agent.
 *
 * Regression for the P1 dependency-transport contract: when the Agent is
 * unreachable or answers a *successful* status with unparseable JSON, the
 * login/me/profile surface must be a diagnosable `503`
 * `AUTH_DEPENDENCY_UNAVAILABLE` — never a generic `500` and never `401`.
 * Config keeps its own `AUTH_CONFIG_UNAVAILABLE`, and explicit upstream
 * status/code (400/401/403/409/422, `AUTH_STORE_UNAVAILABLE`) is preserved
 * instead of being overwritten by the dependency class.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BFF_ROOT = path.resolve(__dirname, '..');

const CONFIG_DTO = {
  mode: 'local',
  methods: {
    local: { enabled: true, registration_enabled: false },
    sso: { enabled: false, available: false, label: '公司 SSO' },
  },
  profile_policy: { editable_fields: ['display_name', 'email', 'notify_run_complete'] },
};

const PROFILE_DTO = {
  id: 'u1',
  username: 'alice',
  login_method: 'local',
  identity_provider: null,
};

const agentState = {
  configStatus: 200,
  configBody: CONFIG_DTO,
  configDrop: false,
  configInvalidJson: false,
  logoutStatus: 200,
  logoutBody: { ok: true, revocation: 'confirmed' },
  logoutDrop: false,
  loginStatus: 200,
  loginBody: { token: 'agent-jwt-token-value', user: { id: 'u1', username: 'alice' } },
  loginDrop: false,
  loginInvalidJson: false,
  meStatus: 200,
  meBody: PROFILE_DTO,
  meDrop: false,
  meHang: false,
  meInvalidJson: false,
  profileStatus: 200,
  profileBody: PROFILE_DTO,
  profileDrop: false,
  profileInvalidJson: false,
  calls: [],
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function startFakeAgent() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://agent.invalid');
    const body = await readBody(req);
    agentState.calls.push({
      method: req.method,
      path: url.pathname,
      headers: req.headers,
      body,
    });
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const sendRaw = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(text);
    };
    // Drop the connection before any response, like a stopped Agent.
    const drop = (flag) => {
      if (flag) {
        req.socket.destroy();
        return true;
      }
      return false;
    };
    if (url.pathname === '/ready') {
      send(200, { status: 'ready' });
      return;
    }
    if (url.pathname === '/internal/auth/config') {
      if (drop(agentState.configDrop)) return;
      if (agentState.configInvalidJson) {
        sendRaw(200, '{ "mode": "local", ');
        return;
      }
      send(agentState.configStatus, agentState.configBody);
      return;
    }
    if (url.pathname === '/internal/auth/logout') {
      if (drop(agentState.logoutDrop)) return;
      send(agentState.logoutStatus, agentState.logoutBody);
      return;
    }
    if (url.pathname === '/internal/auth/login' || url.pathname === '/internal/auth/register') {
      if (drop(agentState.loginDrop)) return;
      if (agentState.loginInvalidJson) {
        sendRaw(200, '{ "token": "agent-jwt-token-value", ');
        return;
      }
      send(agentState.loginStatus, agentState.loginBody);
      return;
    }
    if (url.pathname === '/internal/auth/me') {
      if (drop(agentState.meDrop)) return;
      if (agentState.meHang) return; // accept and never answer (timeout path)
      if (agentState.meInvalidJson) {
        sendRaw(200, '{ "id": "u1", ');
        return;
      }
      send(agentState.meStatus, agentState.meBody);
      return;
    }
    if (url.pathname === '/internal/auth/profile') {
      if (drop(agentState.profileDrop)) return;
      if (agentState.profileInvalidJson) {
        sendRaw(200, '{ "id": "u1", ');
        return;
      }
      send(agentState.profileStatus, agentState.profileBody);
      return;
    }
    send(404, { error: 'not found', code: 'NOT_FOUND' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function waitForLive(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/live`);
      if (res.status === 200) return;
      lastError = new Error(`status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error('BFF did not start');
}

function logoutCalls() {
  return agentState.calls.filter((call) => call.path === '/internal/auth/logout');
}

describe('auth reservation production routes', () => {
  let agent;
  let child;
  let base;

  before(async () => {
    assert.ok(
      fs.existsSync(path.join(BFF_ROOT, 'dist/server.js')),
      'dist/server.js must exist; run npm run build first',
    );
    agent = await startFakeAgent();
    const agentPort = agent.address().port;
    const port = 22000 + Math.floor(Math.random() * 1000);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['dist/server.js'], {
      cwd: BFF_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        DEPLOYMENT_ENV: 'development',
        AUTH_ENABLED: 'true',
        SANDBOX_BASE_URL: `http://127.0.0.1:${agentPort}`,
        AGENT_BASE_URL: `http://127.0.0.1:${agentPort}`,
        AGENT_INTERNAL_TOKEN: 'test-internal-token',
        // Short bound so the real timeout path is exercisable end-to-end.
        AGENT_REQUEST_TIMEOUT_MS: '800',
        CORS_ALLOWED_ORIGINS: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForLive(port);
  });

  after(async () => {
    if (child) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 3000))]);
      if (child.exitCode == null) child.kill('SIGKILL');
    }
    if (agent) await new Promise((resolve) => agent.close(resolve));
  });

  it('proxies GET /api/auth/config publicly with the internal token and no-store', async () => {
    const res = await fetch(`${base}/api/auth/config`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(body, CONFIG_DTO);
    assert.equal(JSON.stringify(body).includes('agent-jwt-token-value'), false);
    const call = agentState.calls.find((entry) => entry.path === '/internal/auth/config');
    assert.ok(call, 'BFF must call the Agent config authority');
    assert.equal(call.headers['x-internal-token'], 'test-internal-token');
  });

  it('preserves an upstream config failure instead of returning empty capabilities', async () => {
    agentState.configStatus = 503;
    agentState.configBody = { error: 'auth store unavailable', code: 'AUTH_STORE_UNAVAILABLE' };
    try {
      const res = await fetch(`${base}/api/auth/config`);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const body = await res.json();
      assert.equal(body.code, 'AUTH_STORE_UNAVAILABLE');
    } finally {
      agentState.configStatus = 200;
      agentState.configBody = CONFIG_DTO;
    }
  });

  it('turns a malformed 200 config body into 503, not an empty method list', async () => {
    for (const malformed of [{ not: 'a dto' }, { mode: 'local', methods: {} }]) {
      agentState.configBody = malformed;
      try {
        const res = await fetch(`${base}/api/auth/config`);
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.code, 'AUTH_CONFIG_UNAVAILABLE');
      } finally {
        agentState.configBody = CONFIG_DTO;
      }
    }
  });

  it('rejects a cross-site login before it reaches the Agent', async () => {
    const before = agentState.calls.filter((c) => c.path === '/internal/auth/login').length;
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ username: 'alice', password: 'pw' }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'CSRF_ORIGIN_REJECTED');
    const after = agentState.calls.filter((c) => c.path === '/internal/auth/login').length;
    assert.equal(after, before, 'cross-site login must not reach the Agent');
  });

  it('accepts a same-origin login and never returns the token in JSON', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ username: 'alice', password: 'pw' }),
    });
    assert.equal(res.status, 200);
    const setCookies = res.headers.getSetCookie();
    assert.ok(
      setCookies.some((value) => value.startsWith('dsh_enterprise_session=')),
      'session Cookie must be set',
    );
    const body = await res.json();
    assert.deepEqual(body, { user: { id: 'u1', username: 'alice' } });
    assert.equal('token' in body, false);
  });

  it('accepts a no-Origin non-browser Bearer login', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer partner-token',
      },
      body: JSON.stringify({ username: 'svc', password: 'x' }),
    });
    assert.equal(res.status, 200);
  });

  it('rejects a cross-site PATCH profile without contacting the Agent', async () => {
    const before = agentState.calls.filter((c) => c.path === '/internal/auth/profile').length;
    const res = await fetch(`${base}/api/auth/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ display_name: 'x' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'CSRF_ORIGIN_REJECTED');
    const after = agentState.calls.filter((c) => c.path === '/internal/auth/profile').length;
    assert.equal(after, before);
  });

  it('reports confirmed revocation and clears the Cookie with no-store', async () => {
    agentState.logoutStatus = 200;
    agentState.logoutBody = { ok: true, revocation: 'confirmed' };
    const res = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { Origin: base, Cookie: 'dsh_enterprise_session=live-token' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, revocation: 'confirmed' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const setCookies = res.headers.getSetCookie();
    assert.ok(
      setCookies.some(
        (value) => value.startsWith('dsh_enterprise_session=') && value.includes('Max-Age=0'),
      ),
      'Cookie must be expired on success',
    );
    const call = logoutCalls().at(-1);
    assert.equal(call.headers.authorization, 'Bearer live-token');
  });

  it('treats missing credentials as idempotent not_required without an Agent call', async () => {
    const before = logoutCalls().length;
    const res = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, revocation: 'not_required' });
    assert.equal(logoutCalls().length, before);
  });

  it('keeps the legacy 409 and still clears the Cookie', async () => {
    agentState.logoutStatus = 409;
    agentState.logoutBody = {
      error: 'Legacy session cannot be revoked',
      code: 'LEGACY_SESSION_NOT_REVOCABLE',
    };
    const res = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { Origin: base, Cookie: 'dsh_enterprise_session=legacy-token' },
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'LEGACY_SESSION_NOT_REVOCABLE');
    assert.ok(
      res.headers.getSetCookie().some((value) => value.includes('Max-Age=0')),
      'Cookie must be cleared even on 409',
    );
  });

  it('maps a lost connection to 503 AUTH_REVOCATION_UNCONFIRMED and clears the Cookie', async () => {
    agentState.logoutDrop = true;
    try {
      const res = await fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: 'dsh_enterprise_session=live-token' },
      });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.code, 'AUTH_REVOCATION_UNCONFIRMED');
      assert.notEqual(body.ok, true);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.ok(
        res.headers.getSetCookie().some((value) => value.includes('Max-Age=0')),
        'Cookie must be cleared even when revocation is unconfirmed',
      );
    } finally {
      agentState.logoutDrop = false;
    }
  });

  it('maps an upstream 500 to 503 rather than a silent not_required', async () => {
    agentState.logoutStatus = 500;
    agentState.logoutBody = { error: 'database down' };
    try {
      const res = await fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: 'dsh_enterprise_session=live-token' },
      });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, 'AUTH_REVOCATION_UNCONFIRMED');
    } finally {
      agentState.logoutStatus = 200;
      agentState.logoutBody = { ok: true, revocation: 'confirmed' };
    }
  });

  it('does not report success when the Agent internal gate rejects the BFF token', async () => {
    agentState.logoutStatus = 401;
    agentState.logoutBody = { error: 'Invalid or missing internal token' };
    try {
      const res = await fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: 'dsh_enterprise_session=live-token' },
      });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.code, 'AUTH_REVOCATION_UNCONFIRMED');
      assert.notEqual(body.ok, true);
    } finally {
      agentState.logoutStatus = 200;
      agentState.logoutBody = { ok: true, revocation: 'confirmed' };
    }
  });

  // ── P1 dependency-transport classification ──
  // The Agent is a live dependency of me/profile/login. A stopped Agent or a
  // timeout must be a diagnosable 503 AUTH_DEPENDENCY_UNAVAILABLE, never the
  // generic 500 sendError produces for an unclassified fetch failure, and
  // never an auth failure (401). Config and logout keep their own classes.

  it('classifies a dropped Agent connection on GET /api/auth/me as 503 AUTH_DEPENDENCY_UNAVAILABLE', async () => {
    agentState.meDrop = true;
    try {
      const res = await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: 'dsh_enterprise_session=live-token' },
      });
      assert.equal(res.status, 503);
      assert.notEqual(res.status, 401);
      const body = await res.json();
      assert.equal(body.code, 'AUTH_DEPENDENCY_UNAVAILABLE');
      assert.notEqual(body.ok, true);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    } finally {
      agentState.meDrop = false;
    }
  });

  it('classifies an Agent timeout on GET /api/auth/me as 503 AUTH_DEPENDENCY_UNAVAILABLE within the bound', async () => {
    agentState.meHang = true;
    const started = Date.now();
    try {
      const res = await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: 'dsh_enterprise_session=live-token' },
      });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, 'AUTH_DEPENDENCY_UNAVAILABLE');
      // The BFF bound is 800ms; a missing timeout would hang well past this.
      assert.ok(Date.now() - started < 5_000, 'me must not hang on a silent Agent');
    } finally {
      agentState.meHang = false;
    }
  });

  it('classifies a dropped Agent connection on GET /api/auth/profile as 503 AUTH_DEPENDENCY_UNAVAILABLE', async () => {
    agentState.profileDrop = true;
    try {
      const res = await fetch(`${base}/api/auth/profile`, {
        headers: { Cookie: 'dsh_enterprise_session=live-token' },
      });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.code, 'AUTH_DEPENDENCY_UNAVAILABLE');
    } finally {
      agentState.profileDrop = false;
    }
  });

  it('classifies a dropped Agent connection on PATCH /api/auth/profile as 503 AUTH_DEPENDENCY_UNAVAILABLE', async () => {
    // Real-stack reproduction: stopping Agent made PATCH profile return a
    // generic HTTP 500 from the unclassified fetch failure.
    agentState.profileDrop = true;
    try {
      const res = await fetch(`${base}/api/auth/profile`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'dsh_enterprise_session=live-token',
        },
        body: JSON.stringify({ display_name: 'x' }),
      });
      assert.equal(res.status, 503);
      assert.notEqual(res.status, 401);
      const body = await res.json();
      assert.equal(body.code, 'AUTH_DEPENDENCY_UNAVAILABLE');
    } finally {
      agentState.profileDrop = false;
    }
  });

  it('classifies a dropped Agent connection on POST /api/auth/login as 503 with no session Cookie', async () => {
    agentState.loginDrop = true;
    try {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'pw' }),
      });
      assert.equal(res.status, 503);
      assert.notEqual(res.status, 401);
      const body = await res.json();
      assert.equal(body.code, 'AUTH_DEPENDENCY_UNAVAILABLE');
      assert.equal(
        res.headers.getSetCookie().some((value) => value.startsWith('dsh_enterprise_session=')),
        false,
        'a failed login must not establish a session',
      );
    } finally {
      agentState.loginDrop = false;
    }
  });

  it('classifies a malformed 200 me body as 503 AUTH_DEPENDENCY_UNAVAILABLE instead of 500', async () => {
    agentState.meInvalidJson = true;
    try {
      const res = await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: 'dsh_enterprise_session=live-token' },
      });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, 'AUTH_DEPENDENCY_UNAVAILABLE');
    } finally {
      agentState.meInvalidJson = false;
    }
  });

  it('classifies a malformed 200 profile body as 503 AUTH_DEPENDENCY_UNAVAILABLE instead of 500', async () => {
    agentState.profileInvalidJson = true;
    try {
      const res = await fetch(`${base}/api/auth/profile`, {
        headers: { Cookie: 'dsh_enterprise_session=live-token' },
      });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, 'AUTH_DEPENDENCY_UNAVAILABLE');
    } finally {
      agentState.profileInvalidJson = false;
    }
  });

  it('classifies a malformed 200 login body as 503 with no session Cookie', async () => {
    agentState.loginInvalidJson = true;
    try {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'pw' }),
      });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, 'AUTH_DEPENDENCY_UNAVAILABLE');
      assert.equal(
        res.headers.getSetCookie().some((value) => value.startsWith('dsh_enterprise_session=')),
        false,
      );
    } finally {
      agentState.loginInvalidJson = false;
    }
  });

  it('keeps the config route config semantics on a dropped Agent connection', async () => {
    agentState.configDrop = true;
    try {
      const res = await fetch(`${base}/api/auth/config`);
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, 'AUTH_CONFIG_UNAVAILABLE');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    } finally {
      agentState.configDrop = false;
    }
  });

  it('keeps the config route config semantics on a malformed 200 config body', async () => {
    agentState.configInvalidJson = true;
    try {
      const res = await fetch(`${base}/api/auth/config`);
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, 'AUTH_CONFIG_UNAVAILABLE');
    } finally {
      agentState.configInvalidJson = false;
    }
  });

  it('preserves an explicit upstream 401 on me instead of reclassifying it', async () => {
    agentState.meStatus = 401;
    agentState.meBody = { error: 'Invalid token', code: 'INVALID_TOKEN' };
    try {
      const res = await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: 'dsh_enterprise_session=live-token' },
      });
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.code, 'INVALID_TOKEN');
      assert.notEqual(body.code, 'AUTH_DEPENDENCY_UNAVAILABLE');
    } finally {
      agentState.meStatus = 200;
      agentState.meBody = PROFILE_DTO;
    }
  });

  it('preserves an upstream 503 AUTH_STORE_UNAVAILABLE instead of overwriting it', async () => {
    agentState.meStatus = 503;
    agentState.meBody = { error: 'auth store unavailable', code: 'AUTH_STORE_UNAVAILABLE' };
    try {
      const res = await fetch(`${base}/api/auth/me`, {
        headers: { Cookie: 'dsh_enterprise_session=live-token' },
      });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.code, 'AUTH_STORE_UNAVAILABLE');
      assert.notEqual(body.code, 'AUTH_DEPENDENCY_UNAVAILABLE');
    } finally {
      agentState.meStatus = 200;
      agentState.meBody = PROFILE_DTO;
    }
  });

  it('preserves an explicit upstream validation code on PATCH profile', async () => {
    agentState.profileStatus = 422;
    agentState.profileBody = { error: 'Not editable: role', code: 'PROFILE_FIELD_NOT_EDITABLE' };
    try {
      const res = await fetch(`${base}/api/auth/profile`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'dsh_enterprise_session=live-token',
        },
        body: JSON.stringify({ role: 'admin' }),
      });
      assert.equal(res.status, 422);
      assert.equal((await res.json()).code, 'PROFILE_FIELD_NOT_EDITABLE');
    } finally {
      agentState.profileStatus = 200;
      agentState.profileBody = PROFILE_DTO;
    }
  });
});
