/**
 * 可撤销的浏览器应用会话（design sso-integration-reservation §5.2）。
 *
 * 权威事实是 `tbl_agsvc_browser_auth_sessions`：一行 = 一次登录签发的会话。JWT 只
 * 承载 `sid`，判定会话是否有效必须回表。这样「撤销」不是删 Cookie 的假动作——
 * 退出后同一个 JWT 的下一个请求就会 401；安全上也不允许把撤销状态放进 JWT 之外
 * 的任何进程内缓存。
 *
 * 与 `BrowserSessionTokens`（纯 JWT）和 `ActivePrincipalService`（活跃准入）分开，
 * 是因为三个职责的失败语义不同：这里负责 sid ↔ 会话行的一致性，以及退出契约
 * （confirmed / not_required / 409 / 503）。三者都需要，缺一个就会出现「本机清干净了
 * 但服务端会话还活着」或反过来的安全缺口。
 */

import { ulid } from '../domain/shared/ulid.js';
import { BrowserAuthError, browserAuthStoreUnavailable, invalidBrowserToken } from './browser-auth-errors.js';
import { BrowserSessionTokens } from './browser-session-tokens.js';

/** 会话行的仓储投影（snake_case → camelCase 由仓储完成）。 */
export interface BrowserSessionRecord {
  readonly sessionId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly externalUserId: string;
  readonly externalOrgId: string;
  readonly loginMethod: string;
  readonly identityProvider: string | null;
  readonly source: string;
  readonly createdAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export interface CreateBrowserSessionInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly externalUserId: string;
  readonly externalOrgId: string;
  readonly loginMethod: string;
  readonly identityProvider: string | null;
  readonly source: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** 会话账本的最小端口；生产实现是 `BrowserAuthSessionRepository`。 */
export interface BrowserSessionStore {
  create(input: CreateBrowserSessionInput): Promise<BrowserSessionRecord | null>;
  getById(sessionId: string): Promise<BrowserSessionRecord | null>;
  revoke(sessionId: string, revokedAt: Date): Promise<boolean>;
}

export interface IssuedBrowserSession {
  readonly sessionId: string;
  readonly token: string;
  readonly expiresAt: Date;
  readonly loginMethod: string;
  readonly identityProvider: string | null;
}

export interface ResolvedBrowserSession {
  readonly session: BrowserSessionRecord;
  readonly sub: string;
  readonly claims: Record<string, unknown>;
}

export interface BrowserSessionServiceDeps {
  readonly sessions: BrowserSessionStore;
  readonly tokens: BrowserSessionTokens;
  readonly generateId?: () => string;
  readonly now?: () => Date;
}

/** 退出结果：confirmed = 有效 sid 已撤销；not_required = 无需写入。 */
export type BrowserLogoutResult =
  | { readonly ok: true; readonly revocation: 'confirmed' }
  | { readonly ok: true; readonly revocation: 'not_required' };

function bearerToken(authorization: string | undefined): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(String(authorization || ''));
  return match ? String(match[1]) : null;
}

function isExpired(value: string | null, now: Date): boolean {
  if (!value) return true;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return true;
  return at.getTime() <= now.getTime();
}

export class BrowserSessionService {
  readonly sessions: BrowserSessionStore;
  readonly tokens: BrowserSessionTokens;
  readonly generateId: () => string;
  readonly now: () => Date;

  constructor(deps: BrowserSessionServiceDeps) {
    if (!deps?.sessions) throw new Error('BrowserSessionService requires sessions store');
    if (!deps?.tokens) throw new Error('BrowserSessionService requires tokens');
    this.sessions = deps.sessions;
    this.tokens = deps.tokens;
    this.generateId = deps.generateId ?? (() => ulid());
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 签发会话并写权威行。写库失败必须抛 503——不能只在内存里发一个「看似成功」的
   * JWT，那会在重启或跨副本时变成一个无法撤销的孤儿。
   */
  async issue(input: {
    userId: string;
    orgId: string;
    externalUserId: string;
    externalOrgId: string;
    loginMethod: string;
    identityProvider: string | null;
    source: string;
    ttlSeconds: number;
  }): Promise<IssuedBrowserSession> {
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + Math.max(1, Number(input.ttlSeconds) || 0) * 1000);
    const sessionId = this.generateId();
    let record: BrowserSessionRecord | null;
    try {
      record = await this.sessions.create({
        sessionId,
        userId: input.userId,
        orgId: input.orgId,
        externalUserId: input.externalUserId,
        externalOrgId: input.externalOrgId,
        loginMethod: input.loginMethod,
        identityProvider: input.identityProvider,
        source: input.source,
        createdAt,
        expiresAt,
      });
    } catch {
      throw browserAuthStoreUnavailable();
    }
    if (!record) throw browserAuthStoreUnavailable();
    const token = this.tokens.sign({
      sub: input.externalUserId,
      sid: sessionId,
      organizationId: input.externalOrgId,
      ttlSeconds: input.ttlSeconds,
    });
    return {
      sessionId,
      token,
      expiresAt,
      loginMethod: input.loginMethod,
      identityProvider: input.identityProvider,
    };
  }

  /**
   * 从 Authorization 解析出**当前有效**会话：签名 → sid → 回表 → 未撤销且未过期。
   * 任何一步不成立都是 401（不泄漏会话是否存在）；读库失败是 503。
   */
  async resolve(authorization: string | undefined): Promise<ResolvedBrowserSession> {
    const token = bearerToken(authorization);
    if (!token) throw invalidBrowserToken();
    const verification = this.tokens.verify(token);
    if (verification.state !== 'valid') throw invalidBrowserToken();
    const claims = verification.token;
    if (!claims.sid) {
      // 旧无 sid JWT 统一 401：部署后重新登录，不建立永久兼容旁路。
      throw invalidBrowserToken();
    }

    let record: BrowserSessionRecord | null;
    try {
      record = await this.sessions.getById(claims.sid);
    } catch {
      throw browserAuthStoreUnavailable();
    }
    if (!record) throw invalidBrowserToken();
    if (record.revokedAt) throw invalidBrowserToken();
    if (isExpired(record.expiresAt, this.now())) throw invalidBrowserToken();
    // sid 必须绑定到签发它的用户与外部组织：换用户/换 org 都视为无效。
    if (String(record.externalUserId) !== claims.sub) throw invalidBrowserToken();
    if (
      claims.organizationId != null &&
      String(record.externalOrgId) !== String(claims.organizationId)
    ) {
      throw invalidBrowserToken();
    }
    return { session: record, sub: claims.sub, claims: claims.claims };
  }

  /**
   * `POST /internal/auth/logout` 的契约（tasks §50–58）：
   *
   * - 无凭据 / 无效签名 / 已到期 / 已撤销 → `not_required`（不写库或幂等读）。
   * - 合法未到期但缺 sid 的旧 JWT → 409 `LEGACY_SESSION_NOT_REVOCABLE`。
   * - 权威存储不可达 → 503 `AUTH_REVOCATION_UNCONFIRMED`，绝不 `{ok:true}`。
   */
  async revoke(authorization: string | undefined): Promise<BrowserLogoutResult> {
    const token = bearerToken(authorization);
    if (!token) return { ok: true, revocation: 'not_required' };

    let verification: ReturnType<BrowserSessionTokens['verify']>;
    try {
      verification = this.tokens.verify(token);
    } catch {
      // 缺签名材料：无法确认，不能报 not_required。
      throw new BrowserAuthError(
        503,
        'AUTH_REVOCATION_UNCONFIRMED',
        'Session revocation could not be confirmed',
      );
    }
    if (verification.state !== 'valid') {
      return { ok: true, revocation: 'not_required' };
    }
    const claims = verification.token;
    if (!claims.sid) {
      throw new BrowserAuthError(
        409,
        'LEGACY_SESSION_NOT_REVOCABLE',
        'This legacy session has no revocable session id',
      );
    }

    let record: BrowserSessionRecord | null;
    try {
      record = await this.sessions.getById(claims.sid);
    } catch {
      throw new BrowserAuthError(
        503,
        'AUTH_REVOCATION_UNCONFIRMED',
        'Session revocation could not be confirmed',
      );
    }
    // 行不存在、已撤销、已到期，或该 sid 属于别的用户：没有可确认的撤销写入。
    if (!record) return { ok: true, revocation: 'not_required' };
    if (String(record.externalUserId) !== claims.sub) {
      return { ok: true, revocation: 'not_required' };
    }
    // 与 `resolve` 同一绑定：JWT 的 organization_id 必须与会话行签发时的外部 org 一致，
    // 否则这个 sid 不属于该 org，不能撤销（防止拿错误 org 的凭据撤销别的 sid）。
    if (
      claims.organizationId != null &&
      String(record.externalOrgId) !== String(claims.organizationId)
    ) {
      return { ok: true, revocation: 'not_required' };
    }
    if (record.revokedAt) return { ok: true, revocation: 'not_required' };
    if (isExpired(record.expiresAt, this.now())) {
      return { ok: true, revocation: 'not_required' };
    }

    let revoked: boolean;
    try {
      revoked = await this.sessions.revoke(claims.sid, this.now());
    } catch {
      throw new BrowserAuthError(
        503,
        'AUTH_REVOCATION_UNCONFIRMED',
        'Session revocation could not be confirmed',
      );
    }
    return { ok: true, revocation: revoked ? 'confirmed' : 'not_required' };
  }
}
