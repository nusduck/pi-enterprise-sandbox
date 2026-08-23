/**
 * Authentication for the Agent's `/internal/*` plane.
 *
 * Those routes take the acting tenant straight from `X-Acting-User-Id` and
 * `X-Acting-Organization-Id` — whoever reaches the port and names a subject
 * *is* that subject. The internal token is the only thing standing between
 * that trust and the network, so an unconfigured token has to close the plane
 * rather than open it. Running without one is a local-development choice a
 * deployment states out loud (`AGENT_ALLOW_UNAUTHENTICATED_INTERNAL`), never
 * a default that a missing environment variable silently selects.
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * @param {{ AGENT_INTERNAL_TOKEN?: string, ALLOW_UNAUTHENTICATED_INTERNAL?: boolean } | null | undefined} config
 * @param {(res: import('node:http').ServerResponse, status: number, body: object) => void} json
 * @param {{ warn?: (message: string) => void }} [opts]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean}
 */
export function createInternalAuthGate(config, json, opts = {}) {
  const token = config?.AGENT_INTERNAL_TOKEN || '';
  const allowUnauthenticated = config?.ALLOW_UNAUTHENTICATED_INTERNAL === true;
  const warn = opts.warn ?? ((message) => console.warn(message));

  if (!token) {
    warn(
      allowUnauthenticated
        ? '[agent-server] SECURITY: AGENT_INTERNAL_TOKEN is empty and ' +
            'AGENT_ALLOW_UNAUTHENTICATED_INTERNAL=true — /internal/* accepts ' +
            'any caller and trusts its X-Acting-* headers. Development only.'
        : '[agent-server] AGENT_INTERNAL_TOKEN is empty; /internal/* will ' +
            'reject every request. Set the token, or set ' +
            'AGENT_ALLOW_UNAUTHENTICATED_INTERNAL=true for local development.',
    );
  }

  return function enforceInternalAuth(req, res) {
    if (!token) {
      if (allowUnauthenticated) return true;
      json(res, 401, {
        error: 'Internal plane authentication is not configured',
        code: 'INTERNAL_AUTH_NOT_CONFIGURED',
      });
      return false;
    }
    const provided = String(
      req.headers['x-internal-token'] || req.headers['X-Internal-Token'] || '',
    );
    // Length is compared first: timingSafeEqual throws on unequal buffers, and
    // a length mismatch is not a secret worth protecting.
    if (
      provided.length !== token.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(token))
    ) {
      json(res, 401, { error: 'Invalid or missing internal token' });
      return false;
    }
    return true;
  };
}
