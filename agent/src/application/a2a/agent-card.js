/**
 * A2A Agent Card builder + public base URL policy (plan §20.1).
 *
 * Production: A2A_PUBLIC_BASE_URL required, https only, no userinfo/query/fragment.
 * Development fallback: explicitly gated; only loopback hosts; never trust
 * arbitrary Host / X-Forwarded-Host for credential targets.
 */

import { ValidationError } from '../errors.js';

/**
 * @param {{
 *   agentId: string,
 *   name?: string | null,
 *   description?: string | null,
 *   baseUrl: string,
 *   version?: string,
 *   skills?: object[],
 * }} input
 */
export function buildAgentCard(input) {
  const agentId = String(input.agentId || '').trim();
  const base = String(input.baseUrl || '').replace(/\/$/, '');
  const url = `${base}/a2a/agents/${agentId}`;
  return {
    name: input.name || 'Enterprise Analysis Agent',
    description:
      input.description ||
      'Enterprise data analysis agent (Pi Enterprise Sandbox)',
    url,
    version: input.version || '1.0.0',
    protocolVersion: '0.3',
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    defaultInputModes: ['text', 'text/plain'],
    defaultOutputModes: [
      'text',
      'text/plain',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    skills: Array.isArray(input.skills) ? input.skills : [],
    securitySchemes: {
      bearer: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API Credential',
        description:
          'Bearer API credential bound to org_id, agent_id, client_id, and scopes',
      },
    },
    security: [{ bearer: [] }],
  };
}

/**
 * Strict public base URL validation for Agent Card / download links.
 *
 * @param {unknown} raw
 * @param {{ requireHttps?: boolean }} [opts]
 * @returns {string} origin without trailing slash
 */
export function assertPublicBaseUrl(raw, opts = {}) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ValidationError('A2A_PUBLIC_BASE_URL is required');
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ValidationError('A2A_PUBLIC_BASE_URL is not a valid URL');
  }
  const requireHttps = opts.requireHttps !== false;
  if (requireHttps && url.protocol !== 'https:') {
    throw new ValidationError('A2A_PUBLIC_BASE_URL must use https');
  }
  if (!requireHttps && url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError('A2A_PUBLIC_BASE_URL must use http or https');
  }
  if (url.username || url.password) {
    throw new ValidationError('A2A_PUBLIC_BASE_URL must not include userinfo');
  }
  if (url.search || raw.includes('?')) {
    throw new ValidationError('A2A_PUBLIC_BASE_URL must not include query');
  }
  if (url.hash || raw.includes('#')) {
    throw new ValidationError('A2A_PUBLIC_BASE_URL must not include fragment');
  }
  if (!url.hostname) {
    throw new ValidationError('A2A_PUBLIC_BASE_URL must include a hostname');
  }
  // Origin only (no path) for stable agent card URL composition.
  if (url.pathname && url.pathname !== '/') {
    throw new ValidationError(
      'A2A_PUBLIC_BASE_URL must be origin-only (no path)',
    );
  }
  return url.origin;
}

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

/**
 * Resolve public base URL for Agent Card links.
 *
 * @param {import('node:http').IncomingMessage | null} req
 * @param {{
 *   publicBaseUrl?: string | null,
 *   deploymentEnv?: string,
 *   allowDevHostFallback?: boolean,
 * }} [config]
 * @returns {string}
 */
export function resolvePublicBaseUrl(req, config = {}) {
  const envName = String(
    config.deploymentEnv || process.env.DEPLOYMENT_ENV || process.env.NODE_ENV || '',
  ).toLowerCase();
  const isProd = envName === 'production';

  if (config.publicBaseUrl && String(config.publicBaseUrl).trim()) {
    return assertPublicBaseUrl(config.publicBaseUrl, {
      requireHttps: isProd,
    });
  }

  if (isProd) {
    throw new ValidationError(
      'A2A_PUBLIC_BASE_URL is required in production (https origin, no userinfo/query/fragment)',
    );
  }

  // Dev-only gated fallback — never trust arbitrary X-Forwarded-Host.
  const allow =
    config.allowDevHostFallback === true ||
    String(process.env.A2A_ALLOW_DEV_HOST_FALLBACK || '').toLowerCase() ===
      'true';
  if (!allow) {
    throw new ValidationError(
      'A2A_PUBLIC_BASE_URL is required (set A2A_ALLOW_DEV_HOST_FALLBACK=true only for local loopback)',
    );
  }

  const hostHeader =
    typeof req?.headers?.host === 'string' ? req.headers.host.trim() : '';
  // Explicitly ignore X-Forwarded-Host (host injection surface).
  if (!hostHeader) {
    throw new ValidationError(
      'A2A_PUBLIC_BASE_URL missing and Host header unavailable for dev fallback',
    );
  }
  // Strip port for host check
  const hostname = hostHeader.replace(/^\[/, '').includes(']:')
    ? hostHeader
    : hostHeader.split(':')[0];
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (!LOOPBACK_HOSTS.has(hostname) && !LOOPBACK_HOSTS.has(bare)) {
    throw new ValidationError(
      'Dev host fallback only allows loopback Host (localhost / 127.0.0.1)',
    );
  }
  return `http://${hostHeader}`;
}
