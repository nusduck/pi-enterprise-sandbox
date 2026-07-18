/**
 * Shared Pi JSONL v3 codec (PR-05).
 *
 * Single source of truth for materialization + checksum used by:
 * - AgentSessionSnapshotRepository
 * - PiSessionAdapter
 * - Pi session journal / recovery
 *
 * Checksum = SHA-256 of the exact deterministic materialized JSONL UTF-8 bytes.
 * Each JSONL line is recursive-canonical JSON (sorted object keys); array /
 * entries append order is preserved. MySQL JSON key reordering cannot change
 * verification because we always re-materialize from logical payload.
 *
 * SDK SessionManager.open silently skips malformed lines — validate fail-closed
 * **before** open.
 */

import { createHash } from 'node:crypto';
import { PiSessionAdapterError } from './errors.js';

/** Matches CURRENT_SESSION_VERSION from @earendil-works/pi-coding-agent@0.80.3. */
export const PI_SESSION_JSONL_VERSION = 3;

/**
 * Exact SessionEntry type union for v3 (plus header type "session").
 * @see SessionManager session-manager.d.ts SessionEntry
 */
export const PI_JSONL_ENTRY_TYPES = Object.freeze([
  'message',
  'thinking_level_change',
  'model_change',
  'compaction',
  'branch_summary',
  'custom',
  'custom_message',
  'label',
  'session_info',
]);

export const PI_JSONL_ENTRY_TYPE_SET = new Set(PI_JSONL_ENTRY_TYPES);

/** Default max JSONL UTF-8 bytes. */
export const DEFAULT_MAX_JSONL_BYTES = 8 * 1024 * 1024;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursive canonical form: sorted object keys; array order preserved.
 * @param {unknown} value
 * @param {WeakSet<object>} [stack]
 * @returns {unknown}
 */
export function canonicalizeForJsonl(value, stack = new WeakSet()) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new PiSessionAdapterError('non-finite numbers are not supported in JSONL', {
        code: 'PI_JSONL_CANONICALIZE_ERROR',
      });
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (t !== 'object') {
    throw new PiSessionAdapterError(`unsupported JSONL value type: ${t}`, {
      code: 'PI_JSONL_CANONICALIZE_ERROR',
    });
  }
  const obj = /** @type {object} */ (value);
  if (stack.has(obj)) {
    throw new PiSessionAdapterError('circular reference is not supported in JSONL', {
      code: 'PI_JSONL_CANONICALIZE_ERROR',
    });
  }
  stack.add(obj);
  try {
    if (Array.isArray(value)) {
      return value.map((v) => canonicalizeForJsonl(v, stack));
    }
    if (!isPlainObject(value)) {
      const keys = Object.keys(/** @type {object} */ (value)).sort();
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const k of keys) {
        const v = /** @type {Record<string, unknown>} */ (value)[k];
        if (v === undefined) continue;
        out[k] = canonicalizeForJsonl(v, stack);
      }
      return out;
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.keys(/** @type {object} */ (value)).sort()) {
      const v = /** @type {Record<string, unknown>} */ (value)[k];
      if (v === undefined) continue;
      out[k] = canonicalizeForJsonl(v, stack);
    }
    return out;
  } finally {
    stack.delete(obj);
  }
}

/**
 * Deterministic JSON string for one JSONL line (sorted keys, no whitespace variance).
 * @param {unknown} value
 * @returns {string}
 */
export function serializeJsonlLine(value) {
  return JSON.stringify(canonicalizeForJsonl(value));
}

/**
 * @param {{ header: object, entries: object[] }} payload
 * @returns {{ header: object, entries: object[] }}
 */
export function normalizePayload(payload) {
  return validateSnapshotPayload(payload);
}

/**
 * Fail-closed validation of logical snapshot payload (header + entries).
 * @param {unknown} payload
 * @returns {{ header: Record<string, unknown>, entries: Record<string, unknown>[] }}
 */
export function validateSnapshotPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PiSessionAdapterError('snapshot payload must be an object', {
      code: 'PI_SNAPSHOT_PAYLOAD_INVALID',
    });
  }
  const p = /** @type {Record<string, unknown>} */ (payload);
  const header = validateHeader(p.header);
  if (!Array.isArray(p.entries)) {
    throw new PiSessionAdapterError('snapshot payload.entries must be an array', {
      code: 'PI_SNAPSHOT_PAYLOAD_INVALID',
    });
  }
  const entries = validateEntries(/** @type {unknown[]} */ (p.entries));
  return { header, entries };
}

/**
 * @param {unknown} header
 * @returns {Record<string, unknown>}
 */
export function validateHeader(header) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new PiSessionAdapterError('snapshot header is required', {
      code: 'PI_JSONL_HEADER_INVALID',
    });
  }
  const h = /** @type {Record<string, unknown>} */ (header);
  if (h.type !== 'session') {
    throw new PiSessionAdapterError('header.type must be "session"', {
      code: 'PI_JSONL_HEADER_INVALID',
    });
  }
  const version = Number(h.version);
  if (version !== PI_SESSION_JSONL_VERSION) {
    throw new PiSessionAdapterError(
      `header.version must be ${PI_SESSION_JSONL_VERSION}, got ${String(h.version)}`,
      { code: 'PI_SNAPSHOT_VERSION_INCOMPATIBLE' },
    );
  }
  if (typeof h.id !== 'string' || !h.id.trim()) {
    throw new PiSessionAdapterError('header.id must be a non-empty string', {
      code: 'PI_JSONL_HEADER_INVALID',
    });
  }
  if (typeof h.timestamp !== 'string' || !h.timestamp.trim()) {
    throw new PiSessionAdapterError('header.timestamp must be a non-empty string', {
      code: 'PI_JSONL_HEADER_INVALID',
    });
  }
  if (typeof h.cwd !== 'string') {
    throw new PiSessionAdapterError('header.cwd must be a string', {
      code: 'PI_JSONL_HEADER_INVALID',
    });
  }
  return h;
}

/**
 * Walk parent chain: is `ancestorId` an ancestor of `nodeId` (or equal)?
 * @param {string} nodeId
 * @param {string} ancestorId
 * @param {Map<string, string | null>} parentOf
 */
export function isAncestorOrSelf(nodeId, ancestorId, parentOf) {
  if (nodeId === ancestorId) return true;
  /** @type {Set<string>} */
  const seen = new Set();
  let cur = /** @type {string | null | undefined} */ (nodeId);
  while (cur != null) {
    if (cur === ancestorId) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    if (!parentOf.has(cur)) return false;
    cur = parentOf.get(cur);
  }
  return false;
}

/**
 * Leaf entry id in append order: last entry that is not a parent of any later entry.
 * Empty → null (manifest may be sole root).
 *
 * @param {Array<{ id: string, parentId?: string | null }>} entries
 * @returns {string | null}
 */
export function findLeafEntryId(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  /** @type {Set<string>} */
  const usedAsParent = new Set();
  for (const e of entries) {
    if (e && e.parentId != null && typeof e.parentId === 'string') {
      usedAsParent.add(e.parentId);
    }
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e && typeof e.id === 'string' && !usedAsParent.has(e.id)) {
      return e.id;
    }
  }
  return String(entries[entries.length - 1].id);
}

/**
 * Validate entry list: exact type union, unique nonempty ids, strict parent chain.
 * - parentId is a required own-property (null or prior id)
 * - at most one null root, and only as the first entry
 * - compaction.firstKeptEntryId / branch_summary.fromId must reference prior ids
 * - firstKeptEntryId must lie on ancestry of the compaction's parent chain
 *
 * Preserves full toolCall / toolResult / compaction / branch / custom payloads.
 *
 * @param {unknown[]} entries
 * @returns {Record<string, unknown>[]}
 */
export function validateEntries(entries) {
  /** @type {Record<string, unknown>[]} */
  const out = [];
  /** @type {Set<string>} */
  const seenIds = new Set();
  /** @type {Map<string, string | null>} */
  const parentOf = new Map();
  let nullRootSeen = false;

  for (let i = 0; i < entries.length; i += 1) {
    const raw = entries[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new PiSessionAdapterError(`entries[${i}] must be an object`, {
        code: 'PI_SNAPSHOT_ENTRY_INVALID',
      });
    }
    const e = /** @type {Record<string, unknown>} */ (raw);
    const type = e.type;
    if (typeof type !== 'string' || !PI_JSONL_ENTRY_TYPE_SET.has(type)) {
      throw new PiSessionAdapterError(
        `entries[${i}].type unknown or missing: ${String(type)}`,
        { code: 'PI_SNAPSHOT_ENTRY_UNKNOWN_TYPE' },
      );
    }
    if (typeof e.id !== 'string' || !e.id.trim()) {
      throw new PiSessionAdapterError(`entries[${i}].id must be a non-empty string`, {
        code: 'PI_SNAPSHOT_ENTRY_INVALID',
      });
    }
    const id = e.id;
    if (seenIds.has(id)) {
      throw new PiSessionAdapterError(`duplicate entry id: ${id}`, {
        code: 'PI_SNAPSHOT_ENTRY_DUPLICATE_ID',
      });
    }

    // parentId must be an explicit own-property (null root or prior id).
    if (!Object.prototype.hasOwnProperty.call(e, 'parentId')) {
      throw new PiSessionAdapterError(
        `entries[${i}].parentId is required (own property; use null for the single root)`,
        { code: 'PI_SNAPSHOT_ENTRY_PARENT_REQUIRED' },
      );
    }

    if (e.parentId === null) {
      if (i !== 0 || nullRootSeen) {
        throw new PiSessionAdapterError(
          `entries[${i}].parentId null root only allowed as the first entry (at most one root)`,
          { code: 'PI_SNAPSHOT_ENTRY_MULTI_ROOT' },
        );
      }
      nullRootSeen = true;
    } else if (typeof e.parentId === 'string' && e.parentId.trim()) {
      if (!seenIds.has(e.parentId)) {
        throw new PiSessionAdapterError(
          `entries[${i}].parentId ${e.parentId} does not reference a prior entry`,
          { code: 'PI_SNAPSHOT_ENTRY_ORPHAN' },
        );
      }
    } else {
      throw new PiSessionAdapterError(
        `entries[${i}].parentId must be null or a non-empty string`,
        { code: 'PI_SNAPSHOT_ENTRY_ORPHAN' },
      );
    }

    if (typeof e.timestamp !== 'string' || !e.timestamp.trim()) {
      throw new PiSessionAdapterError(
        `entries[${i}].timestamp must be a non-empty string`,
        { code: 'PI_SNAPSHOT_ENTRY_INVALID' },
      );
    }

    if (type === 'message') {
      if (!e.message || typeof e.message !== 'object') {
        throw new PiSessionAdapterError(`entries[${i}].message is required`, {
          code: 'PI_SNAPSHOT_ENTRY_INVALID',
        });
      }
    }

    if (type === 'compaction') {
      if (typeof e.summary !== 'string' || typeof e.firstKeptEntryId !== 'string') {
        throw new PiSessionAdapterError(
          `entries[${i}] compaction requires summary and firstKeptEntryId`,
          { code: 'PI_SNAPSHOT_ENTRY_INVALID' },
        );
      }
      if (!seenIds.has(e.firstKeptEntryId)) {
        throw new PiSessionAdapterError(
          `entries[${i}].firstKeptEntryId ${e.firstKeptEntryId} does not reference a prior entry`,
          { code: 'PI_SNAPSHOT_ENTRY_COMPACTION_INVALID' },
        );
      }
      // firstKeptEntryId must be on the ancestry of this entry's parent (or be parent).
      const parentId = /** @type {string | null} */ (e.parentId);
      if (parentId != null) {
        if (!isAncestorOrSelf(parentId, e.firstKeptEntryId, parentOf)) {
          throw new PiSessionAdapterError(
            `entries[${i}].firstKeptEntryId ${e.firstKeptEntryId} is not on the parent ancestry chain`,
            { code: 'PI_SNAPSHOT_ENTRY_COMPACTION_INVALID' },
          );
        }
      }
    }

    if (type === 'branch_summary') {
      if (typeof e.fromId !== 'string' || typeof e.summary !== 'string') {
        throw new PiSessionAdapterError(
          `entries[${i}] branch_summary requires fromId and summary`,
          { code: 'PI_SNAPSHOT_ENTRY_INVALID' },
        );
      }
      if (!seenIds.has(e.fromId)) {
        throw new PiSessionAdapterError(
          `entries[${i}].fromId ${e.fromId} does not reference a prior entry`,
          { code: 'PI_SNAPSHOT_ENTRY_BRANCH_INVALID' },
        );
      }
    }

    // Non-empty sessions must start with a null root.
    if (i === 0 && e.parentId !== null) {
      throw new PiSessionAdapterError(
        'entries[0].parentId must be null (single root)',
        { code: 'PI_SNAPSHOT_ENTRY_MULTI_ROOT' },
      );
    }

    seenIds.add(id);
    parentOf.set(id, /** @type {string | null} */ (e.parentId));
    out.push(e);
  }
  return out;
}

/**
 * Materialize complete version-3 Pi JSONL text (header first, then entries).
 * Each line uses deterministic canonical serialization.
 *
 * @param {unknown} payload
 * @param {{ maxBytes?: number }} [opts]
 * @returns {string}
 */
export function materializeJsonl(payload, opts = {}) {
  const { header, entries } = validateSnapshotPayload(payload);
  const lines = [serializeJsonlLine(header)];
  for (const entry of entries) {
    lines.push(serializeJsonlLine(entry));
  }
  const text = `${lines.join('\n')}\n`;
  const max = opts.maxBytes ?? DEFAULT_MAX_JSONL_BYTES;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > max) {
    throw new PiSessionAdapterError(
      `JSONL exceeds max size ${max} bytes`,
      { code: 'PI_JSONL_TOO_LARGE' },
    );
  }
  return text;
}

/**
 * SHA-256 hex of exact UTF-8 JSONL bytes.
 * @param {string} jsonlText
 * @returns {string}
 */
export function checksumJsonl(jsonlText) {
  if (typeof jsonlText !== 'string') {
    throw new PiSessionAdapterError('checksumJsonl requires a string', {
      code: 'PI_JSONL_CHECKSUM_INVALID',
    });
  }
  return createHash('sha256').update(jsonlText, 'utf8').digest('hex');
}

/**
 * SHA-256 of materializeJsonl(payload) — shared repository/adapter contract.
 * @param {unknown} payload
 * @returns {string}
 */
export function checksumSnapshotPayload(payload) {
  return checksumJsonl(materializeJsonl(payload));
}

/**
 * @param {{ snapshotJson?: unknown, checksum?: string } | null | undefined} snapshot
 * @returns {boolean}
 */
export function verifySnapshotChecksum(snapshot) {
  if (!snapshot?.snapshotJson || !snapshot.checksum) return false;
  try {
    const actual = checksumSnapshotPayload(snapshot.snapshotJson).toLowerCase();
    return actual === String(snapshot.checksum).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Parse JSONL text and validate fail-closed.
 * @param {string} jsonlText
 * @returns {{ header: object, entries: object[] }}
 */
export function parseAndValidateJsonl(jsonlText) {
  if (typeof jsonlText !== 'string' || !jsonlText.trim()) {
    throw new PiSessionAdapterError('JSONL text is required', {
      code: 'PI_JSONL_PARSE_ERROR',
    });
  }
  const lines = jsonlText.split('\n').filter((l) => l.trim().length > 0);
  if (!lines.length) {
    throw new PiSessionAdapterError('JSONL has no lines', {
      code: 'PI_JSONL_PARSE_ERROR',
    });
  }
  /** @type {unknown[]} */
  const parsed = [];
  for (let i = 0; i < lines.length; i += 1) {
    try {
      parsed.push(JSON.parse(lines[i]));
    } catch (err) {
      throw new PiSessionAdapterError(
        `JSONL line ${i + 1} is not valid JSON`,
        { code: 'PI_JSONL_PARSE_ERROR', cause: err },
      );
    }
  }
  const header = parsed[0];
  const entries = parsed.slice(1);
  return validateSnapshotPayload({ header, entries });
}

/**
 * @param {{ id: string, cwd: string, timestamp?: string }} opts
 */
export function buildSessionHeader(opts) {
  return {
    type: 'session',
    version: PI_SESSION_JSONL_VERSION,
    id: String(opts.id),
    timestamp: opts.timestamp || new Date().toISOString(),
    cwd: String(opts.cwd ?? ''),
  };
}
