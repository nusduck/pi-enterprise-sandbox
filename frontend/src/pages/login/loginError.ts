/**
 * 登录与注册表单的错误信息映射。
 *
 * 将 401 / 凭据错误类错误码统一转换为中文「用户名或密码错误」；
 * 保留现有中文错误映射，未知错误使用中文兜底，避免向用户展示「Invalid credentials」等英文原文。
 */

export function loginErrorMessage(error: unknown, fallback: string): string {
  const err = error as { code?: unknown; status?: unknown; message?: unknown };
  const code = typeof err?.code === 'string' ? err.code : '';
  const status = typeof err?.status === 'number' ? err.status : undefined;
  const msg = typeof err?.message === 'string' ? err.message.trim() : '';

  if (code === 'LOCAL_LOGIN_RESTRICTED') {
    return '员工请使用公司 SSO 登录；账号密码仅供管理员使用。';
  }

  if (
    code === 'INVALID_CREDENTIALS' ||
    status === 401 ||
    msg.toLowerCase().includes('invalid credential')
  ) {
    return '用户名或密码错误';
  }

  if (code === 'USERNAME_EXISTS') {
    return '用户名已存在，请直接登录或更换用户名';
  }

  if (code === 'REGISTRATION_DISABLED') {
    return '平台未开放自主注册，请联系管理员开通账号';
  }

  if (
    code === 'AUTH_STORE_UNAVAILABLE' ||
    code === 'AUTH_CONFIG_UNAVAILABLE' ||
    code === 'AUTH_DEPENDENCY_UNAVAILABLE'
  ) {
    return '登录服务暂时不可用，请稍后重试';
  }

  // 若服务端或上游已给出中文错误，保留原中文描述
  if (msg && /[\u4e00-\u9fa5]/.test(msg)) {
    return msg;
  }

  return fallback;
}
