/**
 * CSRF guard for BFF auth *write* requests (`login` / `register` / `logout` /
 * `PATCH profile`).
 *
 * These endpoints authenticate the browser with an HttpOnly session cookie, so
 * a cross-site page must not be able to drive them. CORS response headers are
 * not a server-side defense; the guard runs before the handler regardless of
 * whether the browser would have been allowed to read the response.
 *
 * Rule (design `sso-integration-reservation.md` §6):
 *   - `Sec-Fetch-Site: cross-site` is a hard reject. The Fetch Metadata header
 *     is set by the browser and cannot be spoofed from page JavaScript.
 *   - A request without `Origin` is a non-browser client (curl / server-to-server
 *     Bearer). A browser always attaches `Origin` to these writes, so there is
 *     no drive-by CSRF vector to reject.
 *   - A request with `Origin` is accepted when the browser already attested
 *     `same-origin`/`none`, or when the Origin matches the request's own
 *     Host / the configured CORS allowlist. `Origin: null` (opaque) and
 *     unknown origins are rejected.
 *
 * The dev-only loopback escape hatch keeps the HTTP/no-Secure cookie
 * compatibility for `vite` (which rewrites `Host` via `changeOrigin`) without
 * introducing a new environment variable.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { sendJson } from './response.js';

export const CROSS_SITE_AUTH_CODE = 'CSRF_ORIGIN_REJECTED';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface AuthWriteRejection {
  code: string;
  message: string;
}

function headerValue(
  req: IncomingMessage | { headers?: Record<string, string | string[] | undefined> } | null | undefined,
  name: string,
): string | null {
  const raw = req?.headers?.[name];
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : null;
  return typeof raw === 'string' ? raw : null;
}

function parseHttpOrigin(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url;
}

function selfHost(req: IncomingMessage): string | null {
  const host = headerValue(req, 'host');
  return host && host.trim() ? host.trim().toLowerCase() : null;
}

function isAllowlistedOrigin(origin: URL): boolean {
  return config.CORS_ALLOWED_ORIGINS.some((entry) => {
    try {
      return new URL(entry).origin === origin.origin;
    } catch {
      return false;
    }
  });
}

/**
 * Return the rejection when *req* is an explicit cross-site auth write, else
 * `null`. Exported for unit tests; production callers use
 * {@link rejectCrossSiteAuthWrite}.
 */
export function detectCrossSiteAuthWrite(req: IncomingMessage): AuthWriteRejection | null {
  const secFetchSite = headerValue(req, 'sec-fetch-site')?.trim().toLowerCase() || null;
  if (secFetchSite === 'cross-site') {
    return {
      code: CROSS_SITE_AUTH_CODE,
      message: 'Cross-site authentication requests are not allowed',
    };
  }

  const rawOrigin = headerValue(req, 'origin');
  if (rawOrigin == null || rawOrigin.trim() === '') return null; // non-browser client

  const origin = parseHttpOrigin(rawOrigin);
  if (!origin) {
    // `Origin: null` and malformed values are browser-driven; fail closed.
    return {
      code: CROSS_SITE_AUTH_CODE,
      message: 'Cross-site authentication requests are not allowed',
    };
  }

  // Browser-attested same-origin/none (covers a dev proxy that rewrites Host).
  if (secFetchSite === 'same-origin' || secFetchSite === 'none') return null;

  const host = selfHost(req);
  if (host && origin.host.toLowerCase() === host) return null;
  if (isAllowlistedOrigin(origin)) return null;
  if (config.DEPLOYMENT_ENV !== 'production' && LOOPBACK_HOSTNAMES.has(origin.hostname)) {
    return null;
  }

  return {
    code: CROSS_SITE_AUTH_CODE,
    message: 'Cross-site authentication requests are not allowed',
  };
}

/** Send a 403 when *req* is cross-site; returns true when it was rejected. */
export function rejectCrossSiteAuthWrite(
  res: ServerResponse,
  req: IncomingMessage,
): boolean {
  const rejection = detectCrossSiteAuthWrite(req);
  if (!rejection) return false;
  sendJson(res, 403, { error: rejection.message, code: rejection.code });
  return true;
}
