/**
 * 应用会话 JWT 的签发与验证（design sso-integration-reservation §5.2）。
 *
 * 本地密码登录与未来 SSO 登录共享这一层：JWT 只是会话的**载具**，权威事实在
 * `tbl_agsvc_browser_auth_sessions`。载荷里的 `sid` 是撤销的键，`sub` 继续用平台
 * 外部用户 ID（兼容旧 `users.external_subject = bff:<id>` 映射），`organization_id`
 * 是外部组织 ID。公司原始 subject 不进这个命名空间（§5.1）。
 *
 * `verify()` 刻意把「签名/声明不合法」与「已到期」分开返回，因为退出契约要求：
 * 无凭据、无效签名、已到期都返回 `not_required`，而**合法未到期但缺 sid 的旧 JWT**
 * 必须返回 409（不能声称撤销完成）。把到期并进 `invalid` 会让 409 判定写不出来。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { BrowserAuthError } from './browser-auth-errors.js';

/** 已验证、未到期的载荷。`sid` 为 null 表示合法但缺 sid 的旧 JWT。 */
export interface VerifiedBrowserToken {
  readonly sub: string;
  readonly sid: string | null;
  readonly organizationId: string | null;
  readonly exp: number;
  readonly claims: Record<string, unknown>;
}

/** 本模块的验证结果。`invalid` 与 `expired` 都不足以证明「这是当前会话」。 */
export type BrowserTokenVerification =
  | { readonly state: 'invalid' }
  | { readonly state: 'expired'; readonly sub: string | null; readonly sid: string | null }
  | { readonly state: 'valid'; readonly token: VerifiedBrowserToken };

export interface BrowserSessionTokensOptions {
  readonly secret?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly now?: () => Date;
}

function base64urlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export class BrowserSessionTokens {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly now: () => Date;

  constructor(input: BrowserSessionTokensOptions = {}) {
    this.secret = String(input.secret || '').trim();
    this.issuer = String(input.issuer || 'dsh-enterprise-sandbox');
    this.audience = String(input.audience || 'dsh-enterprise-sandbox');
    this.now = input.now || (() => new Date());
  }

  /** 缺签名材料即关闭能力（fail-closed），返回 503 而不是退回无 sid 的旧语义。 */
  requireSecret(): void {
    if (!this.secret) {
      throw new BrowserAuthError(503, 'AUTH_CONFIG_UNAVAILABLE', 'Authentication unavailable');
    }
  }

  sign(input: {
    sub: string;
    sid: string;
    username?: string | null;
    role?: string | null;
    organizationId?: string | null;
    ttlSeconds: number;
  }): string {
    this.requireSecret();
    const now = Math.floor(this.now().getTime() / 1000);
    const header = base64urlJson({ alg: 'HS256', typ: 'JWT' });
    const payload = base64urlJson({
      sub: input.sub,
      sid: input.sid,
      username: input.username ?? null,
      // JWT 里的 role 只作展示，不作权威：撤销要能在下一个请求生效，
      // 而 token 会一直活到过期（design §4.4）。
      role: input.role ?? null,
      organization_id: input.organizationId ?? null,
      iat: now,
      exp: now + input.ttlSeconds,
      iss: this.issuer,
      aud: this.audience,
    });
    const signature = createHmac('sha256', this.secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  verify(token: string): BrowserTokenVerification {
    this.requireSecret();
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { state: 'invalid' };
    const [header, payload, signature] = parts as [string, string, string];
    if (!header || !payload || !signature) return { state: 'invalid' };

    const expected = createHmac('sha256', this.secret)
      .update(`${header}.${payload}`)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, 'base64url');
    } catch {
      return { state: 'invalid' };
    }
    // 常量时间比较；长度不同直接拒绝（长度本身不是秘密）。
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return { state: 'invalid' };
    }

    let parsedHeader: Record<string, unknown>;
    let parsed: Record<string, unknown>;
    try {
      parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return { state: 'invalid' };
    }
    if (
      parsedHeader?.alg !== 'HS256' ||
      parsedHeader?.typ !== 'JWT' ||
      typeof parsed?.sub !== 'string' ||
      !parsed.sub ||
      !Number.isFinite(parsed?.exp) ||
      parsed.iss !== this.issuer ||
      parsed.aud !== this.audience
    ) {
      return { state: 'invalid' };
    }

    const exp = Number(parsed.exp);
    const now = Math.floor(this.now().getTime() / 1000);
    const sid = typeof parsed.sid === 'string' && parsed.sid ? parsed.sid : null;
    if (exp < now) {
      return { state: 'expired', sub: parsed.sub, sid };
    }
    if (!sid) {
      // 合法、未到期、但缺 sid：旧 JWT。退出时它不可撤销，但也不能当有效会话用。
      return {
        state: 'valid',
        token: {
          sub: parsed.sub,
          sid: null,
          organizationId:
            typeof parsed.organization_id === 'string' ? parsed.organization_id : null,
          exp,
          claims: parsed,
        },
      };
    }
    return {
      state: 'valid',
      token: {
        sub: parsed.sub,
        sid,
        organizationId:
          typeof parsed.organization_id === 'string' ? parsed.organization_id : null,
        exp,
        claims: parsed,
      },
    };
  }
}
