import {
  createHmac,
  pbkdf2 as pbkdf2Callback,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { formatUserExternalSubject } from '../infrastructure/mysql/repositories/organization-repository.js';
import { ulid } from '../domain/shared/ulid.js';
import { parseRoleSet, primaryRole, type KnownRole } from '../domain/identity/roles.js';

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

const EDITABLE_PROFILE_FIELDS = ['display_name', 'email', 'notify_run_complete'];

export class BrowserAuthError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'BrowserAuthError';
    this.status = status;
    this.code = code;
  }
}

function base64urlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

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
   * 本进程内已经确认 provisioned 的 credential id → 内部身份 ULID。
   *
   * `me()` 挂在 BFF 的 `resolveTrustedAuth()` 上，**每一个**已认证请求都会走一次；
   * 不记住就是每请求 3~4 次 MySQL 往返。补建本身是幂等的一次性修复
   * （register/login 之后正常不会缺），所以每进程每用户做一次就够。
   *
   * 注意：**角色本身不进这个缓存**——授予与撤销必须在下一个请求就生效
   * （design §4.4），每次都要读账本。缓存的是映射，不是授权。
   */
  private readonly identities = new Map<string, { orgId: string; userId: string }>();
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
  }

  /**
   * 把一个浏览器凭据补成正式的 org / user / membership，并返回**内部身份 ULID**。
   *
   * 角色账本挂在 `(org_id, user_id)` 上，而这里正是把外部凭据翻译成那两个 ULID 的
   * 唯一一跳，所以它必须把结果交出来（改造前它是 void）。
   *
   * 失败只记日志不抛：这一步是**补建**，它缺席的后果是下游 400，而不是让
   * 登录本身失败——把它变成硬失败会让一次 MySQL 抖动直接锁死所有人登录。代价是
   * 返回 null 时调用方拿不到角色（fail-closed：少权限，不是多权限）。
   *
   * @param force register/login 走 true：那两条路上凭据刚变过，必须重新对账。
   */
  private async ensureUserProvisioned(
    entry: Credential,
    force = false,
  ): Promise<{ orgId: string; userId: string } | null> {
    if (!this.organizations || !this.externalRefs) return null;
    if (!force) {
      const cached = this.identities.get(entry.id);
      if (cached) return cached;
    }
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
      const identity = { orgId, userId: user.userId };
      this.identities.set(entry.id, identity);
      return identity;
    } catch (err) {
      console.error('[browser-auth] Failed to provision user in organizations:', err);
      return null;
    }
  }

  /**
   * 这个凭据当前的平台角色集合：环境变量引导 + 账本读取。
   *
   * 顺序不能反：先引导再读，名单内账号的**首个** `me` 才能立刻看到 admin。
   * 账本没注入、或身份补建失败时返回空集合（fail-closed）。
   *
   * @param force register/login 走 true：那两条路上凭据刚变过，必须重新对账
   *   （`me` 走缓存，否则每请求 3~4 次 MySQL 往返）。
   */
  private async rolesFor(entry: Credential, force = false): Promise<KnownRole[]> {
    const identity = await this.ensureUserProvisioned(entry, force);
    if (!identity) return [];
    if (!this.memberRoles) return [];
    await this.memberRoles.ensureDeploymentGrant({
      orgId: identity.orgId,
      userId: identity.userId,
      username: entry.username,
    });
    return parseRoleSet(
      await this.memberRoles.listRolesForMember(identity.orgId, identity.userId),
    );
  }

  private requireSecret() {
    if (!this.secret) {
      throw new BrowserAuthError(503, 'AUTH_CONFIG_UNAVAILABLE', 'Authentication unavailable');
    }
  }

  private publicUser(entry: Credential, roles: readonly string[]) {
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
    };
  }

  private createToken(entry: Credential, roles: readonly string[]) {
    this.requireSecret();
    const now = Math.floor(this.now().getTime() / 1000);
    const header = base64urlJson({ alg: 'HS256', typ: 'JWT' });
    const payload = base64urlJson({
      sub: entry.id,
      username: entry.username,
      // JWT 里的 role 只作展示，不作权威：撤销要能在下一个请求生效，
      // 而 token 会一直活到过期（design §4.4）。
      role: primaryRole(roles),
      organization_id: entry.organizationId || BOOTSTRAP_ORG_ID,
      iat: now,
      exp: now + this.ttlSeconds,
      iss: this.issuer,
      aud: this.audience,
    });
    const signature = createHmac('sha256', this.secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  private verifyToken(token: string): Record<string, unknown> | null {
    this.requireSecret();
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts as [string, string, string];
    const expected = createHmac('sha256', this.secret)
      .update(`${header}.${payload}`)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, 'base64url');
    } catch {
      return null;
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const now = Math.floor(this.now().getTime() / 1000);
      if (
        parsedHeader?.alg !== 'HS256' ||
        parsedHeader?.typ !== 'JWT' ||
        typeof parsed?.sub !== 'string' ||
        !Number.isFinite(parsed?.exp) ||
        parsed.exp < now ||
        parsed.iss !== this.issuer ||
        parsed.aud !== this.audience
      ) return null;
      return parsed;
    } catch {
      return null;
    }
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

  async register(body: Record<string, unknown>) {
    this.requireSecret();
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
        // 凭据创建时还不知道角色：权威账本随后由 rolesFor() 决定（名单内账号
        // 会在这里被引导成 admin）。先写默认身份，绝不在创建时按用户名猜角色。
        role: 'user',
      });
      if (!entry) throw new Error('credential insert did not persist');
      const roles = await this.rolesFor(entry, true);
      const synced = await this.syncCompatRole(entry, roles);
      return { token: this.createToken(synced, roles), user: this.publicUser(synced, roles) };
    } catch (error) {
      if (error instanceof BrowserAuthError) throw error;
      if (/duplicate|unique/i.test(String((error as Error)?.message || ''))) {
        throw new BrowserAuthError(409, 'USERNAME_EXISTS', 'Username already exists');
      }
      throw new BrowserAuthError(503, 'AUTH_STORE_UNAVAILABLE', 'Authentication unavailable');
    }
  }

  async login(body: Record<string, unknown>) {
    this.requireSecret();
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || password.length > 128) {
      throw new BrowserAuthError(422, 'AUTH_INPUT_INVALID', 'Username and password are required');
    }
    let entry: Credential | null;
    try {
      entry = await this.credentials.getByUsername(username);
    } catch {
      throw new BrowserAuthError(503, 'AUTH_STORE_UNAVAILABLE', 'Authentication unavailable');
    }
    if (!entry?.isActive || !(await verifyPassword(password, entry.passwordHash))) {
      throw new BrowserAuthError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }
    let roles: KnownRole[];
    try {
      roles = await this.rolesFor(entry, true);
      entry = await this.syncCompatRole(entry, roles);
      await this.credentials.touchLogin(entry.id);
    } catch {
      throw new BrowserAuthError(503, 'AUTH_STORE_UNAVAILABLE', 'Authentication unavailable');
    }
    return { token: this.createToken(entry, roles), user: this.publicUser(entry, roles) };
  }

  /**
   * Verified, active credential behind a bearer token, or 401.
   *
   * 角色**每次请求**都从账本重读（design §4.4）：JWT 里的 role 只作展示，
   * 撤销 admin 必须在同一个会话的下一个请求就生效，不必等 token 过期。
   */
  private async authenticated(
    authorization: string | undefined,
  ): Promise<{ entry: Credential; roles: KnownRole[] }> {
    const match = /^Bearer\s+(.+)$/i.exec(String(authorization || ''));
    const payload = match ? this.verifyToken(match[1] as string) : null;
    if (!payload) {
      throw new BrowserAuthError(401, 'INVALID_TOKEN', 'Invalid or expired token');
    }
    let entry: Credential | null;
    let roles: KnownRole[] = [];
    try {
      entry = await this.credentials.getByExternalUserId(String(payload.sub));
      if (entry?.isActive) {
        roles = await this.rolesFor(entry);
        entry = await this.syncCompatRole(entry, roles);
      }
    } catch {
      throw new BrowserAuthError(503, 'AUTH_STORE_UNAVAILABLE', 'Authentication unavailable');
    }
    if (!entry?.isActive) {
      throw new BrowserAuthError(401, 'INVALID_TOKEN', 'Invalid or expired token');
    }
    return { entry, roles };
  }

  async me(authorization: string | undefined) {
    const { entry, roles } = await this.authenticated(authorization);
    return this.publicUser(entry, roles);
  }

  /**
   * The account page's view: `me` plus organisation name, status and dates.
   * Kept off `me()`, which runs on every BFF request and must stay cheap.
   */
  async profile(authorization: string | undefined) {
    const { entry, roles } = await this.authenticated(authorization);
    return this.presentProfile(entry, roles);
  }

  private async presentProfile(entry: Credential, roles: readonly string[]) {
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
        throw new BrowserAuthError(503, 'AUTH_STORE_UNAVAILABLE', 'Authentication unavailable');
      }
    }
    return {
      ...this.publicUser(entry, roles),
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
    const { entry, roles } = await this.authenticated(authorization);
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
        throw new BrowserAuthError(503, 'AUTH_STORE_UNAVAILABLE', 'Authentication unavailable');
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
      throw new BrowserAuthError(503, 'AUTH_STORE_UNAVAILABLE', 'Authentication unavailable');
    }
    let updated: Credential | null;
    try {
      updated = await this.credentials.updateProfile(entry.id, formatUserExternalSubject('bff', entry.id), patch);
    } catch {
      throw new BrowserAuthError(503, 'AUTH_STORE_UNAVAILABLE', 'Authentication unavailable');
    }
    return this.presentProfile(updated ?? entry, roles);
  }
}
