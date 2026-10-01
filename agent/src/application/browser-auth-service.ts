import { pbkdf2 as pbkdf2Callback, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { formatUserExternalSubject } from '../infrastructure/mysql/repositories/organization-repository.js';
import { ulid } from '../domain/shared/ulid.js';
import { parseRoleSet, primaryRole, type KnownRole } from '../domain/identity/roles.js';
import {
  ActivePrincipalService,
  type ActivePrincipalIdentity,
} from './active-principal-service.js';
import {
  BrowserAuthError,
  browserAuthStoreUnavailable,
  invalidBrowserToken,
} from './browser-auth-errors.js';
import {
  BrowserSessionService,
  type BrowserSessionRecord,
  type BrowserSessionStore,
  type IssuedBrowserSession,
} from './browser-session-service.js';
import { BrowserSessionTokens } from './browser-session-tokens.js';

// 既有调用方（HTTP 路由与测试）从这里取错误类；实现在 browser-auth-errors.ts。
export { BrowserAuthError } from './browser-auth-errors.js';

const pbkdf2 = promisify(pbkdf2Callback);
/** Pragmatic shape check; deliverability is the mail gateway's business. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME = /^[A-Za-z0-9_./@+-]{2,64}$/;
const BOOTSTRAP_ORG_ID = 'org_bootstrap';
const PASSWORD_ITERATIONS = 120_000;

type Credential = {
  id: string;
  username: string;
  passwordHash: string;
  email: string | null;
  displayName: string | null;
  role: string;
  organizationId: string;
  isActive: boolean;
  createdAt?: string | null;
  lastLoginAt?: string | null;
};

/**
 * Provisioning 只用得到这几个方法。写成显式端口而不是 `any`：这是把浏览器
 * 身份翻译成正式 org/user 的那一跳，签名写错在 `any` 下不会有任何提示。
 */
type OrganizationStore = {
  createOrganization(input: {
    orgId: string;
    name: string;
    status: string;
  }): Promise<unknown>;
  getUserByExternalSubject(
    externalSubject: string,
  ): Promise<{ userId: string } | null>;
  createUserIfAbsent(input: {
    userId: string;
    externalSubject: string;
    displayName?: string | null;
    email?: string | null;
    status: string;
  }): Promise<{ userId: string }>;
  addMembershipIfAbsent(input: {
    orgId: string;
    userId: string;
    role: string;
    status: string;
  }): Promise<unknown>;
  /** Only the profile page reads it; optional so older test doubles still fit. */
  getOrganization?(orgId: string): Promise<{ name: string } | null>;
  /** 活跃准入（`ActivePrincipalService`）需要；旧替身可省略。 */
  getUser?(userId: string): Promise<{ userId: string; externalSubject: string; status: string } | null>;
  getMembership?(scope: { orgId: string; userId: string }): Promise<{ status: string } | null>;
};

type ExternalRefStore = {
  getOrganizationRef(
    provider: string,
    externalSubject: string,
  ): Promise<{ orgId: string } | null>;
  getOrCreateOrganizationRef(input: {
    provider: string;
    externalSubject: string;
    orgId: string;
  }): Promise<{ orgId: string }>;
};

type CredentialStore = {
  create(input: Record<string, unknown>): Promise<Credential | null>;
  getByUsername(username: string): Promise<Credential | null>;
  getByExternalUserId(id: string): Promise<Credential | null>;
  updateProfile?(
    externalUserId: string,
    userExternalSubject: string,
    patch: ProfilePatch,
  ): Promise<Credential | null>;
  /** 长任务完成邮件开关，存在 users 行上（通知消费者从那里读）。 */
  getNotifyRunComplete?(userExternalSubject: string): Promise<boolean>;
  setRole(id: string, role: string): Promise<void>;
  touchLogin(id: string): Promise<void>;
};

/**
 * 角色账本的**最小端口**（`MemberRoleService` 满足它）。
 *
 * 只要求两件事：读这个人的角色集合、按环境变量名单做一次引导。写成显式端口而不是
 * 直接依赖服务类：这一跳是「浏览器身份 → 平台角色」的权威，签名写错在 `any` 下不会
 * 有任何提示（与上面的 `OrganizationStore` 同一理由）。
 *
 * 可选是刻意的：**没有注入账本时角色集合为空**——fail-closed，缺配置只会少权限，
 * 不会把管理面开出去。
 */
type MemberRolePort = {
  listRolesForMember(orgId: string, userId: string): Promise<readonly KnownRole[]>;
  ensureDeploymentGrant(input: {
    orgId: string;
    userId: string;
    username: string | null | undefined;
  }): Promise<void>;
};

type ProfilePatch = { displayName?: string; email?: string | null; notifyRunComplete?: boolean };

/** 服务端算出的邮件通知能力；前端据此禁用开关，不自行猜测。 */
export type NotificationCapability = {
  available: boolean;
  min_run_duration_ms: number | null;
};

/** 本轮固定 local：不新增没有真实消费者的 SSO 环境变量（tasks §25）。 */
export const AUTH_MODE_LOCAL = 'local';
const SSO_LABEL = '公司 SSO';

const EDITABLE_PROFILE_FIELDS = ['display_name', 'email', 'notify_run_complete'];

function safeText(value: unknown, field: string, max: number): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) {
    throw new BrowserAuthError(422, 'AUTH_INPUT_INVALID', `${field} is invalid`);
  }
  return value;
}

export async function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const digest = await pbkdf2(password, salt, PASSWORD_ITERATIONS, 32, 'sha256');
  return `pbkdf2_sha256$${salt}$${digest.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [algorithm, salt, digestHex, ...rest] = String(stored).split('$');
  if (algorithm !== 'pbkdf2_sha256' || !salt || !digestHex || rest.length) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(digestHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== 32 || expected.toString('hex') !== digestHex.toLowerCase()) return false;
  const actual = await pbkdf2(password, salt, PASSWORD_ITERATIONS, 32, 'sha256');
  return timingSafeEqual(actual, expected);
}

export class BrowserAuthService {
  credentials: CredentialStore;
  organizations?: OrganizationStore | undefined;
  externalRefs?: ExternalRefStore | undefined;
  memberRoles?: MemberRolePort | undefined;
  generateId?: (() => string) | undefined;
  /**
   * 可撤销会话账本（design sso-integration-reservation §5.2）。生产由 `http-main`
   * 注入 `repos.browserAuthSessions`；缺省时登录/me/config/logout 一律 503，不会
   * 退回无 sid 的旧 JWT 语义。没有进程内身份缓存：**身份/组织不得仅用缓存**，
   * 每次请求都回权威表核对。
   */
  sessionService: BrowserSessionService | null;
  principal: ActivePrincipalService | null;
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
  allowPublicRegister: boolean;
  notificationCapability: NotificationCapability;
  now: () => Date;

  constructor(input: {
    credentials: CredentialStore;
    organizations?: OrganizationStore;
    externalRefs?: ExternalRefStore;
    memberRoles?: MemberRolePort;
    sessions?: BrowserSessionStore;
    generateId?: () => string;
    secret?: string;
    issuer?: string;
    audience?: string;
    ttlSeconds?: number;
    allowPublicRegister?: boolean;
    notificationCapability?: NotificationCapability;
    now?: () => Date;
  }) {
    this.credentials = input.credentials;
    this.organizations = input.organizations;
    this.externalRefs = input.externalRefs;
    this.memberRoles = input.memberRoles;
    this.generateId = input.generateId;
    this.secret = String(input.secret || '').trim();
    this.issuer = String(input.issuer || 'dsh-enterprise-sandbox');
    this.audience = String(input.audience || 'dsh-enterprise-sandbox');
    this.ttlSeconds = Math.min(604_800, Math.max(60, Number(input.ttlSeconds) || 86_400));
    this.allowPublicRegister = input.allowPublicRegister !== false;
    this.notificationCapability = input.notificationCapability ?? {
      available: false,
      min_run_duration_ms: null,
    };
    this.now = input.now || (() => new Date());
    this.sessionService = input.sessions
      ? new BrowserSessionService({
          sessions: input.sessions,
          tokens: new BrowserSessionTokens({
            secret: this.secret,
            issuer: this.issuer,
            audience: this.audience,
            now: this.now,
          }),
          generateId: this.generateId,
          now: this.now,
        })
      : null;
    this.principal = input.organizations && input.externalRefs
      ? new ActivePrincipalService({
          organizations: input.organizations,
          externalRefs: input.externalRefs,
        })
      : null;
  }

  private requireSecret() {
    if (!this.secret) {
      throw new BrowserAuthError(503, 'AUTH_CONFIG_UNAVAILABLE', 'Authentication unavailable');
    }
  }

  private requireSessions(): BrowserSessionService {
    this.requireSecret();
    if (!this.sessionService) throw browserAuthStoreUnavailable();
    return this.sessionService;
  }

  /**
   * 登录能力投影（锁定 DTO，tasks §24–42）。Agent 是登录能力权威：不返回假的可用
   * 能力，JWT secret 或会话权威缺失一律 503，而不是把 local.enabled 说成 true。
   * 本轮固定 local；SSO 恒为 disabled + unavailable，不伪造回调路由。
   */
  authConfig() {
    this.requireSecret();
    if (!this.sessionService) throw browserAuthStoreUnavailable();
    return {
      mode: AUTH_MODE_LOCAL,
      methods: {
        local: {
          enabled: true,
          registration_enabled: this.allowPublicRegister,
        },
        sso: { enabled: false, available: false, label: SSO_LABEL },
      },
      profile_policy: { editable_fields: [...EDITABLE_PROFILE_FIELDS] },
    };
  }

  /**
   * 把一个浏览器凭据补成正式的 org / user / membership，并返回**内部身份 ULID**。
   *
   * 角色账本挂在 `(org_id, user_id)` 上，而这里正是把外部凭据翻译成那两个 ULID 的
   * 唯一一跳，所以它必须把结果交出来。**只在登录/注册与写通知开关前调用**；
   * `me`/`profile` 走会话行里的 owner，不在这里重放 provisioning（身份/组织不得
   * 仅用缓存，见 `ActivePrincipalService`）。
   *
   * 失败只记日志不抛：这一步是**补建**，它缺席的后果是下游 400，而不是让
   * 登录本身失败——把它变成硬失败会让一次 MySQL 抖动直接锁死所有人登录。登录/注册
   * 拿不到身份时由调用方转成 503，绝不签发一个没有 owner 的会话。
   */
  private async ensureUserProvisioned(
    entry: Credential,
  ): Promise<{ orgId: string; userId: string } | null> {
    if (!this.organizations || !this.externalRefs) return null;
    try {
      const provider = 'bff';
      const externalOrgId = entry.organizationId || BOOTSTRAP_ORG_ID;
      let orgRef = await this.externalRefs.getOrganizationRef(provider, externalOrgId);
      let orgId: string;
      if (orgRef?.orgId) {
        orgId = orgRef.orgId;
      } else {
        const newOrgId = this.generateId ? this.generateId() : ulid();
        try {
          await this.organizations.createOrganization({
            orgId: newOrgId,
            name: externalOrgId,
            status: 'active',
          });
        } catch {
          // Organization might already exist
        }
        orgRef = await this.externalRefs.getOrCreateOrganizationRef({
          provider,
          externalSubject: externalOrgId,
          orgId: newOrgId,
        });
        orgId = orgRef.orgId;
      }

      const encodedUser = formatUserExternalSubject(provider, entry.id);
      let user = await this.organizations.getUserByExternalSubject(encodedUser);
      if (!user) {
        const newUserId = this.generateId ? this.generateId() : ulid();
        user = await this.organizations.createUserIfAbsent({
          userId: newUserId,
          externalSubject: encodedUser,
          displayName: entry.displayName || entry.username,
          email: entry.email,
          status: 'active',
        });
      }

      await this.organizations.addMembershipIfAbsent({
        orgId,
        userId: user.userId,
        // 成员关系的 role 已收窄为「成员类型」，不参与授权（design §2.3）：
        // 角色权威是 member_roles。写当时的 credential 角色只会再制造一份陈旧快照。
        role: 'member',
        status: 'active',
      });
      return { orgId, userId: user.userId };
    } catch (err) {
      console.error('[browser-auth] Failed to provision user in organizations:', err);
      return null;
    }
  }

  /**
   * 这个身份当前的平台角色集合：环境变量名单引导 + 账本读取。
   *
   * 顺序不能反：先引导再读，名单内账号的**首个** `me` 才能立刻看到 admin。
   * 账本没注入时返回空集合（fail-closed）。角色**每次请求**都从账本重读，
   * 撤销 admin 必须在下一个请求生效，不必等 JWT 过期（design §4.4）。
   */
  private async rolesForIdentity(
    identity: ActivePrincipalIdentity | { orgId: string; userId: string },
    username: string | null | undefined,
  ): Promise<KnownRole[]> {
    if (!this.memberRoles) return [];
    await this.memberRoles.ensureDeploymentGrant({
      orgId: identity.orgId,
      userId: identity.userId,
      username,
    });
    return parseRoleSet(
      await this.memberRoles.listRolesForMember(identity.orgId, identity.userId),
    );
  }

  private publicUser(
    entry: Credential,
    roles: readonly string[],
    session?: Pick<IssuedBrowserSession, 'loginMethod' | 'identityProvider'> | null,
  ) {
    const granted = parseRoleSet(roles);
    return {
      id: entry.id,
      username: entry.username,
      email: entry.email,
      display_name: entry.displayName,
      // 兼容主角色（含 admin 即 admin）；**权威是 roles**，前端改读它。
      role: primaryRole(granted),
      roles: granted,
      organization_id: entry.organizationId || BOOTSTRAP_ORG_ID,
      login_method: session?.loginMethod ?? AUTH_MODE_LOCAL,
      identity_provider: session?.identityProvider ?? null,
    };
  }

  /**
   * 兼容列的写回：`auth_credentials.role` 不再是权威，只投影 `me` 算出的主角色
   * （design §2.3，删列留给后续清理 PR）。
   *
   * 写失败不抛：角色已经读到并会随响应返回，而这一列没有任何判定在读它；
   * 为一次兼容列的写失败把登录打成 503 是纯粹的倒退。
   */
  private async syncCompatRole(entry: Credential, roles: readonly string[]): Promise<Credential> {
    const compat = primaryRole(roles);
    if (entry.role === compat) return entry;
    try {
      await this.credentials.setRole(entry.id, compat);
    } catch (err) {
      console.error('[browser-auth] Failed to sync the deprecated role column:', err);
    }
    return { ...entry, role: compat };
  }

  /**
   * 登录/注册共建会话：先补建权威身份，再确认主体活跃，最后才引导角色并写 sid。
   *
   * 活跃准入（`resolveActive`）必须排在 `rolesForIdentity` 与 `issue` **之前**：
   * `rolesForIdentity` 会调用 `ensureDeploymentGrant` 做部署名单引导，停用的
   * user/org/Membership 若能走到那里，就会在被停用主体上写出 admin，再拿到一个 sid。
   * 所以这里先过准入门槛，拒绝时既没有新会话，也没有新授予。
   */
  private async establishLocalSession(
    entry: Credential,
    source: 'login' | 'register',
  ): Promise<{ token: string; user: Record<string, unknown> }> {
    const sessions = this.requireSessions();
    const identity = await this.ensureUserProvisioned(entry);
    if (!identity) throw browserAuthStoreUnavailable();
    if (!this.principal) throw browserAuthStoreUnavailable();
    let active: ActivePrincipalIdentity;
    try {
      active = await this.principal.resolveActive({
        orgId: identity.orgId,
        userId: identity.userId,
        externalUserId: entry.id,
        externalOrgId: entry.organizationId || BOOTSTRAP_ORG_ID,
      });
    } catch (error) {
      // resolveActive 的 401（状态/映射不成立）与 503（权威存储不可达）原样保留。
      if (error instanceof BrowserAuthError) throw error;
      throw browserAuthStoreUnavailable();
    }
    let roles: KnownRole[];
    try {
      roles = await this.rolesForIdentity(active, entry.username);
    } catch {
      throw browserAuthStoreUnavailable();
    }
    const synced = await this.syncCompatRole(entry, roles);
    const issued = await sessions.issue({
      // 会话 owner 以准入读回的活跃身份为准，不用 provisioning 的返回值。
      userId: active.userId,
      orgId: active.orgId,
      externalUserId: synced.id,
      externalOrgId: synced.organizationId || BOOTSTRAP_ORG_ID,
      loginMethod: AUTH_MODE_LOCAL,
      identityProvider: null,
      source,
      ttlSeconds: this.ttlSeconds,
    });
    return { token: issued.token, user: this.publicUser(synced, roles, issued) };
  }

  async register(body: Record<string, unknown>) {
    this.requireSessions();
    if (!this.allowPublicRegister) {
      throw new BrowserAuthError(403, 'REGISTRATION_DISABLED', 'Public registration is disabled');
    }
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!USERNAME.test(username)) {
      throw new BrowserAuthError(422, 'AUTH_INPUT_INVALID', 'Username must be 2–64 valid characters');
    }
    if (password.length < 6 || password.length > 128) {
      throw new BrowserAuthError(422, 'AUTH_INPUT_INVALID', 'Password must be 6–128 characters');
    }
    if (await this.credentials.getByUsername(username)) {
      throw new BrowserAuthError(409, 'USERNAME_EXISTS', 'Username already exists');
    }
    try {
      const entry = await this.credentials.create({
        username,
        passwordHash: await hashPassword(password),
        externalUserId: `user_${randomBytes(8).toString('hex')}`,
        externalOrgId: BOOTSTRAP_ORG_ID,
        email: safeText(body.email, 'email', 320),
        displayName: safeText(body.display_name, 'display_name', 255),
        // 凭据创建时还不知道角色：权威账本随后由 rolesForIdentity() 决定（名单内账号
        // 会在这里被引导成 admin）。先写默认身份，绝不在创建时按用户名猜角色。
        role: 'user',
      });
      if (!entry) throw new Error('credential insert did not persist');
      return await this.establishLocalSession(entry, 'register');
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      if (/duplicate|unique/i.test(String((error as Error)?.message || ''))) {
        throw new BrowserAuthError(409, 'USERNAME_EXISTS', 'Username already exists');
      }
      throw browserAuthStoreUnavailable();
    }
  }

  async login(body: Record<string, unknown>) {
    this.requireSessions();
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || password.length > 128) {
      throw new BrowserAuthError(422, 'AUTH_INPUT_INVALID', 'Username and password are required');
    }
    let entry: Credential | null;
    try {
      entry = await this.credentials.getByUsername(username);
    } catch {
      throw browserAuthStoreUnavailable();
    }
    if (!entry?.isActive || !(await verifyPassword(password, entry.passwordHash))) {
      throw new BrowserAuthError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }
    try {
      await this.credentials.touchLogin(entry.id);
    } catch {
      throw browserAuthStoreUnavailable();
    }
    return this.establishLocalSession(entry, 'login');
  }

  /**
   * 当前有效会话背后的活跃身份与角色，或 401/503。
   *
   * 顺序：JWT + sid + 会话行（`BrowserSessionService`）→ 凭据仍 active →
   * 活跃 user/org/Membership 与 owner 映射一致（`ActivePrincipalService`）→
   * 角色每次从账本重读。身份/组织不读进程内缓存。
   */
  private async authenticated(
    authorization: string | undefined,
  ): Promise<{
    entry: Credential;
    roles: KnownRole[];
    session: BrowserSessionRecord;
  }> {
    const sessions = this.requireSessions();
    const resolved = await sessions.resolve(authorization);
    const { session } = resolved;
    let entry: Credential | null;
    try {
      entry = await this.credentials.getByExternalUserId(resolved.sub);
    } catch {
      throw browserAuthStoreUnavailable();
    }
    if (!entry?.isActive) throw invalidBrowserToken();
    if (!this.principal) throw browserAuthStoreUnavailable();
    // 会话固定 org 是签发时写进 JWT 与会话行的事实（JWT/org 一致性已在
    // `BrowserSessionService.resolve` 校验）。这里再要求当前 credential 的 org 仍与它
    // 一致，并且用会话行里的 externalOrgId 做准入查询——不能凭当前 credential 把
    // 会话 owner 换到另一个外部 org，即使那个 org 映射到同一个内部 org。
    const sessionExternalOrgId = String(session.externalOrgId || BOOTSTRAP_ORG_ID);
    const credentialExternalOrgId = String(entry.organizationId || BOOTSTRAP_ORG_ID);
    if (credentialExternalOrgId !== sessionExternalOrgId) throw invalidBrowserToken();
    const identity = await this.principal.resolveActive({
      orgId: session.orgId,
      userId: session.userId,
      externalUserId: entry.id,
      externalOrgId: sessionExternalOrgId,
    });
    let roles: KnownRole[];
    try {
      roles = await this.rolesForIdentity(identity, entry.username);
    } catch {
      // 角色账本不可达必须 503，不能当成空角色集放行。
      throw browserAuthStoreUnavailable();
    }
    entry = await this.syncCompatRole(entry, roles);
    return { entry, roles, session };
  }

  async me(authorization: string | undefined) {
    const { entry, roles, session } = await this.authenticated(authorization);
    return this.publicUser(entry, roles, session);
  }

  /**
   * The account page's view: `me` plus organisation name, status and dates.
   * Kept off `me()`, which runs on every BFF request and must stay cheap.
   */
  async profile(authorization: string | undefined) {
    const { entry, roles, session } = await this.authenticated(authorization);
    return this.presentProfile(entry, roles, session);
  }

  /**
   * 退出：撤销当前 sid（幂等），只清当前会话。契约见 `BrowserSessionService.revoke`。
   */
  async logout(authorization: string | undefined) {
    if (!this.sessionService) {
      throw new BrowserAuthError(
        503,
        'AUTH_REVOCATION_UNCONFIRMED',
        'Session revocation could not be confirmed',
      );
    }
    return this.sessionService.revoke(authorization);
  }

  private async presentProfile(
    entry: Credential,
    roles: readonly string[],
    session?: Pick<IssuedBrowserSession, 'loginMethod' | 'identityProvider'> | null,
  ) {
    let organizationName: string | null = null;
    try {
      const ref = await this.externalRefs?.getOrganizationRef('bff', entry.organizationId || BOOTSTRAP_ORG_ID);
      const org = ref?.orgId && this.organizations?.getOrganization
        ? await this.organizations.getOrganization(ref.orgId)
        : null;
      organizationName = org?.name ?? null;
    } catch {
      organizationName = null;
    }
    let notifyRunComplete = false;
    if (this.credentials.getNotifyRunComplete) {
      try {
        notifyRunComplete = await this.credentials.getNotifyRunComplete(
          formatUserExternalSubject('bff', entry.id),
        );
      } catch {
        throw browserAuthStoreUnavailable();
      }
    }
    return {
      ...this.publicUser(entry, roles, session),
      organization_name: organizationName,
      status: entry.isActive ? 'active' : 'disabled',
      created_at: entry.createdAt ?? null,
      last_login_at: entry.lastLoginAt ?? null,
      notify_run_complete: notifyRunComplete,
      notifications: { email: this.notificationCapability },
      editable_fields: EDITABLE_PROFILE_FIELDS,
    };
  }

  /**
   * Self-service edit: the display name, the email and the run-completion email
   * switch. Username, role, organisation and status belong to the deployment /
   * an administrator, so any other key is refused rather than silently ignored.
   *
   * Turning the switch on needs the capability to be configured and an email
   * address to send to; otherwise it is refused (422) instead of "saved" while
   * no mail would ever go out.
   */
  async updateProfile(authorization: string | undefined, body: Record<string, unknown>) {
    const { entry, roles, session } = await this.authenticated(authorization);
    const unknown = Object.keys(body || {}).filter((k) => !EDITABLE_PROFILE_FIELDS.includes(k));
    if (unknown.length) {
      throw new BrowserAuthError(422, 'PROFILE_FIELD_NOT_EDITABLE', `Not editable: ${unknown.join(', ')}`);
    }
    const patch: ProfilePatch = {};
    if (Object.hasOwn(body, 'display_name')) {
      const name = typeof body.display_name === 'string' ? body.display_name.trim() : '';
      if (!name || name.length > 255) {
        throw new BrowserAuthError(422, 'AUTH_INPUT_INVALID', 'display_name must be 1–255 characters');
      }
      patch.displayName = name;
    }
    if (Object.hasOwn(body, 'email')) {
      const raw = body.email;
      if (raw === null || raw === '') {
        patch.email = null;
      } else {
        const email = typeof raw === 'string' ? raw.trim() : '';
        if (!email || email.length > 320 || !EMAIL.test(email)) {
          throw new BrowserAuthError(422, 'AUTH_INPUT_INVALID', 'email is not a valid address');
        }
        patch.email = email;
      }
    }
    if (Object.hasOwn(body, 'notify_run_complete')) {
      const value = body.notify_run_complete;
      if (typeof value !== 'boolean') {
        throw new BrowserAuthError(422, 'AUTH_INPUT_INVALID', 'notify_run_complete must be a boolean');
      }
      if (value && !this.notificationCapability.available) {
        throw new BrowserAuthError(422, 'NOTIFICATION_UNAVAILABLE', 'Email notification is not configured on this deployment');
      }
      const email = patch.email !== undefined ? patch.email : entry.email;
      if (value && !email) {
        throw new BrowserAuthError(422, 'NOTIFY_EMAIL_REQUIRED', 'Set an email address before turning on email notification');
      }
      patch.notifyRunComplete = value;
    }
    // 开关开着就必须有地址：清空邮箱而不同时关掉开关会让通知静默落空。
    if (patch.email === null && patch.notifyRunComplete === undefined && this.credentials.getNotifyRunComplete) {
      let enabled: boolean;
      try {
        enabled = await this.credentials.getNotifyRunComplete(formatUserExternalSubject('bff', entry.id));
      } catch {
        throw browserAuthStoreUnavailable();
      }
      if (enabled) {
        throw new BrowserAuthError(422, 'NOTIFY_EMAIL_REQUIRED', 'Turn off email notification before clearing the email address');
      }
    }
    if (!Object.keys(patch).length) {
      throw new BrowserAuthError(422, 'AUTH_INPUT_INVALID', 'Nothing to update');
    }
    // 开关只存在 users 行上：先确保这一行存在，否则更新会落空。
    if (patch.notifyRunComplete !== undefined) await this.ensureUserProvisioned(entry);
    if (!this.credentials.updateProfile) {
      throw browserAuthStoreUnavailable();
    }
    let updated: Credential | null;
    try {
      updated = await this.credentials.updateProfile(entry.id, formatUserExternalSubject('bff', entry.id), patch);
    } catch {
      throw browserAuthStoreUnavailable();
    }
    return this.presentProfile(updated ?? entry, roles, session);
  }
}
