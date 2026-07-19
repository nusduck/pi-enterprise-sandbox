const SESSION_COOKIE = 'pi_enterprise_session';

export function readCookie(req, name = SESSION_COOKIE) {
  const header = String(req?.headers?.cookie || '');
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

export function sessionCookie(token, { secure = false } = {}) {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function expiredSessionCookie({ secure = false } = {}) {
  return `${sessionCookie('', { secure })}; Max-Age=0`;
}

export { SESSION_COOKIE };
