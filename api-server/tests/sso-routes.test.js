/**
 * Production-entry integration for company SSO: real `dist/server.js`, a fake
 * Agent, and a small OIDC provider that really checks PKCE and signs ID tokens
 * with an RSA key (design docs/design/sso-oidc-dev.md §4.1).
 *
 * The provider is a protocol stand-in: it proves the BFF sends S256 PKCE,
 * state, nonce and the client secret correctly and that openid-client checks
 * the returned ID token. Interop with a real OIDC server is proven by the
 * Compose mock-oauth2-server run (see the evidence record), not here.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BFF_ROOT = path.resolve(__dirname, '..');
const CLIENT_ID = 'dsh-sandbox';
const CLIENT_SECRET = 'client-secret-for-tests';

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const idp = {
  issuer: '',
  keys: null,
  /** code → { challenge, nonce, redirectUri } recorded at authorize time. */
  codes: new Map(),
  tokenCalls: [],
  /** Optional override for the next ID token's nonce (mismatch test). */
  nonceOverride: null,
};

async function startIdp() {
  idp.keys = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(idp.keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://idp.invalid');
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      send(200, {
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
        jwks_uri: `${idp.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
      return;
    }
    if (url.pathname === '/jwks') {
      send(200, { keys: [jwk] });
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      idp.tokenCalls.push(Object.fromEntries(form));
      const grant = idp.codes.get(form.get('code'));
      const verifier = form.get('code_verifier') || '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (
        !grant ||
        form.get('client_id') !== CLIENT_ID ||
        form.get('client_secret') !== CLIENT_SECRET ||
        form.get('redirect_uri') !== grant.redirectUri ||
        challenge !== grant.challenge
      ) {
        send(400, { error: 'invalid_grant' });
        return;
      }
      idp.codes.delete(form.get('code'));
      const idToken = await new SignJWT({ nonce: idp.nonceOverride ?? grant.nonce, employee_id: 'E1001' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(idp.issuer)
        .setAudience(CLIENT_ID)
        .setSubject('subject-1001')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(idp.keys.privateKey);
      send(200, { access_token: 'company-access-token', token_type: 'Bearer', expires_in: 300, id_token: idToken });
      return;
    }
    send(404, { error: 'not_found' });
  });
  await listen(server);
  idp.issuer = `http://127.0.0.1:${server.address().port}`;
  return server;
}

/** Simulate the user authorizing at the IdP: record the grant, mint a code. */
function authorize(location) {
  const url = new URL(location);
  const code = `code-${idp.codes.size + 1}-${Math.random().toString(36).slice(2)}`;
  idp.codes.set(code, {
    challenge: url.searchParams.get('code_challenge'),
    nonce: url.searchParams.get('nonce'),
    redirectUri: url.searchParams.get('redirect_uri'),
  });
  return { code, state: url.searchParams.get('state') };
}

const agentState = {
  exchangeStatus: 200,
  exchangeBody: { token: 'platform-session-jwt', user: { id: 'sso_1', username: 'E1001' } },
  configBody: {
    mode: 'sso',
    methods: {
      local: { enabled: true, registration_enabled: false },
      sso: { enabled: true, available: true, label: '公司 SSO' },
    },
    profile_policy: { editable_fields: ['display_name'] },
  },
  calls: [],
};

async function startFakeAgent() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://agent.invalid');
    const body = await readBody(req);
    agentState.calls.push({ path: url.pathname, headers: req.headers, body });
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/ready') return send(200, { status: 'ready' });
    if (url.pathname === '/internal/auth/config') return send(200, agentState.configBody);
    if (url.pathname === '/internal/auth/oidc/exchange') {
      return send(agentState.exchangeStatus, agentState.exchangeBody);
    }
    return send(404, { error: 'not found', code: 'NOT_FOUND' });
  });
  return listen(server);
}

async function waitForLive(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/live`);
      if (res.status === 200) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error('BFF did not start');
}

function setCookies(res) {
  return res.headers.getSetCookie();
}

function cookiePair(header) {
  return header.split(';')[0];
}

function exchangeCalls() {
  return agentState.calls.filter((call) => call.path === '/internal/auth/oidc/exchange');
}

async function spawnBff(env) {
  const port = 23000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['dist/server.js'], {
    cwd: BFF_ROOT,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForLive(port);
  return { child, base: `http://127.0.0.1:${port}` };
}

async function stop(child) {
  if (!child) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 3000))]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

describe('company SSO production routes', () => {
  let provider;
  let agent;
  let bff;
  let partial;
  let base;

  before(async () => {
    assert.ok(fs.existsSync(path.join(BFF_ROOT, 'dist/server.js')), 'run npm run build first');
    provider = await startIdp();
    agent = await startFakeAgent();
    const common = {
      AGENT_BASE_URL: `http://127.0.0.1:${agent.address().port}`,
      AGENT_INTERNAL_TOKEN: 'test-internal-token',
      AUTH_ENABLED: 'true',
      SSO_ENABLED: 'true',
      SSO_ISSUER: idp.issuer,
      SSO_CLIENT_ID: CLIENT_ID,
      SSO_ALLOW_INSECURE_HTTP: 'true',
      SSO_REQUEST_TIMEOUT_MS: '2000',
    };
    bff = await spawnBff({
      ...common,
      SSO_CLIENT_SECRET: CLIENT_SECRET,
      SSO_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/sso/callback',
      SSO_TRANSACTION_SECRET: 't'.repeat(40),
    });
    base = bff.base;
    // Same Agent answer, but the BFF lacks its client secret: SSO must be unavailable.
    partial = await spawnBff({ ...common, SSO_CLIENT_SECRET: '', SSO_REDIRECT_URI: '', SSO_TRANSACTION_SECRET: '' });
  });

  after(async () => {
    await stop(bff?.child);
    await stop(partial?.child);
    if (agent) await new Promise((resolve) => agent.close(resolve));
    if (provider) await new Promise((resolve) => provider.close(resolve));
  });

  async function startLogin(returnTo = '/chat?x=1') {
    const res = await fetch(`${base}/api/auth/sso/login?return_to=${encodeURIComponent(returnTo)}`, {
      redirect: 'manual',
    });
    return res;
  }

  async function callback(query, cookie) {
    return fetch(`${base}/api/auth/sso/callback?${query}`, {
      redirect: 'manual',
      headers: cookie ? { cookie } : {},
    });
  }

  it('only reports SSO available when the BFF also holds a complete client configuration', async () => {
    const full = await (await fetch(`${base}/api/auth/config`)).json();
    assert.equal(full.methods.sso.available, true);
    const missing = await (await fetch(`${partial.base}/api/auth/config`)).json();
    assert.equal(missing.methods.sso.enabled, true);
    assert.equal(missing.methods.sso.available, false);
    const refused = await fetch(`${partial.base}/api/auth/sso/login`, { redirect: 'manual' });
    assert.equal(refused.status, 303);
    assert.equal(refused.headers.get('location'), '/?sso_error=SSO_CONFIG_UNAVAILABLE');
  });

  it('starts login with S256 PKCE, state and nonce, and an encrypted HttpOnly transaction cookie', async () => {
    const res = await startLogin();
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const location = new URL(res.headers.get('location'));
    assert.equal(`${location.origin}${location.pathname}`, `${idp.issuer}/authorize`);
    assert.equal(location.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(location.searchParams.get('code_challenge'));
    assert.ok(location.searchParams.get('state'));
    assert.ok(location.searchParams.get('nonce'));
    assert.equal(location.searchParams.get('redirect_uri'), 'http://127.0.0.1:3000/api/auth/sso/callback');
    assert.equal(location.searchParams.has('client_secret'), false);

    const [txn] = setCookies(res);
    assert.match(txn, /^dsh_sso_[A-Za-z0-9_-]{16}=/);
    assert.match(txn, /Path=\/api\/auth\/sso/);
    assert.match(txn, /HttpOnly/);
    assert.match(txn, /SameSite=Lax/);
    // The browser holds ciphertext: neither the nonce nor the return path is readable.
    assert.equal(txn.includes(location.searchParams.get('nonce')), false);
    assert.equal(txn.includes('/chat'), false);
  });

  it('completes the callback: PKCE-verified code exchange, Agent verification, session cookie, safe redirect', async () => {
    agentState.calls = [];
    const started = await startLogin('/chat?x=1');
    const txnCookie = cookiePair(setCookies(started)[0]);
    const { code, state } = authorize(started.headers.get('location'));
    const authorizeNonce = new URL(started.headers.get('location')).searchParams.get('nonce');

    const res = await callback(`code=${code}&state=${state}`, txnCookie);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/chat?x=1');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const cookies = setCookies(res);
    assert.ok(cookies.some((c) => c.startsWith('dsh_enterprise_session=platform-session-jwt')));
    assert.ok(cookies.some((c) => c.startsWith(`${txnCookie.split('=')[0]}=;`) && /Max-Age=0/.test(c)));

    const [exchange] = exchangeCalls();
    assert.ok(exchange, 'Agent must verify the ID token itself');
    assert.equal(exchange.headers['x-internal-token'], 'test-internal-token');
    const sent = JSON.parse(exchange.body);
    assert.ok(sent.id_token.split('.').length === 3);
    assert.equal(sent.nonce, authorizeNonce);
    // The company access token never goes to the Agent or the browser.
    assert.equal(exchange.body.includes('company-access-token'), false);
    assert.equal(cookies.join(';').includes('company-access-token'), false);
  });

  it('rejects a callback without, with a tampered, or with another login\'s transaction cookie', async () => {
    agentState.calls = [];
    const first = await startLogin();
    const firstCookie = cookiePair(setCookies(first)[0]);
    const second = await startLogin();
    const { code, state } = authorize(second.headers.get('location'));

    const none = await callback(`code=${code}&state=${state}`, null);
    assert.equal(none.headers.get('location'), '/?sso_error=SSO_STATE_INVALID');

    const [name, value] = firstCookie.split('=');
    const tampered = `${cookiePair(setCookies(second)[0]).split('=')[0]}=${value.slice(0, -4)}AAAA`;
    assert.equal(
      (await callback(`code=${code}&state=${state}`, tampered)).headers.get('location'),
      '/?sso_error=SSO_STATE_INVALID',
    );
    // A valid transaction for a different state cannot be replayed under this state.
    const swapped = `${cookiePair(setCookies(second)[0]).split('=')[0]}=${value}`;
    assert.equal(
      (await callback(`code=${code}&state=${state}`, swapped)).headers.get('location'),
      '/?sso_error=SSO_STATE_INVALID',
    );
    assert.ok(name.startsWith('dsh_sso_'));
    assert.equal(exchangeCalls().length, 0);
    assert.equal(idp.tokenCalls.filter((call) => call.code === code).length, 0);
  });

  it('maps an IdP refusal and an ID token with the wrong nonce to stable codes without calling the Agent', async () => {
    agentState.calls = [];
    const denied = await startLogin();
    const deniedState = new URL(denied.headers.get('location')).searchParams.get('state');
    const refusal = await callback(
      `error=access_denied&error_description=${encodeURIComponent('<b>nope</b>')}&state=${deniedState}`,
      cookiePair(setCookies(denied)[0]),
    );
    assert.equal(refusal.headers.get('location'), '/?sso_error=SSO_ACCESS_DENIED');

    const started = await startLogin();
    const { code, state } = authorize(started.headers.get('location'));
    idp.nonceOverride = 'attacker-nonce';
    try {
      const res = await callback(`code=${code}&state=${state}`, cookiePair(setCookies(started)[0]));
      assert.equal(res.headers.get('location'), '/?sso_error=SSO_CALLBACK_INVALID');
    } finally {
      idp.nonceOverride = null;
    }
    assert.equal(exchangeCalls().length, 0);
  });

  it('keeps the Agent\'s stable refusal code and issues no session', async () => {
    agentState.exchangeStatus = 409;
    agentState.exchangeBody = { error: 'conflict', code: 'IDENTITY_BINDING_CONFLICT' };
    try {
      const started = await startLogin();
      const { code, state } = authorize(started.headers.get('location'));
      const res = await callback(`code=${code}&state=${state}`, cookiePair(setCookies(started)[0]));
      assert.equal(res.headers.get('location'), '/?sso_error=IDENTITY_BINDING_CONFLICT');
      assert.equal(setCookies(res).some((c) => c.startsWith('dsh_enterprise_session=')), false);
    } finally {
      agentState.exchangeStatus = 200;
      agentState.exchangeBody = { token: 'platform-session-jwt', user: { id: 'sso_1' } };
    }
  });

  it('never redirects off-site after login', async () => {
    for (const evil of ['//evil.example/x', '/\\evil.example', 'https://evil.example', '/api/auth/sso/login']) {
      const started = await startLogin(evil);
      const { code, state } = authorize(started.headers.get('location'));
      const res = await callback(`code=${code}&state=${state}`, cookiePair(setCookies(started)[0]));
      assert.equal(res.headers.get('location'), '/', evil);
    }
  });
});
