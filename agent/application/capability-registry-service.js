/**
 * Session-scoped dynamic capability registry + process-local latest snapshot store.
 *
 * "Dynamic registration" means reconciling allowed runtime resources into an
 * authoritative inventory — not arbitrary extension download/install.
 */

import {
  redactEmbeddedHostPaths,
  redactSecretText,
  sanitizeUntrustedText,
} from '../lib/text-redaction.js';

export { redactEmbeddedHostPaths, redactSecretText } from '../lib/text-redaction.js';

export const CAPABILITY_KINDS = Object.freeze([
  'skill',
  'tool',
  'extension',
  'mcp_server',
  'mcp_tool',
]);

export const CAPABILITY_STATUSES = Object.freeze([
  'configured',
  'active',
  'disabled',
  'failed',
]);

const KIND_ORDER = Object.freeze(
  Object.fromEntries(CAPABILITY_KINDS.map((kind, index) => [kind, index])),
);

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const MAX_DESCRIPTION = 480;
const MAX_SOURCE = 240;
const MAX_NAME = 128;
const MAX_METADATA_STRING = 240;
const MAX_METADATA_KEYS = 16;
const MAX_SNAPSHOTS = 32;
const MAX_QUERY = 128;
const MAX_CURSOR = 128;
const MAX_DESCRIBE_ECHO = 128;

const SECRET_KEY_RE =
  /(password|passwd|secret|token|api[_-]?key|authorization|credential|cookie|private[_-]?key|access[_-]?key)/i;

const FORBIDDEN_METADATA_KEYS = new Set([
  'auth',
  'authorization',
  'headers',
  'env',
  'environment',
  'credentials',
  'credential',
  'token',
  'api_key',
  'apiKey',
  'password',
  'secret',
  'body',
  'content',
  'schema',
  'input_schema',
  'parameters',
  'arguments',
  'skill_body',
  'file_content',
]);

/** Per-kind allowlisted metadata keys (safe for model + diagnostics). */
export const METADATA_ALLOWLIST = Object.freeze({
  skill: Object.freeze([
    'path',
    'package_name',
    'skill_root',
    'category',
    'shared',
    'reason',
  ]),
  tool: Object.freeze([
    'category',
    'registered_name',
    'risk_level',
    'side_effect',
    'reason',
  ]),
  extension: Object.freeze(['package', 'path', 'reason', 'error']),
  mcp_server: Object.freeze([
    'server_id',
    'transport',
    'authorization',
    'tool_count',
    'connection_status',
    'reason',
    'error',
  ]),
  mcp_tool: Object.freeze([
    'server_id',
    'tool_key',
    'registered_name',
    'risk_level',
    'side_effect',
    'reason',
  ]),
});

function nowIso() {
  return new Date().toISOString();
}

function clampString(value, max) {
  if (value == null) return undefined;
  const text = String(value);
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Logical skill roots safe to expose to models/operators. */
export const LOGICAL_SKILL_ROOTS = Object.freeze([
  '/home/sandbox/skill',
  '/sandbox/skills',
  '/app/.pi/skills',
]);

/** Live owner scopes supersede profile-seeded entries of the same kind. */
const LIVE_RECONCILE_SCOPES = new Set([
  'resource_loader',
  'session_tools',
  'session_extensions',
  'extension_factories',
  'mcp_discovery',
]);

/**
 * Stable identity within one registry.
 * Always `kind:name` — callers cannot inject cross-kind ids.
 * @param {string} kind
 * @param {string} name
 */
export function capabilityId(kind, name) {
  return `${kind}:${name}`;
}

/**
 * Normalize source/path labels so physical host paths never enter the registry.
 * Keeps stable logical roots and enterprise package labels.
 *
 * @param {unknown} value
 * @param {{ field?: 'source'|'path' }} [opts]
 * @returns {string|undefined}
 */
function boundSanitizedLocation(value, opts = {}) {
  const max = opts.field === 'source' ? MAX_SOURCE : MAX_METADATA_STRING;
  return sanitizeUntrustedText(value, max) || undefined;
}

export function sanitizeCapabilityLocation(value, opts = {}) {
  if (value == null) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;

  const normalized = raw.replace(/\\/g, '/');

  // Stable logical skill roots (and package under them).
  for (const root of LOGICAL_SKILL_ROOTS) {
    if (normalized === root || normalized.startsWith(`${root}/`)) {
      return boundSanitizedLocation(normalized, opts);
    }
  }

  // Package-bundled skills inside the enterprise kit (any install prefix).
  const kitSkillIdx = normalized.indexOf('/enterprise-agent-kit/skills');
  if (kitSkillIdx >= 0) {
    const tail = normalized.slice(kitSkillIdx + '/enterprise-agent-kit/'.length);
    return boundSanitizedLocation(`enterprise-agent-kit/${tail}`, opts);
  }
  if (normalized.includes('enterprise-agent-kit/skills')) {
    const m = normalized.match(/enterprise-agent-kit\/skills(?:\/.*)?$/);
    if (m) {
      return boundSanitizedLocation(m[0], opts);
    }
  }

  // Known non-path sources.
  if (
    /^(agent-profile|agent-profile\/|pi-session|pi-extension|mcp:|mcp-connection-manager|enterprise-agent-kit|resource-loader|unknown|sandbox|shared)/i.test(
      normalized,
    )
  ) {
    return boundSanitizedLocation(normalized, opts);
  }

  // Absolute host paths (macOS /Users, /var/folders, /private, Windows drives, etc.)
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith('//')
  ) {
    return opts.field === 'path' ? undefined : 'host-path-redacted';
  }

  // Relative / opaque labels — still secret-redacted and bounded.
  return boundSanitizedLocation(normalized, opts);
}

/**
 * Sanitize metadata to allowlisted keys and bounded plain values.
 * Path-like fields are location-sanitized centrally.
 * @param {string} kind
 * @param {Record<string, unknown>|null|undefined} metadata
 */
export function sanitizeCapabilityMetadata(kind, metadata) {
  if (!isPlainObject(metadata)) return {};
  const allow = new Set(METADATA_ALLOWLIST[kind] || []);
  const out = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(metadata)) {
    if (count >= MAX_METADATA_KEYS) break;
    const key = String(rawKey || '').trim();
    if (!key || !allow.has(key)) continue;
    if (FORBIDDEN_METADATA_KEYS.has(key) || SECRET_KEY_RE.test(key)) continue;
    if (rawValue == null) continue;
    if (typeof rawValue === 'boolean' || typeof rawValue === 'number') {
      if (typeof rawValue === 'number' && !Number.isFinite(rawValue)) continue;
      out[key] = rawValue;
      count += 1;
      continue;
    }
    if (typeof rawValue === 'string') {
      let text =
        key === 'path' || key === 'skill_root'
          ? sanitizeCapabilityLocation(rawValue, { field: 'path' })
          : sanitizeUntrustedText(rawValue, MAX_METADATA_STRING);
      if (key === 'error' || key === 'reason') {
        text = sanitizeUntrustedText(rawValue, MAX_METADATA_STRING);
      }
      if (text != null && text !== '') {
        out[key] = text;
        count += 1;
      }
      continue;
    }
  }
  return out;
}

/**
 * Normalize one capability entry for storage / export.
 * Identity is always derived from kind+name (input.id is ignored).
 * @param {object} input
 */
export function normalizeCapabilityEntry(input = {}) {
  const kind = String(input.kind || '').trim();
  if (!kind) {
    throw new Error('Capability kind is required');
  }
  // Allow future kinds beyond the seed set while still validating shape.
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(kind)) {
    throw new Error(`Invalid capability kind: ${kind}`);
  }
  const name = clampString(input.name, MAX_NAME);
  if (!name) throw new Error('Capability name is required');
  const status = CAPABILITY_STATUSES.includes(input.status)
    ? input.status
    : 'configured';
  // Canonical identity — never trust caller-supplied cross-kind ids.
  const id = capabilityId(kind, name);
  const source =
    sanitizeCapabilityLocation(input.source, { field: 'source' }) || 'unknown';
  const description = sanitizeUntrustedText(input.description, MAX_DESCRIPTION) || '';
  return {
    id,
    kind,
    name,
    status,
    source,
    description: description || '',
    profile_id: input.profile_id || input.profileId || null,
    dynamic: Boolean(input.dynamic),
    metadata: sanitizeCapabilityMetadata(kind, input.metadata),
    updated_at: input.updated_at || nowIso(),
    scope: clampString(input.scope, 64) || 'default',
  };
}

function compareEntries(a, b) {
  const ka = KIND_ORDER[a.kind] ?? 1000;
  const kb = KIND_ORDER[b.kind] ?? 1000;
  if (ka !== kb) return ka - kb;
  return a.name.localeCompare(b.name);
}

function boundLimit(limit, fallback, max) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function boundQueryText(value, max = MAX_QUERY) {
  return sanitizeUntrustedText(String(value || '').trim(), max) || '';
}

function boundNameText(value) {
  return sanitizeUntrustedText(String(value || '').trim(), MAX_NAME) || '';
}

function boundDescribeEcho(value) {
  return sanitizeUntrustedText(String(value || '').trim(), MAX_DESCRIBE_ECHO) || '';
}

function scoreSearch(entry, words) {
  if (!words.length) return 1;
  const name = entry.name.toLowerCase();
  const desc = (entry.description || '').toLowerCase();
  const id = entry.id.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (name === word) score += 8;
    else if (name.includes(word)) score += 4;
    else if (id.includes(word)) score += 3;
    else if (desc.includes(word)) score += 1;
  }
  return score;
}

/**
 * Create a mutable session-scoped capability registry.
 * @param {{
 *   profileId?: string|null,
 *   runId?: string|null,
 *   conversationId?: string|null,
 *   sessionId?: string|null,
 *   workspaceId?: string|null,
 *   ownerUserId?: string|null,
 *   organizationId?: string|null,
 *   onChange?: ((event: object) => void)|null,
 * }} [options]
 */
export function createCapabilityRegistry(options = {}) {
  /** @type {Map<string, ReturnType<typeof normalizeCapabilityEntry>>} */
  const entries = new Map();
  let version = 0;
  let lastReason = 'init';

  const scope = {
    profile_id: options.profileId || null,
    run_id: options.runId || null,
    conversation_id: options.conversationId || null,
    session_id: options.sessionId || null,
    workspace_id: options.workspaceId || null,
  };

  /** Process-local partition keys — never exposed via list/search/describe. */
  const partition = {
    owner_user_id: options.ownerUserId || null,
    organization_id: options.organizationId || null,
  };

  function emitChange(reason, changedIds = []) {
    lastReason = reason;
    if (typeof options.onChange !== 'function') return;
    try {
      options.onChange({
        type: 'capability_registry_updated',
        reason,
        registry_version: version,
        changed_count: changedIds.length,
        changed_ids: changedIds.slice(0, 40),
        ...scope,
      });
    } catch {
      // Observer failures must not break registration.
    }
  }

  function bump(reason, changedIds) {
    if (!changedIds.length) return version;
    version += 1;
    emitChange(reason, changedIds);
    return version;
  }

  function register(raw, reason = 'register') {
    const entry = normalizeCapabilityEntry({
      ...raw,
      profile_id: raw.profile_id || raw.profileId || scope.profile_id,
      updated_at: nowIso(),
    });
    const prev = entries.get(entry.id);
    if (
      prev &&
      prev.status === entry.status &&
      prev.source === entry.source &&
      prev.description === entry.description &&
      prev.dynamic === entry.dynamic &&
      prev.scope === entry.scope &&
      JSON.stringify(prev.metadata) === JSON.stringify(entry.metadata)
    ) {
      return prev;
    }
    entries.set(entry.id, entry);
    bump(reason, [entry.id]);
    return entry;
  }

  function unregister(idOrKind, maybeName, reason = 'unregister') {
    const id =
      maybeName != null
        ? capabilityId(String(idOrKind), String(maybeName))
        : String(idOrKind);
    if (!entries.has(id)) return false;
    entries.delete(id);
    bump(reason, [id]);
    return true;
  }

  /**
   * Atomically replace all entries of `kind` owned by `ownerScope`.
   *
   * Live scopes (resource_loader, session_tools, extension_factories,
   * mcp_discovery, …) also supersede profile-seeded entries of the same kind
   * so stale configured stubs cannot outlive the effective live set.
   *
   * @param {string} kind
   * @param {object[]} nextEntries
   * @param {string} ownerScope
   * @param {string} [reason]
   */
  function reconcile(kind, nextEntries, ownerScope, reason = 'reconcile') {
    const scopeKey = clampString(ownerScope, 64) || 'default';
    const liveScope = LIVE_RECONCILE_SCOPES.has(scopeKey);
    const normalized = (Array.isArray(nextEntries) ? nextEntries : []).map((item) =>
      normalizeCapabilityEntry({
        ...item,
        kind,
        // Force kind+name identity; drop any caller id.
        id: undefined,
        name: item.name,
        scope: scopeKey,
        profile_id: item.profile_id || item.profileId || scope.profile_id,
        updated_at: nowIso(),
      }),
    );
    const nextIds = new Set(normalized.map((e) => e.id));
    const changed = [];

    for (const [id, existing] of entries) {
      if (existing.kind !== kind) continue;
      const existingScope = existing.scope || 'default';
      const sameScope = existingScope === scopeKey;
      const supersededProfile = liveScope && existingScope === 'profile';
      if (!sameScope && !supersededProfile) continue;
      if (!nextIds.has(id)) {
        entries.delete(id);
        changed.push(id);
      }
    }

    for (const entry of normalized) {
      const prev = entries.get(entry.id);
      if (
        !prev ||
        prev.status !== entry.status ||
        prev.source !== entry.source ||
        prev.description !== entry.description ||
        prev.dynamic !== entry.dynamic ||
        prev.scope !== entry.scope ||
        JSON.stringify(prev.metadata) !== JSON.stringify(entry.metadata)
      ) {
        entries.set(entry.id, entry);
        changed.push(entry.id);
      } else {
        // Keep previous updated_at when unchanged.
        entries.set(entry.id, prev);
      }
    }

    bump(reason, changed);
    return {
      version,
      changed: changed.length,
      count: normalized.length,
    };
  }

  function allSorted() {
    return [...entries.values()].sort(compareEntries);
  }

  function list(query = {}) {
    const limit = boundLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const kind = query.kind && query.kind !== 'all' ? String(query.kind) : null;
    const status = query.status ? String(query.status) : null;
    const cursor = query.cursor ? boundQueryText(query.cursor, MAX_CURSOR) : null;

    let items = allSorted();
    if (kind) items = items.filter((e) => e.kind === kind);
    if (status) items = items.filter((e) => e.status === status);
    if (Array.isArray(query.statuses) && query.statuses.length) {
      const allowed = new Set(query.statuses.map(String));
      items = items.filter((e) => allowed.has(e.status));
    }
    if (query.enabled_only || query.enabledOnly) {
      items = items.filter((e) => e.status === 'active' || e.status === 'configured');
    }

    let start = 0;
    if (cursor) {
      const idx = items.findIndex((e) => e.id === cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const page = items.slice(start, start + limit);
    const next =
      start + limit < items.length ? page[page.length - 1]?.id || null : null;

    return {
      action: 'list',
      registry_version: version,
      total: items.length,
      returned: page.length,
      next_cursor: next,
      items: page.map(toPublicEntry),
      ...scope,
    };
  }

  function search(query = {}) {
    const q = boundQueryText(query.query, MAX_QUERY);
    const limit = boundLimit(query.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const kind = query.kind && query.kind !== 'all' ? String(query.kind) : null;
    const words = q
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    let items = allSorted();
    if (kind) items = items.filter((e) => e.kind === kind);
    if (Array.isArray(query.statuses) && query.statuses.length) {
      const allowed = new Set(query.statuses.map(String));
      items = items.filter((e) => allowed.has(e.status));
    }
    if (query.enabled_only || query.enabledOnly) {
      items = items.filter((e) => e.status === 'active' || e.status === 'configured');
    }

    const scored = items
      .map((entry) => ({ entry, score: scoreSearch(entry, words) }))
      .filter((row) => (words.length === 0 ? true : row.score > 0));

    const ranked = (scored.length ? scored : items.map((entry) => ({ entry, score: 0 })))
      .sort(
        (a, b) =>
          b.score - a.score ||
          compareEntries(a.entry, b.entry),
      )
      .slice(0, limit);

    return {
      action: 'search',
      query: q,
      registry_version: version,
      total: items.length,
      matched: scored.length || (words.length ? 0 : items.length),
      returned: ranked.length,
      items: ranked.map(({ entry, score }) => ({
        ...toPublicEntry(entry),
        score,
      })),
      note:
        words.length && !scored.length
          ? 'no keyword match; returning ranked inventory'
          : undefined,
      ...scope,
    };
  }

  function describe(query = {}) {
    const boundedId = query.id ? boundQueryText(query.id, MAX_NAME) : null;
    const boundedName = query.name ? boundNameText(query.name) : null;
    const id =
      boundedId ||
      (query.kind && boundedName
        ? capabilityId(String(query.kind), boundedName)
        : null);
    if (!id) {
      return {
        action: 'describe',
        error: 'kind+name or id is required',
        registry_version: version,
        ...scope,
      };
    }
    let entry = entries.get(id);
    if (!entry && query.kind && boundedName) {
      // Allow name-only match within kind when id form differed.
      entry = allSorted().find(
        (e) => e.kind === String(query.kind) && e.name === boundedName,
      );
    }
    if (!entry && boundedName) {
      const matches = allSorted().filter((e) => e.name === boundedName);
      if (matches.length === 1) entry = matches[0];
      else if (matches.length > 1) {
        return {
          action: 'describe',
          error: `Ambiguous capability name: ${boundDescribeEcho(boundedName)}`,
          matches: matches.map((e) => e.id),
          registry_version: version,
          ...scope,
        };
      }
    }
    if (!entry) {
      return {
        action: 'describe',
        error: `Unknown capability: ${boundDescribeEcho(id)}`,
        registry_version: version,
        ...scope,
      };
    }
    return {
      action: 'describe',
      registry_version: version,
      entry: toPublicEntry(entry),
      ...scope,
    };
  }

  function snapshot(reason = lastReason) {
    const items = allSorted().map(toPublicEntry);
    return {
      registry_version: version,
      reason,
      generated_at: nowIso(),
      live: true,
      counts: countByKindAndStatus(items),
      entries: items,
      ...scope,
      ...partition,
    };
  }

  function getVersion() {
    return version;
  }

  function size() {
    return entries.size;
  }

  function get(id) {
    return entries.get(id) || null;
  }

  return {
    register,
    unregister,
    reconcile,
    list,
    search,
    describe,
    snapshot,
    getVersion,
    size,
    get,
    scope: () => ({ ...scope }),
  };
}

function toPublicEntry(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    status: entry.status,
    source: entry.source,
    description: entry.description,
    profile_id: entry.profile_id,
    dynamic: entry.dynamic,
    metadata: { ...entry.metadata },
    updated_at: entry.updated_at,
  };
}

function countByKindAndStatus(items) {
  const counts = {};
  for (const item of items) {
    counts[item.kind] = counts[item.kind] || { total: 0 };
    counts[item.kind].total += 1;
    counts[item.kind][item.status] = (counts[item.kind][item.status] || 0) + 1;
  }
  return counts;
}

function deepFreeze(value) {
  if (value == null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

function freezeSnapshot(snapshot) {
  const entries = Object.freeze(
    [...(snapshot.entries || [])].map((entry) =>
      deepFreeze(
        Object.freeze({
          ...entry,
          metadata: Object.freeze({ ...(entry.metadata || {}) }),
        }),
      ),
    ),
  );
  const counts = deepFreeze(
    Object.freeze(
      Object.fromEntries(
        Object.entries(snapshot.counts || {}).map(([kind, stats]) => [
          kind,
          Object.freeze({ ...(stats || {}) }),
        ]),
      ),
    ),
  );
  return deepFreeze(
    Object.freeze({
      ...snapshot,
      entries,
      counts,
    }),
  );
}

/**
 * Process-local store of immutable sanitized snapshots (latest + short history).
 * @param {{ maxSnapshots?: number }} [options]
 */
export function createLatestCapabilitySnapshotStore(options = {}) {
  const maxSnapshots = Math.max(1, Number(options.maxSnapshots) || MAX_SNAPSHOTS);
  /** @type {Map<string, object>} run_id -> snapshot */
  const byRun = new Map();
  /** @type {object[]} */
  let recent = [];
  let latest = null;

  function publish(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const frozen = freezeSnapshot(snapshot);
    if (frozen.run_id) {
      byRun.set(String(frozen.run_id), frozen);
      // Bound run map size
      if (byRun.size > maxSnapshots) {
        const first = byRun.keys().next().value;
        if (first != null) byRun.delete(first);
      }
    }
    recent = [frozen, ...recent.filter((s) => s.run_id !== frozen.run_id)].slice(
      0,
      maxSnapshots,
    );
    latest = frozen;
    return frozen;
  }

  /**
   * @param {{
   *   profileId?: string|null,
   *   ownerUserId?: string|null,
   *   organizationId?: string|null,
   * }} [filter]
   * When profileId is supplied, only an exact profile_id match is returned
   * (null-profile snapshots never satisfy a profile filter).
   * When ownerUserId and/or organizationId are supplied, only exact matches
   * are returned (null-owner snapshots never satisfy an owner filter).
   */
  function getLatest(filter = {}) {
    const wantsProfile =
      filter.profileId != null && String(filter.profileId) !== '';
    const wantsOwner =
      filter.ownerUserId != null && String(filter.ownerUserId) !== '';
    const wantsOrg =
      filter.organizationId != null && String(filter.organizationId) !== '';

    if (!wantsProfile && !wantsOwner && !wantsOrg) {
      return latest || null;
    }

    const matches = (snapshot) => {
      if (!snapshot) return false;
      if (wantsProfile && snapshot.profile_id !== String(filter.profileId)) {
        return false;
      }
      if (wantsOwner) {
        const owner = snapshot.owner_user_id;
        if (owner == null || String(owner) !== String(filter.ownerUserId)) {
          return false;
        }
      }
      if (wantsOrg) {
        const org = snapshot.organization_id;
        if (org == null || String(org) !== String(filter.organizationId)) {
          return false;
        }
      }
      return true;
    };

    if (latest && matches(latest)) return latest;
    return recent.find(matches) || null;
  }

  function getByRunId(runId) {
    if (!runId) return null;
    return byRun.get(String(runId)) || null;
  }

  function clear() {
    byRun.clear();
    recent = [];
    latest = null;
  }

  return {
    publish,
    getLatest,
    getByRunId,
    clear,
    size: () => recent.length,
  };
}

/** Shared process-local store used by runtime + diagnostics. */
export const latestCapabilitySnapshots = createLatestCapabilitySnapshotStore();

/**
 * Project a live registry snapshot into legacy diagnostics item shapes.
 * @param {object|null} snapshot
 * @param {string} kind
 */
export function snapshotEntriesByKind(snapshot, kind) {
  if (!snapshot?.entries) return [];
  return snapshot.entries.filter((e) => e.kind === kind);
}

/**
 * Map registry status to enabled boolean for legacy consumers.
 * @param {string} status
 */
export function statusToEnabled(status) {
  return status === 'active' || status === 'configured';
}

/**
 * Build tool/skill category helper for diagnostics.
 * @param {string} name
 */
export function toolCategory(name) {
  if (name === 'mcp' || name === 'capabilities' || String(name).startsWith('mcp_')) {
    return name === 'capabilities' ? 'introspection' : 'mcp';
  }
  if (name === 'task_plan' || name === 'ask_user' || name === 'context_compact') {
    return 'workflow';
  }
  if (String(name).startsWith('process_')) return 'process';
  if (String(name).startsWith('skill_')) return 'skill-management';
  if (name === 'submit_artifact') return 'artifact';
  return 'sandbox';
}

/**
 * Reconcile active Pi tools into the registry.
 * @param {ReturnType<typeof createCapabilityRegistry>} registry
 * @param {{ getAllTools?: () => object[], getActiveToolNames?: () => string[] }} session
 * @param {{ profileId?: string, source?: string }} [opts]
 */
export function reconcileSessionTools(registry, session, opts = {}) {
  if (!registry || !session) return null;
  const all =
    typeof session.getAllTools === 'function' ? session.getAllTools() || [] : [];
  const activeNames = new Set(
    typeof session.getActiveToolNames === 'function'
      ? session.getActiveToolNames() || []
      : all.map((t) => t.name),
  );
  const source = opts.source || 'pi-session';
  const entries = all.map((tool) => {
    const name = tool.name || tool.id;
    const active = activeNames.has(name);
    return {
      kind: 'tool',
      name,
      status: active ? 'active' : 'disabled',
      source: tool.sourceInfo?.path || tool.sourceInfo?.source || source,
      description: tool.description || '',
      dynamic: Boolean(String(name).startsWith('mcp_')),
      metadata: {
        category: toolCategory(name),
        registered_name: name,
      },
      profile_id: opts.profileId,
    };
  });
  // Also mark active names missing from getAllTools (defensive).
  for (const name of activeNames) {
    if (entries.some((e) => e.name === name)) continue;
    entries.push({
      kind: 'tool',
      name,
      status: 'active',
      source,
      description: '',
      dynamic: String(name).startsWith('mcp_'),
      metadata: { category: toolCategory(name), registered_name: name },
      profile_id: opts.profileId,
    });
  }
  return registry.reconcile('tool', entries, 'session_tools', 'session_tools');
}

/**
 * Reconcile resource-loader skills into the registry.
 * @param {ReturnType<typeof createCapabilityRegistry>} registry
 * @param {{ getSkills?: () => { skills?: object[] } }} resourceLoader
 * @param {{ profileId?: string, source?: string }} [opts]
 */
export function reconcileResourceLoaderSkills(registry, resourceLoader, opts = {}) {
  if (!registry) return null;
  const skills =
    typeof resourceLoader?.getSkills === 'function'
      ? resourceLoader.getSkills()?.skills || []
      : [];
  const entries = skills.map((skill) => ({
    kind: 'skill',
    name: skill.name,
    status: 'active',
    source: skill.baseDir || skill.sourceInfo?.path || opts.source || 'resource-loader',
    description: skill.description || '',
    dynamic: false,
    metadata: {
      path: skill.filePath || skill.path || undefined,
      package_name: skill.name,
    },
    profile_id: opts.profileId,
  }));
  return registry.reconcile('skill', entries, 'resource_loader', 'resource_loader');
}

/**
 * Publish registry snapshot to the process store and optional emit.
 * @param {ReturnType<typeof createCapabilityRegistry>} registry
 * @param {{ emit?: (e: object) => void, reason?: string, store?: ReturnType<typeof createLatestCapabilitySnapshotStore> }} [opts]
 */
export function publishCapabilitySnapshot(registry, opts = {}) {
  if (!registry) return null;
  const store = opts.store || latestCapabilitySnapshots;
  const snapshot = registry.snapshot(opts.reason || 'publish');
  const published = store.publish(snapshot);
  if (typeof opts.emit === 'function') {
    try {
      opts.emit({
        type: 'capability_registry_updated',
        reason: snapshot.reason,
        registry_version: snapshot.registry_version,
        counts: snapshot.counts,
        run_id: snapshot.run_id,
        conversation_id: snapshot.conversation_id,
        session_id: snapshot.session_id,
        profile_id: snapshot.profile_id,
        entry_count: snapshot.entries.length,
      });
    } catch {
      /* ignore */
    }
  }
  return published;
}
