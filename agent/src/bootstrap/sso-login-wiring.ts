/**
 * 公司 SSO（OIDC）的生产接线（design `docs/design/sso-oidc-dev.md` §5）。
 *
 * 单独成文件是为了不扩大 `http-main.ts`：这里从**当前进程环境**解析配置，给
 * `BrowserAuthService` 两样东西——SSO 配置（决定 config 投影、注册关闭、本地登录
 * 限管理员）与兑换服务（真实仓储 + jose 验签）。
 *
 * 本地密码在 SSO 打开后只留给 `SANDBOX_AUTH_ADMIN_USERNAMES`：与部署锁定 admin
 * 同一份名单，不另起配置。
 */

import type { BrowserAuthService, CredentialStore } from '../application/browser-auth-service.js';
import { OidcIdTokenVerifier } from '../application/oidc-id-token-verifier.js';
import { resolveSsoConfig } from '../application/sso-config.js';
import { SsoLoginService, type SsoIdentityStore } from '../application/sso-login-service.js';

function adminUsernames(env: NodeJS.ProcessEnv): string[] {
  return String(env.SANDBOX_AUTH_ADMIN_USERNAMES || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

export const createSsoLogin = {
  /** `BrowserAuthService` 构造参数里与 SSO 相关的部分。 */
  options(env: NodeJS.ProcessEnv) {
    return {
      sso: resolveSsoConfig(env),
      localLoginAllowlist: adminUsernames(env),
    };
  },

  /** SSO 打开时的兑换服务；未打开返回 null（兑换 503，config 投影 disabled）。 */
  service(input: {
    env: NodeJS.ProcessEnv;
    repos: { authCredentials: CredentialStore; ssoIdentities: SsoIdentityStore };
    auth: BrowserAuthService;
    generateId?: () => string;
  }): SsoLoginService | null {
    const config = resolveSsoConfig(input.env);
    if (!config.enabled) return null;
    return new SsoLoginService({
      config,
      verifier: new OidcIdTokenVerifier(config),
      identities: input.repos.ssoIdentities,
      credentials: input.repos.authCredentials,
      auth: input.auth,
      reservedUsernames: adminUsernames(input.env),
      ...(input.generateId ? { generateId: input.generateId } : {}),
    });
  },
};
