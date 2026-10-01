/**
 * 公司 SSO 登录兑换（design `docs/design/sso-oidc-dev.md` §3–§4）：
 * BFF 完成 code + PKCE 换票后，把 ID token 与它已消费事务里的 nonce 交给这里。
 *
 * 1. `OidcIdTokenVerifier` 独立验签（不信 BFF 的 claims）；
 * 2. 按 `(iss, sub)` 找平台用户；没有就 JIT 建号：一行**没有可用密码**的凭据
 *    （本地密码登录永远对不上）+ 一行身份关联，全部落进配置的唯一 org；
 * 3. 交给 `BrowserAuthService.establishSsoSession` 走与本地登录相同的准入与 sid 签发。
 *
 * 角色不从 claims 来：JIT 用户没有任何角色，由 admin 在成员页授予（member_roles）。
 * 工号只是属性：来自可配置 claim，用作用户名（便于 admin 搜索），不是绑定键。
 */

import { createHash } from 'node:crypto';
import { ulid } from '../domain/shared/ulid.js';
import {
  BrowserAuthError,
  browserAuthStoreUnavailable,
} from './browser-auth-errors.js';
import {
  EMAIL,
  USERNAME,
  type BrowserAuthService,
  type Credential,
  type CredentialStore,
} from './browser-auth-service.js';
import { ssoConfigUnavailable, type OidcIdTokenVerifier } from './oidc-id-token-verifier.js';
import type { SsoConfig } from './sso-config.js';
import type { SsoIdentityRecord } from '../infrastructure/mysql/repositories/sso-identity-repository.js';

/** 不可能通过 `verifyPassword`（算法前缀不是 pbkdf2_sha256）的占位哈希。 */
export const SSO_PASSWORD_PLACEHOLDER = 'sso$no-local-password';

export interface SsoIdentityStore {
  getBySubject(issuer: string, subject: string): Promise<SsoIdentityRecord | null>;
  create(input: {
    identityId: string;
    issuer: string;
    subject: string;
    externalUserId: string;
    employeeId: string | null;
  }): Promise<SsoIdentityRecord | null>;
  touchLogin(identityId: string, employeeId: string | null): Promise<void>;
}

export interface SsoLoginServiceDeps {
  readonly config: SsoConfig;
  readonly verifier: OidcIdTokenVerifier;
  readonly identities: SsoIdentityStore;
  readonly credentials: CredentialStore;
  readonly auth: BrowserAuthService;
  /** 部署管理员名单：SSO 用户不得以这些用户名建号（会与应急本地账号混淆）。 */
  readonly reservedUsernames?: readonly string[];
  readonly generateId?: () => string;
}

function isDuplicate(error: unknown): boolean {
  return /duplicate|unique|ER_DUP_ENTRY/i.test(
    `${(error as { code?: string })?.code || ''} ${(error as Error)?.message || ''}`,
  );
}

function claimText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text && text.length <= max ? text : null;
}

function bindingConflict(): BrowserAuthError {
  return new BrowserAuthError(409, 'IDENTITY_BINDING_CONFLICT', 'This SSO identity cannot be linked automatically');
}

function accessUnavailable(): BrowserAuthError {
  return new BrowserAuthError(404, 'SSO_ACCESS_UNAVAILABLE', 'SSO access is unavailable for this account');
}

export class SsoLoginService {
  readonly config: SsoConfig;
  readonly verifier: OidcIdTokenVerifier;
  readonly identities: SsoIdentityStore;
  readonly credentials: CredentialStore;
  readonly auth: BrowserAuthService;
  readonly reserved: ReadonlySet<string>;
  readonly generateId: () => string;

  constructor(deps: SsoLoginServiceDeps) {
    this.config = deps.config;
    this.verifier = deps.verifier;
    this.identities = deps.identities;
    this.credentials = deps.credentials;
    this.auth = deps.auth;
    this.reserved = new Set(
      (deps.reservedUsernames ?? []).map((n) => String(n || '').trim().toLowerCase()).filter(Boolean),
    );
    this.generateId = deps.generateId ?? (() => ulid());
  }

  /** `POST /internal/auth/oidc/exchange`：`{ id_token, nonce }` → `{ token, user }`。 */
  async exchange(body: Record<string, unknown>) {
    if (!this.config.enabled || !this.config.available) throw ssoConfigUnavailable();
    const idToken = typeof body.id_token === 'string' ? body.id_token : '';
    const nonce = typeof body.nonce === 'string' ? body.nonce : '';
    const verified = await this.verifier.verify(idToken, nonce);
    const claims = verified.claims;
    const employeeId = claimText(claims[this.config.employeeIdClaim], 128);

    let identity: SsoIdentityRecord | null;
    try {
      identity = await this.identities.getBySubject(verified.issuer, verified.subject);
    } catch {
      throw browserAuthStoreUnavailable();
    }
    const entry = identity
      ? await this.#existingCredential(identity, employeeId)
      : await this.#provision(verified.issuer, verified.subject, employeeId, claims);
    if (!entry.isActive) throw accessUnavailable();
    return this.auth.establishSsoSession(entry, verified.issuer);
  }

  async #existingCredential(identity: SsoIdentityRecord, employeeId: string | null): Promise<Credential> {
    let entry: Credential | null;
    try {
      entry = await this.credentials.getByExternalUserId(identity.externalUserId);
      await this.identities.touchLogin(identity.identityId, employeeId ?? identity.employeeId);
      if (entry) await this.credentials.touchLogin(entry.id);
    } catch {
      throw browserAuthStoreUnavailable();
    }
    // 关联在、凭据不在：账本不一致，不能凭空补一个人出来。
    if (!entry) throw browserAuthStoreUnavailable();
    return entry;
  }

  /** 平台用户名：合法工号直接用；否则由 `(iss, sub)` 派生稳定值，不编造工号。 */
  #username(issuer: string, subject: string, employeeId: string | null): string {
    if (employeeId && USERNAME.test(employeeId)) return employeeId;
    const digest = createHash('sha256').update(`${issuer}\n${subject}`).digest('hex');
    return `sso_${digest.slice(0, 16)}`;
  }

  async #provision(
    issuer: string,
    subject: string,
    employeeId: string | null,
    claims: Record<string, unknown>,
  ): Promise<Credential> {
    const username = this.#username(issuer, subject, employeeId);
    if (this.reserved.has(username.toLowerCase())) throw bindingConflict();
    const emailClaim = claimText(claims.email, 320);
    const email = emailClaim && EMAIL.test(emailClaim) ? emailClaim : null;
    const displayName =
      claimText(claims.name, 255) ?? claimText(claims.preferred_username, 255) ?? username;
    const externalUserId = `sso_${this.generateId().toLowerCase()}`;

    let entry: Credential | null;
    try {
      entry = await this.credentials.create({
        username,
        passwordHash: SSO_PASSWORD_PLACEHOLDER,
        externalUserId,
        externalOrgId: this.config.orgExternalId,
        email,
        displayName,
        // 角色权威是 member_roles；JIT 用户不带任何授予。
        role: 'user',
      });
    } catch (error) {
      if (!isDuplicate(error)) throw browserAuthStoreUnavailable();
      // 用户名撞上了：要么是同一身份的并发首次登录（对方已建好关联），要么是
      // 别人占了这个用户名——后者不自动合并，交给 admin 处理。
      return this.#afterRace(issuer, subject, employeeId, username);
    }
    if (!entry || entry.id !== externalUserId) return this.#afterRace(issuer, subject, employeeId, username);

    try {
      await this.identities.create({
        identityId: this.generateId(),
        issuer,
        subject,
        externalUserId,
        employeeId,
      });
    } catch (error) {
      if (!isDuplicate(error)) throw browserAuthStoreUnavailable();
      return this.#afterRace(issuer, subject, employeeId, username);
    }
    return entry;
  }

  /**
   * 建号路上撞到唯一约束后的收敛。关联已在 → 用它（并发首次登录）。关联不在，但同名
   * 凭据是一行**尚未绑定**的 SSO 凭据 → 认领它：那是上次「凭据写成、关联没写成」的
   * 残留，用户名由工号或 `(iss, sub)` 派生，属于同一个人；不认领就会永久 409。
   * 同名的是本地密码账号 → 不合并，409 交给 admin。
   */
  async #afterRace(
    issuer: string,
    subject: string,
    employeeId: string | null,
    username: string,
  ): Promise<Credential> {
    let identity: SsoIdentityRecord | null;
    let orphan: Credential | null = null;
    try {
      identity = await this.identities.getBySubject(issuer, subject);
      if (!identity) orphan = await this.credentials.getByUsername(username);
    } catch {
      throw browserAuthStoreUnavailable();
    }
    if (identity) return this.#existingCredential(identity, employeeId);
    if (
      !orphan ||
      orphan.passwordHash !== SSO_PASSWORD_PLACEHOLDER ||
      orphan.organizationId !== this.config.orgExternalId
    ) {
      throw bindingConflict();
    }
    try {
      await this.identities.create({
        identityId: this.generateId(),
        issuer,
        subject,
        externalUserId: orphan.id,
        employeeId,
      });
    } catch (error) {
      if (!isDuplicate(error)) throw browserAuthStoreUnavailable();
      // 另一个并发请求刚认领：它要么是同一身份（重读即可），要么占了这行凭据（409）。
      const again = await this.identities.getBySubject(issuer, subject).catch(() => {
        throw browserAuthStoreUnavailable();
      });
      if (!again) throw bindingConflict();
      return this.#existingCredential(again, employeeId);
    }
    return orphan;
  }
}
