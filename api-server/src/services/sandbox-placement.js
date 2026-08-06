/**
 * Which Sandbox replica holds a session's workspace.
 *
 * The Sandbox is sharded: a workspace is a directory on one replica's volume.
 * The BFF reaches the Sandbox through a Service, so a file listing or download
 * can land on any shard — and the wrong one resolves the session from MySQL
 * fine, then reads a directory that is not there. That used to answer 200 with
 * an empty result; the Sandbox now refuses it with 409, and this is how the BFF
 * avoids provoking that refusal in the first place.
 *
 * The BFF deliberately has no database of its own, so it asks the Agent, which
 * does. It then dials the owning replica **directly** rather than proxying
 * through the Agent: these routes stream 50 MB uploads and artifact downloads,
 * and a second hop would buy nothing but latency and memory.
 *
 * Placement is immutable for a session's lifetime, so a short cache removes
 * essentially all of the lookups.
 */

import { config } from '../config.js';

const DEFAULT_TTL_MS = 30_000;

/** @type {Map<string, { baseUrl: string, expiresAt: number }>} */
const cache = new Map();

function cacheKey(sessionId, auth) {
  // Scoped by actor: placement is looked up under owner scope, so one user's
  // answer must never be served to another.
  return `${auth?.organizationId ?? ''}:${auth?.userId ?? ''}:${sessionId}`;
}

/**
 * Base URL for session-scoped Sandbox calls.
 *
 * Falls back to the configured Service address whenever placement cannot be
 * resolved — an unplaced session, an Agent that cannot answer, a single-replica
 * deployment. That is the correct fallback: with one shard it is the same
 * address, and with several the Sandbox refuses loudly rather than answering
 * wrongly.
 *
 * @param {string} sessionId
 * @param {{ organizationId?: string, userId?: string }} auth
 * @param {{ fetchImpl?: typeof fetch, ttlMs?: number, now?: () => number }} [opts]
 * @returns {Promise<string>}
 */
export async function resolveSandboxBaseUrl(sessionId, auth, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const fallback = config.SANDBOX_BASE_URL;

  if (!sessionId || !auth?.organizationId || !auth?.userId) return fallback;

  const key = cacheKey(sessionId, auth);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) return hit.baseUrl;

  try {
    const url = new URL('/internal/sandbox-placement', config.AGENT_BASE_URL);
    url.searchParams.set('sandboxSessionId', sessionId);
    const headers = {
      accept: 'application/json',
      'X-Acting-Organization-Id': auth.organizationId,
      'X-Acting-User-Id': auth.userId,
    };
    if (config.AGENT_INTERNAL_TOKEN) {
      headers['X-Internal-Token'] = config.AGENT_INTERNAL_TOKEN;
    }
    const res = await fetchImpl(url, { headers });
    if (!res.ok) return fallback;
    const body = await res.json();
    if (!body?.baseUrl) return fallback;
    cache.set(key, { baseUrl: body.baseUrl, expiresAt: now() + ttlMs });
    return body.baseUrl;
  } catch {
    // Routing is best-effort. A wrong guess is refused by the Sandbox, never
    // silently served, so failing open here cannot corrupt anything.
    return fallback;
  }
}

/** Drop a cached answer, e.g. after the Sandbox reports a mismatch. */
export function invalidateSandboxPlacement(sessionId, auth) {
  cache.delete(cacheKey(sessionId, auth));
}

/** Test seam. */
export function _clearPlacementCache() {
  cache.clear();
}
