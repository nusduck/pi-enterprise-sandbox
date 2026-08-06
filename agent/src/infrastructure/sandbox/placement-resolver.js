/**
 * Where to send an internal Sandbox request.
 *
 * The Sandbox is sharded, not load balanced. A workspace is a directory on one
 * replica's volume and a managed process is a handle in one replica's memory,
 * so `SANDBOX_BASE_URL` as a single scalar is no longer meaningful: every
 * workspace-bound call has to reach the replica that owns that workspace.
 *
 * Resolution order:
 *
 * 1. **This process's cache** — placement is immutable for a session's
 *    lifetime, so a short TTL is plenty and the common case costs nothing.
 * 2. **MySQL** — the Agent already owns this database, so reading
 *    `sandbox_sessions.node_id` joined to `sandbox_nodes.address` is cheaper
 *    and more direct than asking the Sandbox where to go.
 * 3. **The discovery URL** — an unplaced session has no owner yet. Any replica
 *    can answer `sessions/ensure`, and answering it is what assigns one.
 *
 * The Sandbox is the authority, not this cache. A 409 PLACEMENT_MISMATCH means
 * our answer was stale (a scale event, a failover); the caller invalidates and
 * retries once against the address the owner named.
 *
 * HMAC binding is unaffected: `htu` covers the request path only, so changing
 * the host never invalidates a signature.
 */

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_SCHEME = 'http://';

/** @param {string} address bare `host` or `host:port` authority */
export function addressToBaseUrl(address, { scheme = DEFAULT_SCHEME } = {}) {
  const text = String(address ?? '').trim();
  if (!text) return null;
  if (text.includes('://')) {
    // The Sandbox publishes a bare authority. A scheme here means someone
    // configured a URL where an authority was expected; take it as given
    // rather than producing `http://https://…`.
    return text.replace(/\/+$/, '');
  }
  return `${scheme}${text}`.replace(/\/+$/, '');
}

/**
 * @param {object} options
 * @param {string} options.discoveryUrl base URL of the Sandbox Service (any replica)
 * @param {() => import('knex').Knex} [options.knexFactory] resolves the Agent database
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.clock]
 */
export function createSandboxPlacementResolver(options) {
  const discoveryUrl = String(options?.discoveryUrl ?? '').replace(/\/+$/, '');
  if (!discoveryUrl) {
    throw new Error('createSandboxPlacementResolver requires a discoveryUrl');
  }
  const knexFactory =
    typeof options?.knexFactory === 'function' ? options.knexFactory : null;
  const ttlMs = Number.isFinite(options?.ttlMs) ? Number(options.ttlMs) : DEFAULT_TTL_MS;
  const clock = typeof options?.clock === 'function' ? options.clock : Date.now;

  /** @type {Map<string, { baseUrl: string, expiresAt: number }>} */
  const cache = new Map();

  function cached(sandboxSessionId) {
    const hit = cache.get(sandboxSessionId);
    if (!hit) return null;
    if (hit.expiresAt <= clock()) {
      cache.delete(sandboxSessionId);
      return null;
    }
    return hit.baseUrl;
  }

  function remember(sandboxSessionId, baseUrl) {
    if (!sandboxSessionId || !baseUrl) return baseUrl;
    cache.set(sandboxSessionId, { baseUrl, expiresAt: clock() + ttlMs });
    return baseUrl;
  }

  async function loadFromDatabase(identity) {
    if (!knexFactory) return null;
    let knex;
    try {
      knex = knexFactory();
    } catch {
      return null;
    }
    if (!knex) return null;
    try {
      const row = await knex('sandbox_sessions as s')
        .leftJoin('sandbox_nodes as n', 'n.node_id', 's.node_id')
        .where('s.sandbox_session_id', identity.sandboxSessionId)
        .andWhere('s.org_id', identity.orgId)
        .andWhere('s.user_id', identity.userId)
        .first('s.node_id as nodeId', 'n.address as address');
      if (!row?.nodeId || !row?.address) return null;
      return addressToBaseUrl(row.address);
    } catch {
      // A placement lookup failure must not fail the tool call. Falling back to
      // discovery is safe: a misrouted request is refused with 409 rather than
      // silently served, and the retry carries the owner's real address.
      return null;
    }
  }

  async function loadArtifactStorage(artifactId, identity) {
    if (!knexFactory || !artifactId) return null;
    let knex;
    try {
      knex = knexFactory();
    } catch {
      return null;
    }
    if (!knex) return null;
    try {
      const row = await knex('artifacts as a')
        .leftJoin('sandbox_nodes as n', 'n.node_id', 'a.storage_node_id')
        .where('a.artifact_id', artifactId)
        .andWhere('a.org_id', identity.orgId)
        .andWhere('a.user_id', identity.userId)
        .first('a.storage_node_id as nodeId', 'n.address as address');
      if (!row?.nodeId || !row?.address) return null;
      return addressToBaseUrl(row.address);
    } catch {
      return null;
    }
  }

  return Object.freeze({
    /**
     * Base URL for a workspace-bound call. Falls back to discovery when the
     * session has no placement yet.
     *
     * @param {{ sandboxSessionId: string, orgId: string, userId: string }} identity
     */
    async resolve(identity) {
      const sandboxSessionId = identity?.sandboxSessionId;
      if (!sandboxSessionId) return discoveryUrl;
      const hit = cached(sandboxSessionId);
      if (hit) return hit;
      const resolved = await loadFromDatabase(identity);
      if (!resolved) return discoveryUrl;
      return remember(sandboxSessionId, resolved);
    },

    /**
     * Base URL for artifact bytes.
     *
     * Artifacts are routed by where the blob physically lives, not by the
     * workspace that produced it: a snapshot is immutable and outlives its
     * session, so the producing workspace may be long closed. Falls back to
     * the session's placement, then discovery.
     *
     * @param {string} artifactId
     * @param {{ sandboxSessionId?: string, orgId: string, userId: string }} identity
     */
    async resolveArtifact(artifactId, identity) {
      const stored = await loadArtifactStorage(artifactId, identity ?? {});
      if (stored) return stored;
      return this.resolve(identity ?? {});
    },

    /** Address of any replica — only `sessions/ensure` may use this. */
    discoveryBaseUrl() {
      return discoveryUrl;
    },

    /**
     * Adopt the owner a 409 PLACEMENT_MISMATCH named, so the retry lands.
     *
     * When the mismatch carries no address the entry is merely dropped: the
     * next attempt re-reads MySQL rather than guessing.
     *
     * @returns {string|null} base URL to retry against, if one was supplied
     */
    onMismatch(sandboxSessionId, ownerAddress) {
      if (!sandboxSessionId) return null;
      cache.delete(sandboxSessionId);
      const baseUrl = addressToBaseUrl(ownerAddress);
      if (!baseUrl) return null;
      return remember(sandboxSessionId, baseUrl);
    },

    invalidate(sandboxSessionId) {
      cache.delete(sandboxSessionId);
    },

    /** Test seam. */
    size() {
      return cache.size;
    },
  });
}

/**
 * Read a Sandbox 409 as a placement instruction.
 *
 * Returns null for anything else — including other 409s such as
 * SESSION_BINDING_CONFLICT, which are real conflicts and must not be retried.
 *
 * @param {number} status
 * @param {unknown} parsed decoded response body
 */
export function readPlacementMismatch(status, parsed) {
  if (status !== 409) return null;
  const detail =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed.detail ?? parsed)
      : null;
  if (!detail || typeof detail !== 'object') return null;
  if (detail.code !== 'PLACEMENT_MISMATCH') return null;
  return {
    ownerNodeId: typeof detail.ownerNodeId === 'string' ? detail.ownerNodeId : null,
    ownerAddress:
      typeof detail.ownerAddress === 'string' ? detail.ownerAddress : null,
  };
}

export const PLACEMENT_MISMATCH_CODE = 'PLACEMENT_MISMATCH';
export const DEFAULT_PLACEMENT_TTL_MS = DEFAULT_TTL_MS;
