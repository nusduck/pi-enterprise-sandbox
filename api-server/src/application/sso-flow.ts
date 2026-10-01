/**
 * 公司 SSO 的 OIDC 授权码 + PKCE 流程（design docs/design/sso-oidc-dev.md §4.1）。
 *
 * 协议细节全部交给 openid-client（discovery 的 issuer 精确匹配、PKCE S256、state /
 * nonce 校验、token 端点调用与 ID token 校验）。BFF 只负责：
 *
 * - `start`：生成事务、写加密 Cookie、给出 IdP 授权地址；
 * - `finish`：凭回调里的 state 取回事务，换票，把 ID token + nonce 交给 Agent
 *   独立验签并签发平台会话。
 *
 * 公司 token 只在这一跳出现：不进浏览器、不进日志、不传给 exec / MCP / 模型。
 */

import * as oidc from 'openid-client';
import type { IncomingMessage } from 'node:http';
import type { SsoClientConfig } from '../sso-config.js';
import {
  openTransaction,
  safeReturnTo,
  sealTransaction,
  type SsoTransaction,
} from './sso-transaction.js';

export class SsoFlowError extends Error {
  readonly code: string;
  constructor(code: string, message: string = code) {
    super(message);
    this.name = 'SsoFlowError';
    this.code = code;
  }
}

export interface SsoStart {
  readonly authorizationUrl: string;
  readonly transactionCookie: string;
}

export interface SsoFinish {
  readonly idToken: string;
  readonly nonce: string;
  readonly transaction: SsoTransaction;
}

export class SsoFlow {
  readonly config: SsoClientConfig;
  #discovered: Promise<oidc.Configuration> | null = null;

  constructor(config: SsoClientConfig) {
    this.config = config;
  }

  /** discovery 结果缓存；失败不缓存（下一次登录重试），也不会退回非 issuer 的端点。 */
  #configuration(): Promise<oidc.Configuration> {
    if (!this.#discovered) {
      const cfg = this.config;
      const pending = oidc
        .discovery(
          new URL(cfg.issuer),
          cfg.clientId,
          undefined,
          oidc.ClientSecretPost(cfg.clientSecret),
          {
            timeout: Math.max(1, Math.ceil(cfg.requestTimeoutMs / 1000)),
            ...(cfg.allowInsecureHttp ? { execute: [oidc.allowInsecureRequests] } : {}),
          },
        )
        .catch((error) => {
          this.#discovered = null;
          throw new SsoFlowError('SSO_UPSTREAM_UNAVAILABLE', `discovery failed: ${(error as Error)?.message}`);
        });
      this.#discovered = pending;
    }
    return this.#discovered;
  }

  async start(returnTo: unknown): Promise<SsoStart> {
    if (!this.config.available) throw new SsoFlowError('SSO_CONFIG_UNAVAILABLE');
    const configuration = await this.#configuration();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const transaction: SsoTransaction = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      codeVerifier,
      returnTo: safeReturnTo(returnTo),
    };
    const url = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes,
      response_type: 'code',
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state: transaction.state,
      nonce: transaction.nonce,
    });
    return {
      authorizationUrl: url.toString(),
      transactionCookie: await sealTransaction(
        transaction,
        this.config.transactionSecret,
        this.config.transactionTtlSeconds,
      ),
    };
  }

  /**
   * 回调：先认事务，再换票。IdP 回传的 `error`（用户拒绝等）映射成稳定错误码，
   * 不把 IdP 的描述文本带回浏览器。
   */
  async finish(req: IncomingMessage, query: URLSearchParams): Promise<SsoFinish> {
    if (!this.config.available) throw new SsoFlowError('SSO_CONFIG_UNAVAILABLE');
    const state = query.get('state') || '';
    const transaction = await openTransaction(req, state, this.config.transactionSecret);
    if (!transaction) throw new SsoFlowError('SSO_STATE_INVALID');
    const upstreamError = query.get('error');
    if (upstreamError) {
      throw new SsoFlowError(upstreamError === 'access_denied' ? 'SSO_ACCESS_DENIED' : 'SSO_CALLBACK_INVALID');
    }
    if (!query.get('code')) throw new SsoFlowError('SSO_CALLBACK_INVALID');

    const configuration = await this.#configuration();
    // 用登记的回调地址重建「当前 URL」：BFF 在反代后面，req.url 的 host 不可信。
    const currentUrl = new URL(this.config.redirectUri);
    currentUrl.search = query.toString();
    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      });
    } catch (error) {
      const name = String((error as { name?: string })?.name || '');
      // 网络/超时是上游不可用；协议校验失败（state/nonce/签名/code 无效）是回调不合法。
      if (name === 'TypeError' || name === 'TimeoutError' || name === 'AbortError') {
        throw new SsoFlowError('SSO_UPSTREAM_UNAVAILABLE');
      }
      throw new SsoFlowError('SSO_CALLBACK_INVALID', `code exchange failed: ${name}`);
    }
    const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : '';
    if (!idToken) throw new SsoFlowError('SSO_CALLBACK_INVALID');
    return { idToken, nonce: transaction.nonce, transaction };
  }
}

let shared: SsoFlow | null = null;

/** 进程级单例：discovery 结果在副本内复用。 */
export function ssoFlowFor(config: SsoClientConfig): SsoFlow {
  if (!shared || shared.config !== config) shared = new SsoFlow(config);
  return shared;
}
