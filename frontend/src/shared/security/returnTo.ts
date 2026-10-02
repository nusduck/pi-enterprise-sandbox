/**
 * 校验并清洗 return_to：只接受以 `/` 开头且不以 `//` 或 `/\` 开头的站内路径，
 * 防止开放重定向（Open Redirect）。
 */
export function sanitizeReturnTo(returnTo?: string | null): string {
  if (!returnTo || typeof returnTo !== 'string') return '/';
  if (returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.startsWith('/\\')) {
    return returnTo;
  }
  return '/';
}
