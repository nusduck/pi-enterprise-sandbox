/**
 * Validation for Sandbox transport base URLs.
 *
 * Shared by every Agent → Sandbox transport, which is why it lives here rather
 * than inside one of them. The rules are deliberately narrow: a base URL is an
 * origin and nothing else, so a misconfigured value can never smuggle
 * credentials, a query string, or a path into a signed request.
 */

import { InternalSandboxTransportError } from './internal-sandbox-error.js';

function fail(code, message) {
  throw new InternalSandboxTransportError(code, message, { retryable: false });
}

/**
 * Literal loopback hostnames only — no DNS resolution, no CIDR invention.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLiteralLoopbackHostname(hostname) {
  const h = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/**
 * @param {string} baseUrl
 * @param {{ allowInsecureHttp?: boolean }} [opts]
 * @returns {string}
 */
export function normalizeBaseUrl(baseUrl, opts = {}) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    fail('SANDBOX_TRANSPORT_CONFIG', 'baseUrl is required');
  }
  const allowInsecureHttp = opts.allowInsecureHttp === true;
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(trimmed)) {
    fail('SANDBOX_TRANSPORT_CONFIG', 'baseUrl must be an absolute http(s) URL');
  }
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    fail('SANDBOX_TRANSPORT_CONFIG', 'baseUrl is not a valid URL');
  }
  if (u.username || u.password) {
    fail('SANDBOX_TRANSPORT_CONFIG', 'baseUrl must not embed credentials');
  }
  if (u.search || u.hash) {
    fail('SANDBOX_TRANSPORT_CONFIG', 'baseUrl must not include query/hash');
  }
  if (u.protocol === 'https:') {
    return trimmed;
  }
  if (u.protocol === 'http:') {
    // Default: only literal loopback over http. External/plain http requires
    // explicit allowInsecureHttp (dev/controlled). No CIDR/DNS policy here —
    // production config tightens further.
    if (allowInsecureHttp || isLiteralLoopbackHostname(u.hostname)) {
      return trimmed;
    }
    fail(
      'SANDBOX_TRANSPORT_CONFIG',
      'http baseUrl rejected unless loopback or allowInsecureHttp=true',
    );
  }
  fail('SANDBOX_TRANSPORT_CONFIG', 'baseUrl scheme must be http or https');
}
