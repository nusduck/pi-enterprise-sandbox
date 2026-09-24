/**
 * Shared session JSONL v3 codec (PR-05).
 *
 * Single source of truth for materialization + checksum used by:
 * - AgentSessionSnapshotRepository
 * - DshSessionAdapter
 * - DSH session journal / recovery
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
import { DshSessionAdapterError } from '../infrastructure/dsh/errors.js';

/** Session JSONL format version (header `version`). Inherited from the legacy engine; frozen for stored sessions. */
export const SESSION_JSONL_VERSION = 3;

/**
 * Exact SessionEntry type union for v3 (plus header type "session").
 * @see SessionManager session-manager.d.ts SessionEntry
 */
export const SESSION_JSONL_ENTRY_TYPES = Object.freeze([
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

export const SESSION_JSONL_ENTRY_TYPE_SET = new Set(SESSION_JSONL_ENTRY_TYPES);

/** Default max JSONL UTF-8 bytes. */
export const DEFAULT_MAX_JSONL_BYTES = 8 * 1024 * 1024;

/**
 * @param value
 * @returns {boolean}
 */
function isPlainObject(value: unknown) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursive canonical form: sorted object keys; array order preserved.
 * @param value
 * @param [stack]
 * @returns {unknown}
 */
export function canonicalizeForJsonl(value: unknown, stack: WeakSet<Record<string, any>> = new WeakSet()) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new DshSessionAdapterError('non-finite numbers are not supported in JSONL', {
        code: 'SESSION_JSONL_CANONICALIZE_ERROR',
      });
    }
    if (Object.is(value, -0)) return 0;
    // MySQL JSON columns re-parse doubles with a slightly different binary
    // representation for some fractional values (e.g. cost floats from model
    // usage). Journal payloadHash is SHA-256 over this canonical form, so a
    // one-ULP drift after insert→select fails checkpoint with
    // JOURNAL_HASH_MISMATCH. Round non-integers through toPrecision(15) so
    // the stored hash matches the post-MySQL reparse (integers unchanged).
    if (!Number.isInteger(value)) {
      return Number.parseFloat((value as number).toPrecision(15));
    }
    return value;
  }
  if (t !== 'object') {
    throw new DshSessionAdapterError(`unsupported JSONL value type: ${t}`, {
      code: 'SESSION_JSONL_CANONICALIZE_ERROR',
    });
  }
  const obj = (value as Record<string, any>);
  if (stack.has(obj)) {
    throw new DshSessionAdapterError('circular reference is not supported in JSONL', {
      code: 'SESSION_JSONL_CANONICALIZE_ERROR',
    });
  }
  stack.add(obj);
  try {
    if (Array.isArray(value)) {
      return value.map((v) => canonicalizeForJsonl(v, stack));
    }
    if (!isPlainObject(value)) {
      const keys = Object.keys((value as Record<string, any>)).sort();
  const out: Record<string, unknown> = {};
      for (const k of keys) {
        const v = (value as Record<string, unknown>)[k];
        if (v === undefined) continue;
        out[k] = canonicalizeForJsonl(v, stack);
      }
      return out;
    }
  const out: Record<string, unknown> = {};
    for (const k of Object.keys((value as Record<string, any>)).sort()) {
      const v = (value as Record<string, unknown>)[k];
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
 * @param value
 * @returns {string}
 */
export function serializeJsonlLine(value: unknown) {
  return JSON.stringify(canonicalizeForJsonl(value));
}

/**
 * Fail-closed validation of logical snapshot payload (header + entries).
 * @param payload
 * @returns {{ header: Record<string, unknown>, entries: Record<string, unknown>[] }}
 */
export function validateSnapshotPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new DshSessionAdapterError('snapshot payload must be an object', {
      code: 'SESSION_SNAPSHOT_PAYLOAD_INVALID',
    });
  }
  const p = (payload as Record<string, unknown>);
  const header = validateHeader(p.header);
  if (!Array.isArray(p.entries)) {
    throw new DshSessionAdapterError('snapshot payload.entries must be an array', {
      code: 'SESSION_SNAPSHOT_PAYLOAD_INVALID',
    });
  }
  const entries = validateEntries((p.entries as unknown[]));
  return { header, entries };
}

/**
 * @param header
 * @returns {Record<string, unknown>}
 */
export function validateHeader(header: unknown) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new DshSessionAdapterError('snapshot header is required', {
      code: 'SESSION_JSONL_HEADER_INVALID',
    });
  }
  const h = (header as Record<string, unknown>);
  if (h.type !== 'session') {
    throw new DshSessionAdapterError('header.type must be "session"', {
      code: 'SESSION_JSONL_HEADER_INVALID',
    });
  }
  const version = Number(h.version);
  if (version !== SESSION_JSONL_VERSION) {
    throw new DshSessionAdapterError(
      `header.version must be ${SESSION_JSONL_VERSION}, got ${String(h.version)}`,
      { code: 'SESSION_SNAPSHOT_VERSION_INCOMPATIBLE' },
    );
  }
  if (typeof h.id !== 'string' || !h.id.trim()) {
    throw new DshSessionAdapterError('header.id must be a non-empty string', {
      code: 'SESSION_JSONL_HEADER_INVALID',
    });
  }
  if (typeof h.timestamp !== 'string' || !h.timestamp.trim()) {
    throw new DshSessionAdapterError('header.timestamp must be a non-empty string', {
      code: 'SESSION_JSONL_HEADER_INVALID',
    });
  }
  if (typeof h.cwd !== 'string') {
    throw new DshSessionAdapterError('header.cwd must be a string', {
      code: 'SESSION_JSONL_HEADER_INVALID',
    });
  }
  return h;
}

/**
 * Walk parent chain: is `ancestorId` an ancestor of `nodeId` (or equal)?
 * @param nodeId
 * @param ancestorId
 * @param parentOf
 */
export function isAncestorOrSelf(nodeId: string, ancestorId: string, parentOf: Map<string, string | null>) {
  if (nodeId === ancestorId) return true;
  const seen: Set<string> = new Set();
  let cur = (nodeId as string | null | undefined);
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
 * @param entries
 * @returns {string | null}
 */
export function findLeafEntryId(entries: Array<{ id: string, parentId?: string | null }>) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const usedAsParent: Set<string> = new Set();
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
 * @param entries
 * @returns {Record<string, unknown>[]}
 */
export function validateEntries(entries: unknown[]) {
  const out: Record<string, unknown>[] = [];
  const seenIds: Set<string> = new Set();
  const parentOf: Map<string, string | null> = new Map();
  let nullRootSeen = false;

  for (let i = 0; i < entries.length; i += 1) {
    const raw = entries[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new DshSessionAdapterError(`entries[${i}] must be an object`, {
        code: 'SESSION_SNAPSHOT_ENTRY_INVALID',
      });
    }
    const e = (raw as Record<string, unknown>);
    const type = e.type;
    if (typeof type !== 'string' || !SESSION_JSONL_ENTRY_TYPE_SET.has(type)) {
      throw new DshSessionAdapterError(
        `entries[${i}].type unknown or missing: ${String(type)}`,
        { code: 'SESSION_SNAPSHOT_ENTRY_UNKNOWN_TYPE' },
      );
    }
    if (typeof e.id !== 'string' || !e.id.trim()) {
      throw new DshSessionAdapterError(`entries[${i}].id must be a non-empty string`, {
        code: 'SESSION_SNAPSHOT_ENTRY_INVALID',
      });
    }
    const id = e.id;
    if (seenIds.has(id)) {
      throw new DshSessionAdapterError(`duplicate entry id: ${id}`, {
        code: 'SESSION_SNAPSHOT_ENTRY_DUPLICATE_ID',
      });
    }

    // parentId must be an explicit own-property (null root or prior id).
    if (!Object.prototype.hasOwnProperty.call(e, 'parentId')) {
      throw new DshSessionAdapterError(
        `entries[${i}].parentId is required (own property; use null for the single root)`,
        { code: 'SESSION_SNAPSHOT_ENTRY_PARENT_REQUIRED' },
      );
    }

    if (e.parentId === null) {
      if (i !== 0 || nullRootSeen) {
        throw new DshSessionAdapterError(
          `entries[${i}].parentId null root only allowed as the first entry (at most one root)`,
          { code: 'SESSION_SNAPSHOT_ENTRY_MULTI_ROOT' },
        );
      }
      nullRootSeen = true;
    } else if (typeof e.parentId === 'string' && e.parentId.trim()) {
      if (!seenIds.has(e.parentId)) {
        throw new DshSessionAdapterError(
          `entries[${i}].parentId ${e.parentId} does not reference a prior entry`,
          { code: 'SESSION_SNAPSHOT_ENTRY_ORPHAN' },
        );
      }
    } else {
      throw new DshSessionAdapterError(
        `entries[${i}].parentId must be null or a non-empty string`,
        { code: 'SESSION_SNAPSHOT_ENTRY_ORPHAN' },
      );
    }

    if (typeof e.timestamp !== 'string' || !e.timestamp.trim()) {
      throw new DshSessionAdapterError(
        `entries[${i}].timestamp must be a non-empty string`,
        { code: 'SESSION_SNAPSHOT_ENTRY_INVALID' },
      );
    }

    if (type === 'message') {
      if (!e.message || typeof e.message !== 'object') {
        throw new DshSessionAdapterError(`entries[${i}].message is required`, {
          code: 'SESSION_SNAPSHOT_ENTRY_INVALID',
        });
      }
    }

    if (type === 'compaction') {
      if (typeof e.summary !== 'string' || typeof e.firstKeptEntryId !== 'string') {
        throw new DshSessionAdapterError(
          `entries[${i}] compaction requires summary and firstKeptEntryId`,
          { code: 'SESSION_SNAPSHOT_ENTRY_INVALID' },
        );
      }
      if (!seenIds.has(e.firstKeptEntryId)) {
        throw new DshSessionAdapterError(
          `entries[${i}].firstKeptEntryId ${e.firstKeptEntryId} does not reference a prior entry`,
          { code: 'SESSION_SNAPSHOT_ENTRY_COMPACTION_INVALID' },
        );
      }
      // firstKeptEntryId must be on the ancestry of this entry's parent (or be parent).
      const parentId = (e.parentId as string | null);
      if (parentId != null) {
        if (!isAncestorOrSelf(parentId, e.firstKeptEntryId, parentOf)) {
          throw new DshSessionAdapterError(
            `entries[${i}].firstKeptEntryId ${e.firstKeptEntryId} is not on the parent ancestry chain`,
            { code: 'SESSION_SNAPSHOT_ENTRY_COMPACTION_INVALID' },
          );
        }
      }
    }

    if (type === 'branch_summary') {
      if (typeof e.fromId !== 'string' || typeof e.summary !== 'string') {
        throw new DshSessionAdapterError(
          `entries[${i}] branch_summary requires fromId and summary`,
          { code: 'SESSION_SNAPSHOT_ENTRY_INVALID' },
        );
      }
      if (!seenIds.has(e.fromId)) {
        throw new DshSessionAdapterError(
          `entries[${i}].fromId ${e.fromId} does not reference a prior entry`,
          { code: 'SESSION_SNAPSHOT_ENTRY_BRANCH_INVALID' },
        );
      }
    }

    // Non-empty sessions must start with a null root.
    if (i === 0 && e.parentId !== null) {
      throw new DshSessionAdapterError(
        'entries[0].parentId must be null (single root)',
        { code: 'SESSION_SNAPSHOT_ENTRY_MULTI_ROOT' },
      );
    }

    seenIds.add(id);
    parentOf.set(id, (e.parentId as string | null));
    out.push(e);
  }
  return out;
}

/**
 * Materialize complete version-3 session JSONL text (header first, then entries).
 * Each line uses deterministic canonical serialization.
 *
 * @param payload
 * @param [opts]
 * @returns {string}
 */
export function materializeJsonl(payload: unknown, opts: { maxBytes?: number } = {}) {
  const { header, entries } = validateSnapshotPayload(payload);
  const lines = [serializeJsonlLine(header)];
  for (const entry of entries) {
    lines.push(serializeJsonlLine(entry));
  }
  const text = `${lines.join('\n')}\n`;
  const max = opts.maxBytes ?? DEFAULT_MAX_JSONL_BYTES;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > max) {
    throw new DshSessionAdapterError(
      `JSONL exceeds max size ${max} bytes`,
      { code: 'SESSION_JSONL_TOO_LARGE' },
    );
  }
  return text;
}

/**
 * SHA-256 hex of exact UTF-8 JSONL bytes.
 * @param jsonlText
 * @returns {string}
 */
export function checksumJsonl(jsonlText: string) {
  if (typeof jsonlText !== 'string') {
    throw new DshSessionAdapterError('checksumJsonl requires a string', {
      code: 'SESSION_JSONL_CHECKSUM_INVALID',
    });
  }
  return createHash('sha256').update(jsonlText, 'utf8').digest('hex');
}

/**
 * SHA-256 of materializeJsonl(payload) — shared repository/adapter contract.
 * @param payload
 * @returns {string}
 */
export function checksumSnapshotPayload(payload: unknown) {
  return checksumJsonl(materializeJsonl(payload));
}

/**
 * @param snapshot
 * @returns {boolean}
 */
export function verifySnapshotChecksum(snapshot: { snapshotJson?: unknown, checksum?: string } | null | undefined) {
  if (!snapshot?.snapshotJson || !snapshot.checksum) return false;
  try {
    const actual = checksumSnapshotPayload(snapshot.snapshotJson).toLowerCase();
    return actual === String(snapshot.checksum).toLowerCase();
  } catch {
    return false;
  }
}

export function buildSessionHeader(opts: { id: string, cwd: string, timestamp?: string }) {
  return {
    type: 'session',
    version: SESSION_JSONL_VERSION,
    id: String(opts.id),
    timestamp: opts.timestamp || new Date().toISOString(),
    cwd: String(opts.cwd ?? ''),
  };
}

/**
 * Capture a session JSONL snapshot from SessionManager, awaiting a thenable adapter.
 * A null/Promise adapter (Wave 6 stub) must fall through to getHeader, not throw
 * "snapshot header is required" on the Promise object.
 *
 * @param {{
 *   sessionAdapter?: { captureSnapshotPayload?: Function },
 *   sessionManager?: { getHeader?: Function, getEntries?: Function },
 *   recoveredPayload?: { header?: object, entries?: object[] } | null,
 *   cwd: string,
 *   agentSessionId: string,
 * }} input
 */
export async function captureSessionSnapshotPayload(input: { sessionAdapter?: { captureSnapshotPayload?: Function }, sessionManager?: { getHeader?: Function, getEntries?: Function }, recoveredPayload?: { header?: Record<string, any>, entries?: Record<string, any>[] } | null, cwd: string, agentSessionId: string, }) {
  const sessionManager = input.sessionManager;
  const cwd = input.cwd;
  const agentSessionId = input.agentSessionId;
  let payload;
  const capture = input.sessionAdapter?.captureSnapshotPayload;
  if (sessionManager && typeof capture === 'function') {
    payload = capture(sessionManager, { cwd });
    if (payload != null && typeof payload.then === 'function') {
      payload = await payload;
    }
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.header) {
    return {
      header: {
        ...payload.header,
        cwd: cwd ?? payload.header.cwd,
        version: SESSION_JSONL_VERSION,
        type: 'session',
      },
      entries: Array.isArray(payload.entries) ? [...payload.entries] : [],
    };
  }
  if (sessionManager && typeof sessionManager.getEntries === 'function') {
    const headerRaw =
      typeof sessionManager.getHeader === 'function' ? sessionManager.getHeader() : {};
    return {
      header: buildSessionHeader({
        id: String(headerRaw?.id || agentSessionId),
        cwd: String(cwd ?? headerRaw?.cwd ?? ''),
        ...(typeof headerRaw?.timestamp === 'string' ? { timestamp: headerRaw.timestamp } : {}),
      }),
      entries: [...sessionManager.getEntries()],
    };
  }
  // A recovered payload comes off the wire and may be missing either half.
  // Returning it verbatim would checkpoint a snapshot with no header (or no
  // entries array), which only surfaces on the next recovery — normalize both
  // halves here so every return of this function has the same shape.
  const recovered = input.recoveredPayload;
  if (recovered) {
    return {
      header: recovered.header ?? buildSessionHeader({ id: agentSessionId, cwd: cwd ?? '' }),
      entries: Array.isArray(recovered.entries) ? recovered.entries : [],
    };
  }
  return {
    header: buildSessionHeader({ id: agentSessionId, cwd: cwd ?? '' }),
    entries: [],
  };
}
