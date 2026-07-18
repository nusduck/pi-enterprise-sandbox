/**
 * Agent Session Snapshot repository (plan §8.9 + PR-05).
 *
 * Append-only snapshot versions. Snapshots are acceleration artifacts.
 * Checksum = SHA-256 of deterministic materialized Pi JSONL v3 UTF-8 bytes
 * (shared codec with PiSessionAdapter).
 *
 * Public commit path {@link appendAndAdvance} is transactional: insert + CAS
 * on agent_sessions in one trx so a CAS loser never leaves an orphan row.
 */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import {
  mapAgentSessionSnapshot,
  toMysqlDateTime,
} from '../row-mappers.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { assertUlid } from '../../../domain/shared/ulid.js';
import { SessionSnapshotError } from '../../../domain/session/errors.js';
import { SESSION_STATUS } from '../../../domain/session/session-status.js';
import { DEFAULT_PI_SDK_VERSION } from './agent-catalog-repository.js';
import {
  checksumSnapshotPayload,
  materializeJsonl,
  validateSnapshotPayload,
  verifySnapshotChecksum,
  PI_SESSION_JSONL_VERSION,
  DEFAULT_MAX_JSONL_BYTES,
} from '../../pi/pi-jsonl-codec.js';

/** Supported snapshot payload format identifiers. */
export const SNAPSHOT_FORMAT = Object.freeze({
  PI_JSONL_V3: 'pi_jsonl_v3',
});

export const SUPPORTED_SNAPSHOT_FORMATS = Object.freeze(
  Object.values(SNAPSHOT_FORMAT),
);

export const DEFAULT_MAX_SNAPSHOT_BYTES = DEFAULT_MAX_JSONL_BYTES;

/**
 * @param {{ orgId: string, userId: string }} scope
 */
function requireOwnerUlids(scope) {
  const s = requireOwnerScope(scope);
  return {
    orgId: assertUlid(s.orgId, 'orgId'),
    userId: assertUlid(s.userId, 'userId'),
  };
}

/**
 * @param {string} format
 * @param {string} [field]
 */
export function assertSnapshotFormat(format, field = 'snapshotFormat') {
  if (typeof format !== 'string' || !SUPPORTED_SNAPSHOT_FORMATS.includes(format)) {
    throw new SessionSnapshotError(
      `Unsupported ${field}: ${String(format)} (supported: ${SUPPORTED_SNAPSHOT_FORMATS.join(',')})`,
      { code: 'SNAPSHOT_FORMAT_INCOMPATIBLE' },
    );
  }
  return format;
}

/**
 * Exact equality only for this revision. Future compatibility requires an
 * explicit migrator — never same-major/minor soft matching.
 *
 * @param {string} stored
 * @param {string} runtime
 */
export function assertPiSdkVersionCompatible(stored, runtime) {
  const a = String(stored || '').trim();
  const b = String(runtime || '').trim();
  if (!a || !b) {
    throw new SessionSnapshotError('pi_sdk_version is required for snapshot compatibility', {
      code: 'SNAPSHOT_SDK_VERSION_INCOMPATIBLE',
    });
  }
  if (a !== b) {
    throw new SessionSnapshotError(
      `pi_sdk_version incompatible: snapshot=${a} runtime=${b} (exact match required)`,
      { code: 'SNAPSHOT_SDK_VERSION_INCOMPATIBLE' },
    );
  }
  return true;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isDuplicateKeyError(err) {
  const code = /** @type {{ code?: string, errno?: number }} */ (err)?.code;
  const errno = /** @type {{ errno?: number }} */ (err)?.errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}

// Re-export shared codec helpers under repository names for tests.
export {
  materializeJsonl as serializeSnapshotPayload,
  checksumSnapshotPayload,
  verifySnapshotChecksum,
  PI_SESSION_JSONL_VERSION,
};

export class AgentSessionSnapshotRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   * @param {{
   *   now?: () => Date,
   *   runtimePiSdkVersion?: string,
   *   maxSnapshotBytes?: number,
   * }} [opts]
   */
  constructor(db, opts = {}) {
    if (!db) {
      throw new Error('AgentSessionSnapshotRepository requires a knex executor');
    }
    this.db = db;
    this.now = opts.now ?? (() => new Date());
    this.runtimePiSdkVersion = opts.runtimePiSdkVersion ?? DEFAULT_PI_SDK_VERSION;
    this.maxSnapshotBytes = opts.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  }

  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  async #requireOwnedSessionOn(db, agentSessionId, scope, opts = {}) {
    const s = requireOwnerUlids(scope);
    const id = assertUlid(agentSessionId, 'agentSessionId');
    let q = applyOwnerScope(
      db('agent_sessions').where({ agent_session_id: id }),
      s,
    );
    if (opts.forUpdate) q = q.forUpdate();
    const row = await q.first();
    if (!row) {
      throw new NotFoundError('Agent session not found', {
        resource: 'agent_sessions',
        id,
      });
    }
    return {
      agentSessionId: id,
      orgId: s.orgId,
      userId: s.userId,
      piSessionVersion: Number(row.pi_session_version ?? 0),
      executionFenceToken: Number(row.execution_fence_token ?? 0),
      status: String(row.status),
    };
  }

  /**
   * Safe public path: insert snapshot + advance pi_session_version atomically.
   * Requires:
   * - expectedExecutionFenceToken (stored as captured_fence_token)
   * - expectedPiSessionVersion; snapshotVersion === expected + 1
   * - session status ACTIVE (owner-scoped CAS)
   *
   * When `db` is not already a transaction, opens a short transaction so CAS
   * failure rolls back the insert (no orphan snapshots).
   *
   * @param {{
   *   snapshotId: string,
   *   agentSessionId: string,
   *   orgId: string,
   *   userId: string,
   *   snapshotVersion: number,
   *   expectedPiSessionVersion: number,
   *   expectedExecutionFenceToken: number,
   *   snapshotFormat?: string,
   *   snapshotJson: object,
   *   workspacePath?: string | null,
   *   piSdkVersion?: string,
   *   checksum?: string,
   *   createdAt?: Date | string,
   * }} input
   */
  async appendAndAdvance(input) {
    const run = async (trx) => this.#appendAndAdvanceOn(trx, input);

    if (this.db.isTransaction === true) {
      return run(this.db);
    }
    if (typeof this.db.transaction !== 'function') {
      throw new Error(
        'AgentSessionSnapshotRepository.appendAndAdvance requires knex.transaction() or a transaction executor',
      );
    }
    return this.db.transaction(run);
  }

  /**
   * @param {import('knex').Knex.Transaction | import('knex').Knex} trx
   * @param {object} input
   */
  async #appendAndAdvanceOn(trx, input) {
    const scope = requireOwnerUlids(input);
    const snapshotId = assertUlid(input.snapshotId, 'snapshotId');
    const session = await this.#requireOwnedSessionOn(
      trx,
      input.agentSessionId,
      scope,
      { forUpdate: true },
    );

    if (session.status !== SESSION_STATUS.ACTIVE) {
      throw new ConflictError(
        `Snapshot write requires ACTIVE session, got ${session.status}`,
        { resource: 'agent_sessions', id: session.agentSessionId },
      );
    }

    const expectedFence = Number(input.expectedExecutionFenceToken);
    if (!Number.isInteger(expectedFence) || expectedFence < 0) {
      throw new Error('expectedExecutionFenceToken must be a non-negative integer');
    }
    if (session.executionFenceToken !== expectedFence) {
      throw new ConflictError(
        `Stale execution fence: expected ${expectedFence}, got ${session.executionFenceToken}`,
        { resource: 'agent_sessions', id: session.agentSessionId },
      );
    }

    const snapshotVersion = Number(input.snapshotVersion);
    if (!Number.isInteger(snapshotVersion) || snapshotVersion < 1) {
      throw new SessionSnapshotError('snapshotVersion must be a positive integer', {
        code: 'SNAPSHOT_VERSION_INVALID',
        agentSessionId: session.agentSessionId,
      });
    }

    const expectedPi = Number(input.expectedPiSessionVersion);
    if (!Number.isInteger(expectedPi) || expectedPi < 0) {
      throw new Error('expectedPiSessionVersion must be a non-negative integer');
    }
    if (snapshotVersion !== expectedPi + 1) {
      throw new SessionSnapshotError(
        `snapshotVersion must equal expectedPiSessionVersion+1 (${expectedPi + 1}), got ${snapshotVersion}`,
        {
          code: 'SNAPSHOT_VERSION_INVALID',
          agentSessionId: session.agentSessionId,
          snapshotVersion,
        },
      );
    }
    if (session.piSessionVersion !== expectedPi) {
      throw new ConflictError(
        `pi_session_version race: expected ${expectedPi}, got ${session.piSessionVersion}`,
        { resource: 'agent_sessions', id: session.agentSessionId },
      );
    }

    const format = assertSnapshotFormat(
      input.snapshotFormat ?? SNAPSHOT_FORMAT.PI_JSONL_V3,
    );
    const piSdkVersion = String(input.piSdkVersion ?? this.runtimePiSdkVersion);
    assertPiSdkVersionCompatible(piSdkVersion, this.runtimePiSdkVersion);

    // Validate + materialize for checksum (shared codec).
    const normalized = validateSnapshotPayload(input.snapshotJson);
    materializeJsonl(normalized, { maxBytes: this.maxSnapshotBytes });
    const checksum = (
      input.checksum ? String(input.checksum) : checksumSnapshotPayload(normalized)
    ).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(checksum)) {
      throw new SessionSnapshotError('checksum must be 64-char lowercase hex SHA-256', {
        code: 'SNAPSHOT_CHECKSUM_INVALID',
        agentSessionId: session.agentSessionId,
      });
    }
    const recomputed = checksumSnapshotPayload(normalized).toLowerCase();
    if (checksum !== recomputed) {
      throw new SessionSnapshotError(
        'checksum does not match materialized JSONL UTF-8 bytes',
        {
          code: 'SNAPSHOT_CHECKSUM_MISMATCH',
          agentSessionId: session.agentSessionId,
          snapshotVersion,
        },
      );
    }

    // Store logical payload (header+entries); verification always re-materializes.
    try {
      await trx('agent_session_snapshots').insert({
        snapshot_id: snapshotId,
        agent_session_id: session.agentSessionId,
        snapshot_version: snapshotVersion,
        snapshot_format: format,
        snapshot_json: normalized,
        workspace_path: input.workspacePath ?? null,
        checksum,
        pi_sdk_version: piSdkVersion,
        captured_fence_token: expectedFence,
        created_at: toMysqlDateTime(input.createdAt || this.now()),
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictError(
          `Snapshot version ${snapshotVersion} already exists for session`,
          { resource: 'agent_session_snapshots', id: snapshotId },
        );
      }
      throw err;
    }

    // CAS: owner + ACTIVE + pi_session_version + execution_fence_token
    const n = await applyOwnerScope(
      trx('agent_sessions').where({
        agent_session_id: session.agentSessionId,
        status: SESSION_STATUS.ACTIVE,
        pi_session_version: expectedPi,
        execution_fence_token: expectedFence,
      }),
      scope,
    ).update({
      pi_session_version: snapshotVersion,
      updated_at: toMysqlDateTime(this.now()),
    });
    if (!n) {
      // Throw → outer transaction rolls back the insert.
      throw new ConflictError(
        `Snapshot CAS failed (status/version/fence race) for session ${session.agentSessionId}`,
        { resource: 'agent_sessions', id: session.agentSessionId },
      );
    }

    const row = await trx('agent_session_snapshots')
      .where({ snapshot_id: snapshotId })
      .first();
    return mapAgentSessionSnapshot(row);
  }

  /**
   * @param {string} snapshotId
   * @param {{ orgId: string, userId: string }} scope
   */
  async getById(snapshotId, scope) {
    const s = requireOwnerUlids(scope);
    const id = assertUlid(snapshotId, 'snapshotId');
    const row = await this.db('agent_session_snapshots')
      .where({ snapshot_id: id })
      .first();
    if (!row) return null;
    try {
      await this.#requireOwnedSessionOn(this.db, String(row.agent_session_id), s);
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
    return mapAgentSessionSnapshot(row);
  }

  /**
   * @param {string} snapshotId
   * @param {{ orgId: string, userId: string }} scope
   */
  async requireById(snapshotId, scope) {
    const row = await this.getById(snapshotId, scope);
    if (!row) {
      throw new NotFoundError('Agent session snapshot not found', {
        resource: 'agent_session_snapshots',
        id: snapshotId,
      });
    }
    return row;
  }

  /**
   * Load the **current** committed snapshot for a session.
   *
   * Uses `agent_sessions.pi_session_version` as the sole pointer — never MAX(version).
   * - pointer === 0 → null (no committed snapshot)
   * - pointer > 0 and row missing / checksum / format / SDK invalid → typed recovery error
   * - never silently picks another version (stray higher rows are ignored)
   *
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ verifyChecksum?: boolean, requireCompatible?: boolean }} [opts]
   */
  async loadLatest(agentSessionId, scope, opts = {}) {
    const s = requireOwnerUlids(scope);
    const sid = assertUlid(agentSessionId, 'agentSessionId');
    const session = await this.#requireOwnedSessionOn(this.db, sid, s);
    const pointer = Number(session.piSessionVersion);

    if (!Number.isInteger(pointer) || pointer < 0) {
      throw new SessionSnapshotError(
        `Invalid pi_session_version pointer: ${String(session.piSessionVersion)}`,
        {
          code: 'SNAPSHOT_POINTER_INVALID',
          agentSessionId: sid,
        },
      );
    }
    if (pointer === 0) {
      return null;
    }

    const row = await this.db('agent_session_snapshots')
      .where({ agent_session_id: sid, snapshot_version: pointer })
      .first();

    if (!row) {
      throw new SessionSnapshotError(
        `Committed snapshot version ${pointer} missing for session ${sid}`,
        {
          code: 'SNAPSHOT_POINTER_MISSING',
          agentSessionId: sid,
          snapshotVersion: pointer,
        },
      );
    }

    const mapped = mapAgentSessionSnapshot(row);
    if (Number(mapped.snapshotVersion) !== pointer) {
      throw new SessionSnapshotError(
        `Snapshot version mismatch: pointer=${pointer}, row=${mapped.snapshotVersion}`,
        {
          code: 'SNAPSHOT_POINTER_MISMATCH',
          agentSessionId: sid,
          snapshotVersion: pointer,
        },
      );
    }

    return this.#mapAndVerify(mapped, sid, pointer, opts);
  }

  /**
   * Load a specific version under owner scope (explicit; not the current pointer).
   * Missing row returns null. Prefer {@link loadLatest} for recovery of current.
   *
   * @param {string} agentSessionId
   * @param {number} snapshotVersion
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ verifyChecksum?: boolean, requireCompatible?: boolean }} [opts]
   */
  async loadVersion(agentSessionId, snapshotVersion, scope, opts = {}) {
    const s = requireOwnerUlids(scope);
    const sid = assertUlid(agentSessionId, 'agentSessionId');
    await this.#requireOwnedSessionOn(this.db, sid, s);
    const version = Number(snapshotVersion);
    if (!Number.isInteger(version) || version < 1) {
      throw new SessionSnapshotError('snapshotVersion must be a positive integer', {
        code: 'SNAPSHOT_VERSION_INVALID',
        agentSessionId: sid,
      });
    }

    const row = await this.db('agent_session_snapshots')
      .where({ agent_session_id: sid, snapshot_version: version })
      .first();
    if (!row) return null;
    return this.#mapAndVerify(mapAgentSessionSnapshot(row), sid, version, opts);
  }

  /**
   * @param {ReturnType<typeof mapAgentSessionSnapshot>} mapped
   * @param {string} sid
   * @param {number} expectedVersion
   * @param {{ verifyChecksum?: boolean, requireCompatible?: boolean }} opts
   */
  #mapAndVerify(mapped, sid, expectedVersion, opts) {
    if (opts.verifyChecksum !== false) {
      if (!verifySnapshotChecksum(mapped)) {
        throw new SessionSnapshotError(
          `Snapshot checksum verification failed for version ${mapped.snapshotVersion}`,
          {
            code: 'SNAPSHOT_CHECKSUM_MISMATCH',
            agentSessionId: sid,
            snapshotVersion: expectedVersion,
          },
        );
      }
    }

    if (opts.requireCompatible !== false) {
      try {
        assertSnapshotFormat(mapped.snapshotFormat);
        assertPiSdkVersionCompatible(mapped.piSdkVersion, this.runtimePiSdkVersion);
      } catch (err) {
        if (err instanceof SessionSnapshotError) {
          throw new SessionSnapshotError(err.message, {
            code: err.code,
            agentSessionId: sid,
            snapshotVersion: expectedVersion,
          });
        }
        throw err;
      }
    }

    return mapped;
  }
}
