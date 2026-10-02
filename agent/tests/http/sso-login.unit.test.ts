/**
 * 公司 SSO（OIDC）兑换的单测（design docs/design/sso-oidc-dev.md）。
 *
 * 验签部分起一台**真的** HTTP 服务端提供 discovery 与 JWKS，token 用 jose 生成的
 * RSA 钥签发，所以 issuer / JWKS 拉取 / 签名校验走的是生产代码路径。身份账本用内存
 * 替身；真库唯一约束与迁移由 mysql 集成测试与 Compose 真实链路证明。
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import {
  BrowserAuthError,
  BrowserAuthService,
  hashPassword,
} from '../../src/application/browser-auth-service.js';
import { OidcIdTokenVerifier } from '../../src/application/oidc-id-token-verifier.js';
import { resolveSsoConfig, type SsoConfig } from '../../src/application/sso-config.js';
import { SSO_PASSWORD_PLACEHOLDER, SsoLoginService } from '../../src/application/sso-login-service.js';
import { memoryBrowserSessions, memoryIdentity } from '../support/memory-browser-auth.js';

const CLIENT_ID = 'dsh-sandbox';
const NONCE = 'nonce-from-consumed-transaction';

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: Keys;
let otherKeys: Keys;
let server: http.Server;
let issuer = '';
/** 每个用例可以改 discovery 的回答（issuer 不匹配、JWKS 换源）。 */
let discoveryOverride: Record<string, unknown> | null = null;

before(async () => {
  keys = await generateKeyPair('RS256');
  otherKeys = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/idp/.well-known/openid-configuration') {
      res.end(JSON.stringify(discoveryOverride ?? { issuer, jwks_uri: `${issuer}/jwks` }));
    } else if (req.url === '/idp/jwks') {
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/idp`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

function config(overrides: Record<string, string> = {}): SsoConfig {
  return resolveSsoConfig({
    SSO_ENABLED: 'true',
    SSO_ISSUER: issuer,
    SSO_CLIENT_ID: CLIENT_ID,
    SSO_ALLOW_INSECURE_HTTP: 'true',
    SSO_REQUEST_TIMEOUT_MS: '2000',
    SSO_ORG_ID: 'org_company',
    ...overrides,
  });
}

async function idToken(
  claims: Record<string, unknown> = {},
  options: { key?: Keys; kid?: string; iss?: string; aud?: string | string[]; exp?: string | number } = {},
) {
  return new SignJWT({ nonce: NONCE, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'k1' })
    .setIssuer(options.iss ?? issuer)
    .setAudience(options.aud ?? CLIENT_ID)
    .setSubject(String(claims.sub ?? 'subject-1001'))
    .setIssuedAt()
    .setExpirationTime(options.exp ?? '5m')
    .sign((options.key ?? keys).privateKey);
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BrowserAuthError, String(error));
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

describe('OidcIdTokenVerifier', () => {
  it('accepts a token signed by the issuer JWKS with the expected nonce and audience', async () => {
    discoveryOverride = null;
    const verified = await new OidcIdTokenVerifier(config()).verify(
      await idToken({ employee_id: 'E1001' }),
      NONCE,
    );
    assert.equal(verified.issuer, issuer);
    assert.equal(verified.subject, 'subject-1001');
    assert.equal(verified.claims.employee_id, 'E1001');
  });

  it('rejects a wrong nonce, audience, issuer, signing key, or an expired token as 401', async () => {
    discoveryOverride = null;
    const verifier = new OidcIdTokenVerifier(config());
    const cases: Array<[string, string]> = [
      [await idToken(), 'another-nonce'],
      [await idToken({}, { aud: 'someone-else' }), NONCE],
      [await idToken({}, { iss: 'https://evil.example' }), NONCE],
      [await idToken({}, { key: otherKeys }), NONCE],
      [await idToken({}, { exp: Math.floor(Date.now() / 1000) - 3600 }), NONCE],
      [await idToken({}, { aud: [CLIENT_ID, 'other'] }), NONCE],
    ];
    for (const [token, nonce] of cases) {
      await rejectsWith(verifier.verify(token, nonce), 401, 'SSO_TOKEN_INVALID');
    }
  });

  it('rejects an HS256 token signed with a shared secret', async () => {
    discoveryOverride = null;
    const forged = await new SignJWT({ nonce: NONCE })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer)
      .setAudience(CLIENT_ID)
      .setSubject('subject-1001')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('client-secret-used-as-hmac-key-000000'));
    await rejectsWith(new OidcIdTokenVerifier(config()).verify(forged, NONCE), 401, 'SSO_TOKEN_INVALID');
  });

  it('fails closed when discovery names a different issuer or a JWKS on another origin', async () => {
    discoveryOverride = { issuer: 'https://other-idp.example', jwks_uri: `${issuer}/jwks` };
    await rejectsWith(new OidcIdTokenVerifier(config()).verify(await idToken(), NONCE), 503, 'SSO_CONFIG_UNAVAILABLE');
    discoveryOverride = { issuer, jwks_uri: 'http://169.254.169.254/jwks' };
    await rejectsWith(new OidcIdTokenVerifier(config()).verify(await idToken(), NONCE), 503, 'SSO_CONFIG_UNAVAILABLE');
    discoveryOverride = null;
  });

  it('reports an unreachable provider as 503, not as an invalid token', async () => {
    const dead = config({ SSO_ISSUER: 'http://127.0.0.1:9/idp' });
    await rejectsWith(new OidcIdTokenVerifier(dead).verify(await idToken(), NONCE), 503, 'SSO_UPSTREAM_UNAVAILABLE');
  });

  it('is unavailable when SSO is enabled without a complete configuration', async () => {
    const partial = config({ SSO_CLIENT_ID: '' });
    assert.equal(partial.enabled, true);
    assert.equal(partial.available, false);
    await rejectsWith(new OidcIdTokenVerifier(partial).verify(await idToken(), NONCE), 503, 'SSO_CONFIG_UNAVAILABLE');
    // https 是默认要求：没有显式开发开关时 http issuer 不可用。
    assert.equal(config({ SSO_ALLOW_INSECURE_HTTP: '' }).available, false);
  });
});

/** 带用户名唯一约束的凭据替身（SSO 并发/冲突路径依赖它）。 */
function memoryCredentials() {
  const rows = new Map<string, any>();
  return {
    rows,
    async create(input: any) {
      const key = input.username.toLowerCase();
      if (rows.has(key)) throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
      const row = {
        id: input.externalUserId,
        username: input.username,
        passwordHash: input.passwordHash,
        email: input.email,
        displayName: input.displayName || input.username,
        role: input.role,
        organizationId: input.externalOrgId,
        isActive: true,
      };
      rows.set(key, row);
      return { ...row };
    },
    async getByUsername(username: string) {
      const row = rows.get(username.toLowerCase());
      return row ? { ...row } : null;
    },
    async getByExternalUserId(id: string) {
      const row = [...rows.values()].find((candidate) => candidate.id === id);
      return row ? { ...row } : null;
    },
    async setRole(id: string, role: string) {
      const row = [...rows.values()].find((candidate) => candidate.id === id);
      if (row) row.role = role;
    },
    async touchLogin() {},
  };
}

function memorySsoIdentities() {
  const rows = new Map<string, any>();
  return {
    rows,
    failNextCreate: false,
    async getBySubject(iss: string, sub: string) {
      const row = rows.get(`${iss}\n${sub}`);
      return row ? { ...row } : null;
    },
    async create(input: any) {
      if (this.failNextCreate) {
        this.failNextCreate = false;
        throw new Error('connection lost');
      }
      const key = `${input.issuer}\n${input.subject}`;
      const taken = [...rows.values()].some((row) => row.externalUserId === input.externalUserId);
      if (rows.has(key) || taken) throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
      rows.set(key, { ...input, createdAt: null, lastLoginAt: null });
      return { ...rows.get(key) };
    },
    async touchLogin(identityId: string, employeeId: string | null) {
      for (const row of rows.values()) if (row.identityId === identityId) row.employeeId = employeeId;
    },
  };
}

/** 记录 `ensureDeploymentGrant` 调用：SSO 会话绝不能走用户名名单引导。 */
function memoryMemberRoles(pinned: string[] = []) {
  const grants = new Map<string, Set<string>>();
  const grantCalls: string[] = [];
  return {
    grants,
    grantCalls,
    async listRolesForMember(orgId: string, userId: string) {
      return [...(grants.get(`${orgId}/${userId}`) ?? [])];
    },
    async ensureDeploymentGrant({ orgId, userId, username }: any) {
      grantCalls.push(String(username));
      if (!pinned.includes(String(username).toLowerCase())) return;
      const set = grants.get(`${orgId}/${userId}`) ?? new Set<string>();
      set.add('admin');
      grants.set(`${orgId}/${userId}`, set);
    },
  };
}

function makeStack(options: { pinned?: string[]; sso?: SsoConfig | null } = {}) {
  let counter = 0;
  // 合法 ULID：活跃准入会校验内部 ID。
  const generateId = () => `01M1G3NJD${String((counter += 1)).padStart(17, '0')}`;
  const credentials = memoryCredentials();
  const identity = memoryIdentity();
  const sessions = memoryBrowserSessions();
  const memberRoles = memoryMemberRoles(options.pinned ?? ['admin']);
  const identities = memorySsoIdentities();
  const sso = options.sso === undefined ? config() : options.sso;
  const auth = new BrowserAuthService({
    credentials,
    organizations: identity.organizations,
    externalRefs: identity.externalRefs,
    memberRoles,
    sessions,
    generateId,
    secret: 'a'.repeat(32),
    sso,
    localLoginAllowlist: options.pinned ?? ['admin'],
  });
  const login = sso
    ? new SsoLoginService({
        config: sso,
        verifier: new OidcIdTokenVerifier(sso),
        identities,
        credentials,
        users: identity.organizations,
        auth,
        reservedUsernames: options.pinned ?? ['admin'],
        generateId,
      })
    : null;
  auth.ssoLogin = login;
  return { auth, login, credentials, identities, memberRoles, sessions, identity };
}

describe('SSO login exchange', () => {
  it('provisions an employee on first login and reuses the same account afterwards', async () => {
    discoveryOverride = null;
    const { auth, credentials, identities, memberRoles } = makeStack();
    const first: any = await auth.ssoExchange({
      id_token: await idToken({ employee_id: 'E1001', name: '张三', email: 'zhangsan@example.com' }),
      nonce: NONCE,
    });
    assert.equal(first.user.username, 'E1001');
    assert.equal(first.user.display_name, '张三');
    assert.equal(first.user.login_method, 'sso');
    assert.equal(first.user.identity_provider, issuer);
    assert.equal(first.user.organization_id, 'org_company');
    assert.deepEqual(first.user.roles, []);
    assert.equal(credentials.rows.get('e1001').passwordHash, SSO_PASSWORD_PLACEHOLDER);
    assert.equal(identities.rows.size, 1);

    const second: any = await auth.ssoExchange({ id_token: await idToken({ employee_id: 'E1001' }), nonce: NONCE });
    assert.equal(second.user.id, first.user.id);
    assert.equal(credentials.rows.size, 1);

    const me: any = await auth.me(`Bearer ${second.token}`);
    assert.equal(me.login_method, 'sso');
    // SSO 会话（签发与 me）都不走按用户名的部署名单引导。
    assert.deepEqual(memberRoles.grantCalls, []);
  });

  it('binds on (iss, sub): a changed employee number does not create a second account', async () => {
    discoveryOverride = null;
    const { auth, credentials, identities } = makeStack();
    const first: any = await auth.ssoExchange({ id_token: await idToken({ employee_id: 'E1001' }), nonce: NONCE });
    const again: any = await auth.ssoExchange({ id_token: await idToken({ employee_id: 'E2002' }), nonce: NONCE });
    assert.equal(again.user.id, first.user.id);
    assert.equal(credentials.rows.size, 1);
    assert.equal([...identities.rows.values()][0].employeeId, 'E2002');
  });

  it('derives a stable username when the employee claim is missing, without inventing one', async () => {
    discoveryOverride = null;
    const { auth, identities } = makeStack();
    const result: any = await auth.ssoExchange({ id_token: await idToken({ sub: 'no-employee' }), nonce: NONCE });
    assert.match(result.user.username, /^sso_[0-9a-f]{16}$/);
    assert.equal([...identities.rows.values()][0].employeeId, null);
  });

  it('never grants admin to an SSO user whose employee number equals a deployment admin name', async () => {
    discoveryOverride = null;
    const { auth, memberRoles } = makeStack({ pinned: ['admin'] });
    await rejectsWith(
      auth.ssoExchange({ id_token: await idToken({ employee_id: 'Admin' }), nonce: NONCE }),
      409,
      'IDENTITY_BINDING_CONFLICT',
    );
    assert.deepEqual(memberRoles.grantCalls, []);
  });

  it('does not merge into an existing local password account with the same username', async () => {
    discoveryOverride = null;
    const { auth, credentials } = makeStack();
    await credentials.create({
      username: 'E1001',
      passwordHash: await hashPassword('secret-1'),
      externalUserId: 'user_local',
      externalOrgId: 'org_bootstrap',
      role: 'user',
    });
    await rejectsWith(
      auth.ssoExchange({ id_token: await idToken({ employee_id: 'E1001' }), nonce: NONCE }),
      409,
      'IDENTITY_BINDING_CONFLICT',
    );
  });

  it('recovers when the identity write failed after the credential was created', async () => {
    discoveryOverride = null;
    const { auth, credentials, identities } = makeStack();
    identities.failNextCreate = true;
    await rejectsWith(
      auth.ssoExchange({ id_token: await idToken({ employee_id: 'E1001' }), nonce: NONCE }),
      503,
      'AUTH_STORE_UNAVAILABLE',
    );
    const retried: any = await auth.ssoExchange({ id_token: await idToken({ employee_id: 'E1001' }), nonce: NONCE });
    assert.equal(retried.user.username, 'E1001');
    assert.equal(credentials.rows.size, 1);
    assert.equal(identities.rows.size, 1);
  });

  it('refuses a disabled employee with 404 and an invalid token with 401', async () => {
    discoveryOverride = null;
    const { auth, credentials } = makeStack();
    await auth.ssoExchange({ id_token: await idToken({ employee_id: 'E1001' }), nonce: NONCE });
    credentials.rows.get('e1001').isActive = false;
    await rejectsWith(
      auth.ssoExchange({ id_token: await idToken({ employee_id: 'E1001' }), nonce: NONCE }),
      404,
      'SSO_ACCESS_UNAVAILABLE',
    );
    await rejectsWith(auth.ssoExchange({ id_token: 'not-a-jwt', nonce: NONCE }), 401, 'SSO_TOKEN_INVALID');
  });

  it('the SSO account can never be used with a local password', async () => {
    // 即使把这个用户名放进本地名单，占位哈希也不可能通过 PBKDF2 校验。
    const { auth } = makeStack({ pinned: ['e1001'] });
    await auth.ssoExchange({ id_token: await idToken({ employee_id: 'E9001' }), nonce: NONCE });
    const { auth: open, credentials } = makeStack({ pinned: ['e9001'] });
    await credentials.create({
      username: 'E9001',
      passwordHash: SSO_PASSWORD_PLACEHOLDER,
      externalUserId: 'sso_x',
      externalOrgId: 'org_company',
      role: 'user',
    });
    await rejectsWith(open.login({ username: 'E9001', password: SSO_PASSWORD_PLACEHOLDER }), 401, 'INVALID_CREDENTIALS');
  });
});

describe('BrowserAuthService in SSO mode', () => {
  it('projects mode sso, closes registration and reports SSO availability', () => {
    const { auth } = makeStack();
    const dto: any = auth.authConfig();
    assert.equal(dto.mode, 'sso');
    assert.deepEqual(dto.methods.local, { enabled: true, registration_enabled: false });
    assert.equal(dto.methods.sso.enabled, true);
    assert.equal(dto.methods.sso.available, true);

    const partial: any = makeStack({ sso: config({ SSO_CLIENT_ID: '' }) }).auth.authConfig();
    assert.equal(partial.methods.sso.enabled, true);
    assert.equal(partial.methods.sso.available, false);

    const local: any = makeStack({ sso: null }).auth.authConfig();
    assert.equal(local.mode, 'local');
    assert.equal(local.methods.sso.enabled, false);
  });

  it('allows local password login only for the deployment admin list', async () => {
    const { auth, credentials } = makeStack({ pinned: ['admin'] });
    for (const username of ['admin', 'alice']) {
      await credentials.create({
        username,
        passwordHash: await hashPassword('secret-1'),
        externalUserId: `user_${username}`,
        externalOrgId: 'org_bootstrap',
        role: 'user',
      });
    }
    await rejectsWith(auth.login({ username: 'alice', password: 'secret-1' }), 403, 'LOCAL_LOGIN_RESTRICTED');
    const admin: any = await auth.login({ username: 'ADMIN', password: 'secret-1' });
    assert.deepEqual(admin.user.roles, ['admin']);
    assert.equal(admin.user.login_method, 'local');
  });

  it('refuses public registration while SSO is on', async () => {
    const { auth } = makeStack();
    await rejectsWith(auth.register({ username: 'newbie', password: 'secret-1' }), 403, 'REGISTRATION_DISABLED');
  });

  it('keeps the exchange closed when SSO is off', async () => {
    const { auth } = makeStack({ sso: null });
    await rejectsWith(auth.ssoExchange({ id_token: 'x', nonce: NONCE }), 503, 'SSO_CONFIG_UNAVAILABLE');
  });
});

describe('SSO department reservation claim', () => {
  it('writes department on first login when claim is configured and present', async () => {
    discoveryOverride = null;
    const sso = config({ SSO_DEPARTMENT_CLAIM: 'department' });
    const { auth, identity } = makeStack({ sso });
    const first: any = await auth.ssoExchange({
      id_token: await idToken({ employee_id: 'E1001', department: '工程部' }),
      nonce: NONCE,
    });
    const user = await identity.organizations.getUserByExternalSubject(`bff:${first.user.id}`);
    assert.equal(user?.department, '工程部');
  });

  it('updates department on subsequent login when claim changes', async () => {
    discoveryOverride = null;
    const sso = config({ SSO_DEPARTMENT_CLAIM: 'department' });
    const { auth, identity } = makeStack({ sso });
    const first: any = await auth.ssoExchange({
      id_token: await idToken({ employee_id: 'E1001', department: '工程部' }),
      nonce: NONCE,
    });
    const second: any = await auth.ssoExchange({
      id_token: await idToken({ employee_id: 'E1001', department: '产品部' }),
      nonce: NONCE,
    });
    assert.equal(second.user.id, first.user.id);
    const user = await identity.organizations.getUserByExternalSubject(`bff:${first.user.id}`);
    assert.equal(user?.department, '产品部');
  });

  it('keeps previous department unchanged when claim is missing, empty, or non-string', async () => {
    discoveryOverride = null;
    const sso = config({ SSO_DEPARTMENT_CLAIM: 'department' });
    const { auth, identity } = makeStack({ sso });
    const first: any = await auth.ssoExchange({
      id_token: await idToken({ employee_id: 'E1001', department: '工程部' }),
      nonce: NONCE,
    });

    // 缺失 claim：保持原值
    await auth.ssoExchange({
      id_token: await idToken({ employee_id: 'E1001' }),
      nonce: NONCE,
    });
    let user = await identity.organizations.getUserByExternalSubject(`bff:${first.user.id}`);
    assert.equal(user?.department, '工程部');

    // 空字符串 / 纯空白：保持原值
    await auth.ssoExchange({
      id_token: await idToken({ employee_id: 'E1001', department: '   ' }),
      nonce: NONCE,
    });
    user = await identity.organizations.getUserByExternalSubject(`bff:${first.user.id}`);
    assert.equal(user?.department, '工程部');

    // 非字符串类型：保持原值
    await auth.ssoExchange({
      id_token: await idToken({ employee_id: 'E1001', department: 12345 }),
      nonce: NONCE,
    });
    user = await identity.organizations.getUserByExternalSubject(`bff:${first.user.id}`);
    assert.equal(user?.department, '工程部');
  });

  it('a failed department write does not fail the login (display-only field)', async () => {
    discoveryOverride = null;
    const sso = config({ SSO_DEPARTMENT_CLAIM: 'department' });
    const { auth, identity } = makeStack({ sso });
    identity.organizations.setDepartmentByExternalSubject = async () => {
      throw new Error('db down');
    };
    const login: any = await auth.ssoExchange({
      id_token: await idToken({ employee_id: 'E1001', department: '工程部' }),
      nonce: NONCE,
    });
    assert.ok(login.user.id, 'session is still established');
  });

  it('does not write department when claim is not configured', async () => {
    discoveryOverride = null;
    const sso = config(); // SSO_DEPARTMENT_CLAIM 未配置（空）
    const { auth, identity } = makeStack({ sso });
    const first: any = await auth.ssoExchange({
      id_token: await idToken({ employee_id: 'E1001', department: '工程部' }),
      nonce: NONCE,
    });
    const user = await identity.organizations.getUserByExternalSubject(`bff:${first.user.id}`);
    assert.equal(user?.department, null);
  });

  it('trims whitespace and enforces 255 character limit', async () => {
    discoveryOverride = null;
    const sso = config({ SSO_DEPARTMENT_CLAIM: 'dept' });
    const { auth, identity } = makeStack({ sso });
    const first: any = await auth.ssoExchange({
      id_token: await idToken({ employee_id: 'E1001', dept: '  基础架构组  ' }),
      nonce: NONCE,
    });
    let user = await identity.organizations.getUserByExternalSubject(`bff:${first.user.id}`);
    assert.equal(user?.department, '基础架构组');

    // 超过 255 字符忽略，保持原值
    const tooLong = 'a'.repeat(256);
    await auth.ssoExchange({
      id_token: await idToken({ employee_id: 'E1001', dept: tooLong }),
      nonce: NONCE,
    });
    user = await identity.organizations.getUserByExternalSubject(`bff:${first.user.id}`);
    assert.equal(user?.department, '基础架构组');
  });
});


describe('SSO first login records last login', () => {
  it('touches the credential on JIT provisioning (member page shows first login)', async () => {
    discoveryOverride = null;
    const stack = makeStack();
    const touched: string[] = [];
    const orig = stack.credentials.touchLogin.bind(stack.credentials);
    stack.credentials.touchLogin = async (id: string) => {
      touched.push(id);
      return orig(id);
    };
    const first: any = await stack.auth.ssoExchange({
      id_token: await idToken({ employee_id: 'E1001' }),
      nonce: NONCE,
    });
    assert.deepEqual(touched, [first.user.id]);
  });

  it('a touchLogin failure during provisioning surfaces as store unavailable (same as the existing path)', async () => {
    discoveryOverride = null;
    const stack = makeStack();
    stack.credentials.touchLogin = async () => {
      throw new Error('db down');
    };
    await rejectsWith(
      stack.auth.ssoExchange({ id_token: await idToken({ employee_id: 'E1001' }), nonce: NONCE }),
      503,
      'AUTH_STORE_UNAVAILABLE',
    );
  });
});
