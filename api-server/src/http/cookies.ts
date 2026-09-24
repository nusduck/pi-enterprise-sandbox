import type { IncomingMessage } from 'node:http';

const SESSION_COOKIE = 'dsh_enterprise_session';

export function readCookie(req: IncomingMessage | { headers?: { cookie?: string } } | null | undefined, name: string = SESSION_COOKIE): string {
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

/**
 * 会话 Cookie 不带 `Secure`：部署形态是内网 HTTP 入口（2026-09-16 决定），
 * 而带 `Secure` 的 Cookie 浏览器在明文连接上根本不会回传——登录会直接失效。
 * `HttpOnly` + `SameSite=Lax` 保留。若入口改回 HTTPS，把 `Secure` 加回来。
 */
export function sessionCookie(token: string): string {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  return attributes.join('; ');
}

export function expiredSessionCookie(): string {
  return `${sessionCookie('')}; Max-Age=0`;
}

export { SESSION_COOKIE };

