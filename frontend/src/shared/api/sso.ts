/**
 * 公司 SSO 的浏览器侧入口（design docs/design/sso-oidc-dev.md §4.3）。
 *
 * SSO 是顶层导航，不是 fetch：点按钮整页跳到 BFF `/api/auth/sso/login`，BFF 再
 * 302 到 IdP。回调失败时 BFF 303 回 `/?sso_error=<稳定错误码>`，这里把码翻成文案、
 * 并从地址栏抹掉参数（刷新不再重复报错）。不展示 IdP 原文，也不信任参数里的文本。
 */

export const SSO_LOGIN_PATH = '/api/auth/sso/login';

const SSO_ERROR_MESSAGES: Record<string, string> = {
  SSO_ACCESS_DENIED: '你在公司 SSO 页面取消了授权，未登录。',
  SSO_STATE_INVALID: '登录请求已过期或无效，请重新点击 SSO 登录。',
  SSO_CALLBACK_INVALID: '公司 SSO 返回的登录结果无效，请重试。',
  SSO_TOKEN_INVALID: '公司 SSO 返回的身份凭据未通过校验，请重试或联系管理员。',
  SSO_CONFIG_UNAVAILABLE: '公司 SSO 暂未配置完成，请联系管理员。',
  SSO_UPSTREAM_UNAVAILABLE: '暂时无法连接公司 SSO，请稍后重试。',
  SSO_ACCESS_UNAVAILABLE: '你的账号已停用或暂无访问权限，请联系管理员。',
  IDENTITY_BINDING_CONFLICT: '你的工号与平台已有账号冲突，无法自动开通，请联系管理员。',
  AUTH_STORE_UNAVAILABLE: '登录服务暂时不可用，请稍后重试。',
  AUTH_DEPENDENCY_UNAVAILABLE: '登录服务暂时不可用，请稍后重试。',
};

const FALLBACK = '公司 SSO 登录失败，请重试。';

export function ssoErrorMessage(code: string | null | undefined): string {
  return (code && SSO_ERROR_MESSAGES[code]) || FALLBACK;
}

/** 登录后回到当前页面；只传站内路径（BFF 还会再校验一遍）。 */
export function ssoLoginUrl(returnTo: string): string {
  const path = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
  return `${SSO_LOGIN_PATH}?return_to=${encodeURIComponent(path)}`;
}

/**
 * 读出并移除地址栏里的 `sso_error`。返回要展示的文案；没有该参数返回 null。
 * 用 replaceState，不产生历史记录，也不触发路由跳转。
 */
export function takeSsoError(
  location: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location,
  history: Pick<History, 'replaceState' | 'state'> = window.history,
): string | null {
  const params = new URLSearchParams(location.search);
  if (!params.has('sso_error')) return null;
  const code = params.get('sso_error');
  params.delete('sso_error');
  const search = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
  return ssoErrorMessage(code);
}

/** 本地登录被限制为管理员时的提示（SSO 模式下员工误用账号密码）。 */
export function localLoginErrorMessage(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown })?.code;
  if (code === 'LOCAL_LOGIN_RESTRICTED') return '员工请使用公司 SSO 登录；账号密码仅供管理员使用。';
  const message = (error as Error)?.message;
  return typeof message === 'string' && message ? message : fallback;
}
