/**
 * PiSessionAdapter (PR-05) — recover Pi SessionManager from durable snapshots.
 *
 * SDK limitation (@earendil-works/pi-coding-agent@0.80.3):
 * - No native snapshot/hydrate/checkpoint API.
 * - SessionManager.inMemory() cannot hydrate raw entries.
 * - SessionManager.open silently skips malformed lines → validate fail-closed first.
 * - Correct recovery: materialize complete v3 JSONL → SessionManager.open(path, sessionDir, cwdOverride) →
 *   pass manager into createAgentSessionFromServices.
 * - Do not manually assign or mutate agent.state.messages.
 * - expectedChecksum verifies the **persisted** payload (not cwd-rewritten header).
 * - cwd is SessionManager.open's third argument only — never rewrite header.cwd for checksum.
 */

import { randomBytes } from 'node:crypto';
import { promises as defaultFs } from 'node:fs';
import defaultPath from 'node:path';
import defaultOs from 'node:os';
import { PiSessionAdapterError } from './errors.js';
import {
  PI_SESSION_JSONL_VERSION,
  PI_JSONL_ENTRY_TYPES,
  buildSessionHeader,
  validateSnapshotPayload,
  materializeJsonl,
  checksumJsonl,
  checksumSnapshotPayload,
  parseAndValidateJsonl,
  verifySnapshotChecksum,
} from './pi-jsonl-codec.js';

export {
  PI_SESSION_JSONL_VERSION,
  PI_JSONL_ENTRY_TYPES as PRESERVED_ENTRY_TYPES,
  buildSessionHeader,
  validateSnapshotPayload,
  materializeJsonl,
  checksumJsonl,
  checksumSnapshotPayload,
  parseAndValidateJsonl,
  verifySnapshotChecksum,
};

/**
 * @typedef {{
 *   mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<unknown>,
 *   writeFile: (path: string, data: string | Buffer, opts?: string | object) => Promise<void>,
 *   rename: (oldPath: string, newPath: string) => Promise<void>,
 *   rm: (path: string, opts?: { recursive?: boolean, force?: boolean }) => Promise<void>,
 *   readFile?: (path: string, encoding: string) => Promise<string>,
 * }} FileIo
 */

async function defaultLoadSessionManager() {
  const mod = await import('@earendil-works/pi-coding-agent');
  if (typeof mod.SessionManager?.open !== 'function') {
    throw new PiSessionAdapterError(
      'Installed @earendil-works/pi-coding-agent does not export SessionManager.open',
      { code: 'PI_SDK_EXPORT_MISSING' },
    );
  }
  return mod.SessionManager;
}

export class PiSessionAdapter {
  /**
   * @param {{
   *   fs?: FileIo,
   *   path?: { join: (...p: string[]) => string, dirname: (p: string) => string },
   *   os?: { tmpdir: () => string },
   *   loadSessionManager?: () => Promise<any>,
   *   runtimeRoot?: string | null,
   *   randomId?: () => string,
   * }} [deps]
   */
  constructor(deps = {}) {
    this.fs = deps.fs ?? defaultFs;
    this.path = deps.path ?? defaultPath;
    this.os = deps.os ?? defaultOs;
    this.loadSessionManager = deps.loadSessionManager ?? defaultLoadSessionManager;
    this.runtimeRoot = deps.runtimeRoot ?? null;
    this.randomId =
      deps.randomId ?? (() => randomBytes(8).toString('hex'));
    /** @type {Set<string>} */
    this._ownedPaths = new Set();
    this._disposed = false;
  }

  /**
   * @param {string} agentSessionId
   * @returns {Promise<string>}
   */
  async ensureRuntimeDir(agentSessionId) {
    const root =
      this.runtimeRoot ||
      this.path.join(this.os.tmpdir(), 'pi-enterprise-session-runtime');
    const dir = this.path.join(root, String(agentSessionId));
    await this.fs.mkdir(dir, { recursive: true });
    this._ownedPaths.add(dir);
    return dir;
  }

  /**
   * @param {string} targetPath
   * @param {string} content
   */
  async atomicWriteFile(targetPath, content) {
    const dir = this.path.dirname(targetPath);
    await this.fs.mkdir(dir, { recursive: true });
    const tmp = `${targetPath}.${this.randomId()}.tmp`;
    try {
      await this.fs.writeFile(tmp, content, 'utf8');
      await this.fs.rename(tmp, targetPath);
      this._ownedPaths.add(targetPath);
    } catch (err) {
      try {
        await this.fs.rm(tmp, { force: true });
      } catch {
        /* best-effort */
      }
      throw new PiSessionAdapterError(
        `Failed to atomically write session JSONL: ${String(/** @type {Error} */ (err)?.message || err)}`,
        { code: 'PI_JSONL_WRITE_FAILED', cause: err },
      );
    }
  }

  /**
   * Materialize snapshot → validate → write → SessionManager.open(path, sessionDir, cwdOverride).
   *
   * expectedChecksum is verified against the **persisted original** payload
   * (header.cwd unchanged). cwd override is only passed to SessionManager.open.
   *
   * @param {{
   *   agentSessionId: string,
   *   payload: object,
   *   cwd?: string,
   *   sessionDir?: string,
   *   expectedChecksum?: string | null,
   * }} input
   */
  async openFromSnapshot(input) {
    if (!input?.agentSessionId) {
      throw new PiSessionAdapterError('agentSessionId is required', {
        code: 'PI_ADAPTER_INPUT_INVALID',
      });
    }

    // Fail-closed validation BEFORE open (SDK silently skips bad lines).
    const { header, entries } = validateSnapshotPayload(input.payload);
    const durablePayload = { header, entries };

    // Checksum of durable original payload — never rewrite header.cwd first.
    const durableChecksum = checksumSnapshotPayload(durablePayload);
    if (input.expectedChecksum) {
      const expected = String(input.expectedChecksum).toLowerCase();
      if (expected !== durableChecksum.toLowerCase()) {
        throw new PiSessionAdapterError(
          'Durable snapshot payload checksum does not match expected',
          { code: 'PI_JSONL_CHECKSUM_MISMATCH' },
        );
      }
    }

    const cwdOverride =
      typeof input.cwd === 'string' && input.cwd
        ? input.cwd
        : String(header.cwd || '');
    if (!cwdOverride) {
      throw new PiSessionAdapterError('cwd is required to open a recovered session', {
        code: 'PI_ADAPTER_CWD_REQUIRED',
      });
    }

    // Materialize **persistent** header JSONL (cwd not rewritten).
    const jsonl = materializeJsonl(durablePayload);
    parseAndValidateJsonl(jsonl);

    const callerSessionDir =
      typeof input.sessionDir === 'string' && input.sessionDir
        ? input.sessionDir
        : null;
    /** @type {string | null} */
    let sessionDir = null;
    /** @type {boolean} */
    let ownedDir = false;
    /** @type {string | null} */
    let jsonlPath = null;
    /** @type {boolean} */
    let wroteFile = false;
    /** @type {boolean} */
    let cleaned = false;

    const cleanupOnce = async () => {
      if (cleaned) return;
      cleaned = true;
      await this.#cleanupOpenArtifacts({
        ownedDir,
        sessionDir,
        jsonlPath: wroteFile ? jsonlPath : null,
      });
    };

    try {
      if (callerSessionDir) {
        sessionDir = callerSessionDir;
        await this.fs.mkdir(sessionDir, { recursive: true });
      } else {
        sessionDir = await this.ensureRuntimeDir(input.agentSessionId);
        ownedDir = true;
      }

      jsonlPath = this.path.join(
        sessionDir,
        `session-${input.agentSessionId}.jsonl`,
      );
      await this.atomicWriteFile(jsonlPath, jsonl);
      wroteFile = true;

      let SessionManager;
      try {
        SessionManager = await this.loadSessionManager();
      } catch (err) {
        await cleanupOnce();
        throw err instanceof PiSessionAdapterError
          ? err
          : new PiSessionAdapterError(
              `Failed to load SessionManager: ${String(/** @type {Error} */ (err)?.message || err)}`,
              { code: 'PI_SDK_EXPORT_MISSING', cause: err },
            );
      }

      let sessionManager;
      try {
        // cwd is open's third argument (override) — not a header rewrite.
        sessionManager = SessionManager.open(jsonlPath, sessionDir, cwdOverride);
      } catch (err) {
        await cleanupOnce();
        throw new PiSessionAdapterError(
          `SessionManager.open failed: ${String(/** @type {Error} */ (err)?.message || err)}`,
          { code: 'PI_SESSION_OPEN_FAILED', cause: err },
        );
      }

      return {
        sessionManager,
        jsonlPath,
        sessionDir,
        checksum: durableChecksum,
        entryCount: entries.length,
        cwdOverride,
      };
    } catch (err) {
      if (!cleaned && (wroteFile || ownedDir)) {
        await cleanupOnce().catch(() => {});
      }
      throw err;
    }
  }

  /**
   * Cleanup for openFromSnapshot failures.
   * - ownedDir: remove the created directory (and written file)
   * - external sessionDir: remove only the written JSONL file
   *
   * @param {{
   *   ownedDir: boolean,
   *   sessionDir?: string,
   *   jsonlPath?: string | null,
   * }} opts
   */
  async #cleanupOpenArtifacts(opts) {
    if (opts.ownedDir && opts.sessionDir) {
      try {
        await this.fs.rm(opts.sessionDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      this._ownedPaths.delete(opts.sessionDir);
      if (opts.jsonlPath) this._ownedPaths.delete(opts.jsonlPath);
      return;
    }
    if (opts.jsonlPath) {
      try {
        await this.fs.rm(opts.jsonlPath, { force: true });
      } catch {
        /* best-effort */
      }
      this._ownedPaths.delete(opts.jsonlPath);
    }
  }

  /**
   * @param {{ agentSessionId: string, cwd: string, sessionDir?: string }} input
   */
  async createNew(input) {
    if (!input?.agentSessionId || !input?.cwd) {
      throw new PiSessionAdapterError('agentSessionId and cwd are required', {
        code: 'PI_ADAPTER_INPUT_INVALID',
      });
    }
    const sessionDir =
      input.sessionDir || (await this.ensureRuntimeDir(input.agentSessionId));
    await this.fs.mkdir(sessionDir, { recursive: true });
    if (!input.sessionDir) this._ownedPaths.add(sessionDir);
    let SessionManager;
    try {
      SessionManager = await this.loadSessionManager();
    } catch (err) {
      if (!input.sessionDir) {
        try {
          await this.fs.rm(sessionDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
      throw err instanceof PiSessionAdapterError
        ? err
        : new PiSessionAdapterError(
            `Failed to load SessionManager: ${String(/** @type {Error} */ (err)?.message || err)}`,
            { code: 'PI_SDK_EXPORT_MISSING', cause: err },
          );
    }
    const sessionManager = SessionManager.create(input.cwd, sessionDir, {
      id: input.agentSessionId,
    });
    return { sessionManager, sessionDir };
  }

  /**
   * Capture SessionManager entries into logical payload (no agent.state.messages mutation).
   * @param {any} sessionManager
   * @param {{ cwd?: string }} [opts]
   */
  captureSnapshotPayload(sessionManager, opts = {}) {
    if (!sessionManager || typeof sessionManager.getEntries !== 'function') {
      throw new PiSessionAdapterError('sessionManager.getEntries is required', {
        code: 'PI_ADAPTER_INPUT_INVALID',
      });
    }
    const header =
      typeof sessionManager.getHeader === 'function'
        ? sessionManager.getHeader()
        : null;
    const entries = sessionManager.getEntries();
    // Prefer SessionManager header.cwd (durable); optional opts.cwd only when header missing.
    const cwd =
      (header && typeof header.cwd === 'string' ? header.cwd : '') ||
      opts.cwd ||
      (typeof sessionManager.getCwd === 'function' ? sessionManager.getCwd() : '') ||
      '';
    const resolvedHeader =
      header && header.type === 'session'
        ? { ...header, version: PI_SESSION_JSONL_VERSION }
        : buildSessionHeader({
            id:
              (typeof sessionManager.getSessionId === 'function' &&
                sessionManager.getSessionId()) ||
              this.randomId(),
            cwd,
          });
    return validateSnapshotPayload({
      header: resolvedHeader,
      entries: [...entries],
    });
  }

  /**
   * Idempotent cleanup of runtime files/dirs owned by this adapter.
   * @param {{ paths?: string[] }} [opts]
   */
  async dispose(opts = {}) {
    if (this._disposed && !opts.paths) return;
    const paths = opts.paths ?? [...this._ownedPaths];
    const ordered = [...paths].sort((a, b) => b.length - a.length);
    for (const p of ordered) {
      try {
        await this.fs.rm(p, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      this._ownedPaths.delete(p);
    }
    if (!opts.paths) this._disposed = true;
  }
}
