/**
 * Pi SDK session persistence helpers (B1 / ADR 0002 §7).
 *
 * - Materialize temporary JSONL from DB entries
 * - Open via SessionManager.open(session_file)
 * - Map SDK entry types → ADR entry_type
 * - Diff + live-persist new entries during a run
 * - Fail-closed restore (never silent empty session)
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  SessionManager,
  CURRENT_SESSION_VERSION,
} from '@earendil-works/pi-coding-agent';

/** Error raised when a bound agent session cannot be restored. */
export class SessionRestoreError extends Error {
  /**
   * @param {string} message
   * @param {{ agentSessionId?: string|null, conversationId?: string|null, cause?: unknown }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'SessionRestoreError';
    this.agentSessionId = meta.agentSessionId || null;
    this.conversationId = meta.conversationId || null;
    this.cause = meta.cause;
  }
}

/**
 * Map a raw Pi SDK session entry to ADR entry_type.
 * @param {object} entry
 * @returns {string}
 */
export function mapSdkEntryType(entry) {
  if (!entry || typeof entry !== 'object') return 'custom';
  const t = entry.type;
  if (t === 'message') {
    const role = entry.message?.role;
    if (role === 'user') return 'user_message';
    if (role === 'assistant') return 'assistant_message';
    if (role === 'toolResult') return 'tool_result';
    if (role === 'bashExecution') return 'tool_result';
    return 'user_message';
  }
  if (t === 'compaction') return 'compaction';
  if (t === 'branch_summary') return 'branch';
  if (t === 'model_change') return 'model_change';
  if (t === 'thinking_level_change') return 'model_change';
  if (t === 'custom' || t === 'custom_message') return 'custom';
  if (t === 'session_info' || t === 'label') return 'custom';
  if (t === 'system_prompt_change') return 'system_prompt_change';
  return typeof t === 'string' && t ? t : 'custom';
}

/**
 * Convert SDK SessionManager entries into sandbox append payloads.
 * @param {object[]} sdkEntries
 * @returns {Array<{ id: string, entry_type: string, entry_payload: object, parent_entry_id: string|null }>}
 */
export function toPersistableEntries(sdkEntries) {
  const list = Array.isArray(sdkEntries) ? sdkEntries : [];
  return list.map((entry) => ({
    id: entry.id || `ase_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    entry_type: mapSdkEntryType(entry),
    entry_payload: entry,
    parent_entry_id: entry.parentId ?? null,
    branch_id: null,
  }));
}

/**
 * Build JSONL text from a resume payload (header + entry payloads).
 * @param {{ header?: object, header_payload?: object, entries?: Array<{ entry_payload?: object }>, jsonl?: string }} resume
 * @returns {string}
 */
export function buildJsonlFromResume(resume) {
  if (resume?.jsonl && typeof resume.jsonl === 'string' && resume.jsonl.trim()) {
    return resume.jsonl.endsWith('\n') ? resume.jsonl : `${resume.jsonl}\n`;
  }
  const header =
    resume?.header ||
    resume?.header_payload ||
    resume?.session?.header_payload ||
    null;
  const entries = Array.isArray(resume?.entries) ? resume.entries : [];
  const lines = [];
  if (header && typeof header === 'object') {
    lines.push(JSON.stringify(header));
  }
  for (const e of entries) {
    const payload = e?.entry_payload || e;
    if (payload && typeof payload === 'object' && payload.type !== 'session') {
      lines.push(JSON.stringify(payload));
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * Write JSONL to a temp file and return path + cleanup.
 * @param {string} jsonl
 * @param {{ prefix?: string }} [opts]
 * @returns {{ sessionFile: string, sessionDir: string, cleanup: () => void }}
 */
export function materializeSessionFile(jsonl, opts = {}) {
  const sessionDir = mkdtempSync(join(tmpdir(), opts.prefix || 'pi-asess-'));
  const sessionFile = join(sessionDir, 'session.jsonl');
  const body = typeof jsonl === 'string' ? jsonl : '';
  if (!body.trim()) {
    throw new SessionRestoreError('Cannot materialize empty session JSONL');
  }
  writeFileSync(sessionFile, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
  return {
    sessionFile,
    sessionDir,
    cleanup: () => {
      try {
        rmSync(sessionDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Open a SessionManager from resume payload (DB → JSONL → open).
 * Fail-closed: throws SessionRestoreError on any failure.
 *
 * @param {object} resume - AgentSessionResumeResponse-like
 * @param {{ conversationId?: string|null, cwd?: string }} [opts]
 * @returns {{ sessionManager: import('@earendil-works/pi-coding-agent').SessionManager, sessionFile: string, sessionDir: string, cleanup: () => void, agentSessionId: string, persistedCount: number }}
 */
export function openSessionFromResume(resume, opts = {}) {
  const agentSessionId = resume?.session?.id || resume?.id || null;
  const conversationId = opts.conversationId || resume?.session?.conversation_id || null;
  try {
    const jsonl = buildJsonlFromResume(resume);
    if (!jsonl.trim()) {
      throw new SessionRestoreError('Resume payload has no JSONL content', {
        agentSessionId,
        conversationId,
      });
    }
    const { sessionFile, sessionDir, cleanup } = materializeSessionFile(jsonl);
    try {
      const sessionManager = SessionManager.open(
        sessionFile,
        sessionDir,
        opts.cwd || '/tmp',
      );
      const entries = sessionManager.getEntries();
      return {
        sessionManager,
        sessionFile,
        sessionDir,
        cleanup,
        agentSessionId,
        persistedCount: entries.length,
      };
    } catch (err) {
      cleanup();
      throw err;
    }
  } catch (err) {
    if (err instanceof SessionRestoreError) throw err;
    throw new SessionRestoreError(
      err?.message || String(err) || 'session restore failed',
      { agentSessionId, conversationId, cause: err },
    );
  }
}

/**
 * Create a brand-new persisted SessionManager (first turn of a conversation).
 * Uses a real JSONL file so live-persist can re-open after restart.
 *
 * @param {{ cwd?: string, sessionId?: string }} [opts]
 * @returns {{ sessionManager: import('@earendil-works/pi-coding-agent').SessionManager, sessionFile: string, sessionDir: string, cleanup: () => void, persistedCount: number }}
 */
export function createNewPersistedSession(opts = {}) {
  const sessionDir = mkdtempSync(join(tmpdir(), 'pi-asess-new-'));
  const cwd = opts.cwd || '/tmp';
  const sessionManager = SessionManager.create(cwd, sessionDir, {
    id: opts.sessionId,
  });
  return {
    sessionManager,
    sessionFile: sessionManager.getSessionFile(),
    sessionDir,
    cleanup: () => {
      try {
        rmSync(sessionDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
    persistedCount: 0,
  };
}

/**
 * Create an in-memory session (rollback / force-inMemory flag only).
 * @param {{ cwd?: string }} [opts]
 */
export function createInMemorySession(opts = {}) {
  const sessionManager = SessionManager.inMemory(opts.cwd || '/tmp');
  return {
    sessionManager,
    sessionFile: null,
    sessionDir: null,
    cleanup: () => {},
    persistedCount: 0,
  };
}

/**
 * Diff SDK entries against last persisted count and return new ones.
 * @param {import('@earendil-works/pi-coding-agent').SessionManager} sessionManager
 * @param {number} alreadyPersistedCount
 */
export function collectNewEntries(sessionManager, alreadyPersistedCount = 0) {
  const all = sessionManager.getEntries() || [];
  const fresh = all.slice(Math.max(0, alreadyPersistedCount));
  return {
    entries: toPersistableEntries(fresh),
    totalCount: all.length,
    header: sessionManager.getHeader() || null,
    sdkSessionId: sessionManager.getSessionId() || null,
  };
}

/**
 * Live-persist new SDK entries to sandbox.
 *
 * @param {{
 *   client: { appendAgentSessionEntries: Function },
 *   agentSessionId: string,
 *   sessionManager: import('@earendil-works/pi-coding-agent').SessionManager,
 *   alreadyPersistedCount: number,
 *   modelId?: string|null,
 * }} args
 * @returns {Promise<number>} new persisted count
 */
export async function persistNewEntries({
  client,
  agentSessionId,
  sessionManager,
  alreadyPersistedCount,
  modelId = null,
}) {
  if (!agentSessionId || !client?.appendAgentSessionEntries) {
    return alreadyPersistedCount;
  }
  const { entries, totalCount, header, sdkSessionId } = collectNewEntries(
    sessionManager,
    alreadyPersistedCount,
  );
  if (entries.length === 0) {
    // Still refresh header if needed
    return totalCount;
  }
  const hasCompaction = entries.some((e) => e.entry_type === 'compaction');
  const body = {
    entries,
    header_payload: header || undefined,
    sdk_session_id: sdkSessionId || undefined,
    model_id: modelId || undefined,
  };
  if (hasCompaction) {
    body.last_compacted_at = new Date().toISOString();
    body.status = 'compacted';
  }
  await client.appendAgentSessionEntries(agentSessionId, body);
  return totalCount;
}

/**
 * Whether session persistence is forced off (rollback flag).
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 */
export function isForceInMemory(env = process.env) {
  const raw = String(env.AGENT_FORCE_INMEMORY || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export { CURRENT_SESSION_VERSION };
