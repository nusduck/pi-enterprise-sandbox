/**
 * Session recovery + atomic checkpoint (PR-05 slice B).
 *
 * Truth: Messages (Pi JSONL journal) + Run Events.
 * Acceleration: agent_session_snapshots pointed by agent_sessions.pi_session_version.
 *
 * Recovery priority (plan §12.5):
 * 1. Exact pointed snapshot (checksum / SDK / identity)
 * 2. Rebuild full {header,entries} from journal in append order
 * 3. If neither is complete/consistent → SUSPENDED + RECOVERY_REQUIRED
 *
 * No text-only restore. No agent.state.messages assignment.
 * No invented native SDK snapshot API.
 */

import {
  RECOVERY_REASON_CODE,
} from '../domain/session/recovery-reason.js';
import {
  SessionRecoveryRequiredError,
  SessionSnapshotError,
  SessionFenceConflictError,
  SessionJournalError,
} from '../domain/session/errors.js';
import { SESSION_STATUS } from '../domain/session/session-status.js';
import { assertUlid } from '../domain/shared/ulid.js';
import {
  checksumSnapshotPayload,
  validateSnapshotPayload,
  materializeJsonl,
  PI_SESSION_JSONL_VERSION,
  buildSessionHeader,
  findLeafEntryId,
} from '../infrastructure/pi/pi-jsonl-codec.js';
import {
  SNAPSHOT_FORMAT,
} from '../infrastructure/mysql/repositories/agent-session-snapshot-repository.js';
import { PINNED_PI_SDK_VERSION } from '../infrastructure/pi/pi-runtime-factory.js';
import { AGGREGATE_TYPE_RUN } from '../infrastructure/outbox/outbox-status.js';
import { createHash } from 'node:crypto';

/** customType for protected platform manifest inside Pi JSONL. */
export const PLATFORM_MANIFEST_CUSTOM_TYPE = 'platform.session.manifest';

/**
 * Build a Pi `custom` entry binding recovery identity to the journal.
 *
 * parentId must attach to the current leaf (append-order leaf of content
 * entries). Only an empty session may use parentId: null (sole root).
 *
 * @param {{
 *   id: string,
 *   parentId?: string | null,
 *   timestamp?: string,
 *   agentVersionId: string,
 *   configHash: string,
 *   workspaceId: string,
 *   journalHighWaterMark: number,
 *   journalDigest: string,
 *   piSdkVersion?: string,
 *   agentSessionId: string,
 * }} input
 */
export function buildProtectedManifestEntry(input) {
  const timestamp = input.timestamp || new Date().toISOString();
  const parentId =
    input.parentId === undefined ? null : input.parentId;
  return {
    type: 'custom',
    id: String(input.id),
    parentId,
    timestamp,
    customType: PLATFORM_MANIFEST_CUSTOM_TYPE,
    data: {
      agentSessionId: input.agentSessionId,
      agentVersionId: input.agentVersionId,
      configHash: input.configHash,
      workspaceId: input.workspaceId,
      journalHighWaterMark: Number(input.journalHighWaterMark),
      journalDigest: String(input.journalDigest),
      piSdkVersion: input.piSdkVersion ?? PINNED_PI_SDK_VERSION,
      piSessionJsonlVersion: PI_SESSION_JSONL_VERSION,
    },
  };
}

/**
 * @param {object[]} entries
 * @returns {object | null}
 */
export function findProtectedManifest(entries) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (
      e &&
      e.type === 'custom' &&
      e.customType === PLATFORM_MANIFEST_CUSTOM_TYPE
    ) {
      return e;
    }
  }
  return null;
}

/**
 * @param {unknown} payload
 * @returns {string}
 */
function materializeChecksum(payload) {
  const normalized = validateSnapshotPayload(payload);
  materializeJsonl(normalized);
  return checksumSnapshotPayload(normalized);
}

export class SessionRecoveryService {
  /**
   * @param {{
   *   transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> },
   *   createRepositories: (db: any) => {
   *     sessions: any,
   *     sessionSnapshots: any,
   *     journal: any,
   *     runEvents?: any,
   *     outbox?: any,
   *     runs?: any,
   *     catalog?: any,
   *   },
   *   generateId: () => string,
   *   now?: () => Date,
   *   runtimePiSdkVersion?: string,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.transactionManager?.run) {
      throw new Error('SessionRecoveryService requires transactionManager.run');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('SessionRecoveryService requires createRepositories');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('SessionRecoveryService requires generateId');
    }
    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.generateId = deps.generateId;
    this.now = deps.now ?? (() => new Date());
    this.runtimePiSdkVersion =
      deps.runtimePiSdkVersion ?? PINNED_PI_SDK_VERSION;
  }

  /**
   * Recover a logical Pi snapshot payload for runtime open.
   *
   * @param {{
   *   agentSessionId: string,
   *   orgId: string,
   *   userId: string,
   *   executionFenceToken: number,
   *   workspaceId?: string,
   *   agentVersionId?: string,
   *   cwd?: string,
   *   markSuspendedOnFailure?: boolean,
   * }} input
   * @returns {Promise<{
   *   source: 'snapshot'|'journal'|'empty',
   *   payload: { header: object, entries: object[] } | null,
   *   checksum: string | null,
   *   snapshotVersion: number,
   *   journalDigest: string | null,
   * }>}
   */
  async recover(input) {
    const agentSessionId = assertUlid(input.agentSessionId, 'agentSessionId');
    const scope = {
      orgId: assertUlid(input.orgId, 'orgId'),
      userId: assertUlid(input.userId, 'userId'),
    };
    const fence = Number(input.executionFenceToken);

    try {
      return await this.#recoverInner({
        agentSessionId,
        scope,
        fence,
        workspaceId: input.workspaceId,
        agentVersionId: input.agentVersionId,
        cwd: input.cwd,
      });
    } catch (err) {
      if (
        err instanceof SessionRecoveryRequiredError ||
        err instanceof SessionFenceConflictError
      ) {
        throw err;
      }
      if (input.markSuspendedOnFailure !== false) {
        await this.#tryMarkRecoveryRequired(
          agentSessionId,
          scope,
          fence,
          err,
        );
      }
      throw new SessionRecoveryRequiredError(
        `Session recovery required: ${String(/** @type {Error} */ (err)?.message || err)}`,
        {
          agentSessionId,
          recoveryReasonCode: RECOVERY_REASON_CODE.RECOVERY_REQUIRED,
          cause: err,
        },
      );
    }
  }

  /**
   * @param {{
   *   agentSessionId: string,
   *   scope: { orgId: string, userId: string },
   *   fence: number,
   *   workspaceId?: string,
   *   agentVersionId?: string,
   *   cwd?: string,
   * }} args
   */
  async #recoverInner(args) {
    const { agentSessionId, scope, fence } = args;

    const { session, snapshot, journal } = await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const session = await repos.sessions.assertExecutionFence(
        agentSessionId,
        scope,
        fence,
        { forUpdate: true, requireActive: true },
      );

      let snapshot = null;
      try {
        snapshot = await repos.sessionSnapshots.loadLatest(
          agentSessionId,
          scope,
          { verifyChecksum: true, requireCompatible: true },
        );
      } catch (err) {
        if (err instanceof SessionSnapshotError) {
          snapshot = { __error: err };
        } else {
          throw err;
        }
      }

      const journal = await repos.journal.loadPayload(agentSessionId, scope);
      return { session, snapshot, journal };
    });

    // Identity checks against durable session row.
    if (args.workspaceId && session.workspaceId !== args.workspaceId) {
      await this.#markAndThrow(
        agentSessionId,
        scope,
        fence,
        RECOVERY_REASON_CODE.RECOVERY_REQUIRED,
        'workspaceId does not match session',
      );
    }
    if (args.agentVersionId && session.agentVersionId !== args.agentVersionId) {
      await this.#markAndThrow(
        agentSessionId,
        scope,
        fence,
        RECOVERY_REASON_CODE.RECOVERY_REQUIRED,
        'agentVersionId does not match session',
      );
    }

    const journalComplete =
      journal.header != null || journal.entries.length > 0;
    const journalPayload =
      journal.header != null
        ? validateSnapshotPayload({
            header: journal.header,
            entries: journal.entries,
          })
        : null;
    const journalChecksum = journalPayload
      ? materializeChecksum(journalPayload)
      : null;

    // Case: empty session (no snapshot pointer, no journal)
    if (
      (!snapshot || snapshot.__error) &&
      !journalComplete &&
      Number(session.piSessionVersion) === 0
    ) {
      return {
        source: 'empty',
        payload: null,
        checksum: null,
        snapshotVersion: 0,
        journalDigest: journal.digest,
      };
    }

    // Case: usable pointed snapshot (acceleration). Cross-check journal when present.
    if (snapshot && !snapshot.__error) {
      const snapPayload = validateSnapshotPayload(snapshot.snapshotJson);
      const snapChecksum = materializeChecksum(snapPayload);

      if (journalComplete && journalChecksum) {
        if (snapChecksum !== journalChecksum) {
          // Both sources exist but disagree → recovery-required (do not auto-pick).
          await this.#markAndThrow(
            agentSessionId,
            scope,
            fence,
            RECOVERY_REASON_CODE.RECOVERY_REQUIRED,
            'snapshot checksum and journal materialization disagree',
          );
        }
        // Latest protected manifest must bind the content-only journal digest.
        const manifest = findProtectedManifest(snapPayload.entries);
        if (
          manifest?.data?.journalDigest &&
          journal.digest &&
          String(manifest.data.journalDigest) !== journal.digest
        ) {
          await this.#markAndThrow(
            agentSessionId,
            scope,
            fence,
            RECOVERY_REASON_CODE.RECOVERY_REQUIRED,
            'protected manifest journalDigest does not match journal rows',
          );
        }
      }

      return {
        source: 'snapshot',
        payload: snapPayload,
        checksum: snapChecksum,
        snapshotVersion: Number(snapshot.snapshotVersion),
        journalDigest: journal.digest,
      };
    }

    // Snapshot missing/corrupt — rebuild from journal
    if (journalComplete && journalPayload && journalChecksum) {
      return {
        source: 'journal',
        payload: journalPayload,
        checksum: journalChecksum,
        snapshotVersion: Number(session.piSessionVersion),
        journalDigest: journal.digest,
      };
    }

    // Neither source complete
    await this.#markAndThrow(
      agentSessionId,
      scope,
      fence,
      snapshot?.__error?.code === 'SNAPSHOT_SDK_VERSION_INCOMPATIBLE'
        ? RECOVERY_REASON_CODE.VERSION_INCOMPATIBLE
        : RECOVERY_REASON_CODE.SNAPSHOT_INVALID,
      snapshot?.__error
        ? `snapshot unusable (${snapshot.__error.code}); journal incomplete`
        : 'no complete snapshot or journal for recovery',
    );
  }

  /**
   * Atomic checkpoint under ACTIVE + expected fence:
   * append missing journal records, appendAndAdvance snapshot, last_run_id,
   * session.snapshot.saved RunEvent+Outbox.
   *
   * Snapshot checksum must equal deterministic materialized journal JSONL bytes.
   *
   * @param {{
   *   agentSessionId: string,
   *   orgId: string,
   *   userId: string,
   *   executionFenceToken: number,
   *   runId: string,
   *   traceId: string,
   *   payload: { header: object, entries: object[] },
   *   workspacePath?: string | null,
   *   agentVersionId: string,
   *   configHash: string,
   *   workspaceId: string,
   *   piSdkVersion?: string,
   * }} input
   */
  async checkpoint(input) {
    const agentSessionId = assertUlid(input.agentSessionId, 'agentSessionId');
    const scope = {
      orgId: assertUlid(input.orgId, 'orgId'),
      userId: assertUlid(input.userId, 'userId'),
    };
    const fence = Number(input.executionFenceToken);
    const runId = assertUlid(input.runId, 'runId');
    const traceId = String(input.traceId || '');
    const agentVersionId = assertUlid(input.agentVersionId, 'agentVersionId');
    const workspaceId = assertUlid(input.workspaceId, 'workspaceId');
    const configHash = String(input.configHash || '');
    const piSdkVersion = input.piSdkVersion ?? this.runtimePiSdkVersion;

    const entries = [...(input.payload?.entries || [])];

    return this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const session = await repos.sessions.assertExecutionFence(
        agentSessionId,
        scope,
        fence,
        { forUpdate: true, requireActive: true },
      );

      if (session.agentVersionId !== agentVersionId) {
        throw new SessionFenceConflictError(
          'checkpoint agentVersionId does not match session',
          { agentSessionId, expectedToken: fence, actualToken: fence },
        );
      }
      if (session.workspaceId !== workspaceId) {
        throw new SessionFenceConflictError(
          'checkpoint workspaceId does not match session',
          { agentSessionId, expectedToken: fence, actualToken: fence },
        );
      }

      const normalizedBase = validateSnapshotPayload({
        header: input.payload.header,
        entries,
      });

      // Content entries only (strip any client-supplied platform manifests first).
      const contentEntries = normalizedBase.entries.filter(
        (e) =>
          !(
            e &&
            e.type === 'custom' &&
            e.customType === PLATFORM_MANIFEST_CUSTOM_TYPE
          ),
      );

      await repos.journal.appendMissingFromPayload({
        agentSessionId,
        orgId: scope.orgId,
        userId: scope.userId,
        runId,
        header: normalizedBase.header,
        entries: contentEntries,
        generateId: this.generateId,
      });

      let journalAfter = await repos.journal.loadPayload(
        agentSessionId,
        scope,
      );
      if (!journalAfter.header) {
        throw new SessionJournalError('journal missing header after append', {
          code: 'JOURNAL_INCOMPLETE',
          agentSessionId,
        });
      }

      // Append-only protected manifest attached to current content leaf
      // (not a new root). Empty content → sole root parentId null.
      const contentOnly = journalAfter.entries.filter(
        (e) =>
          !(
            e &&
            e.type === 'custom' &&
            e.customType === PLATFORM_MANIFEST_CUSTOM_TYPE
          ),
      );
      const leafId = findLeafEntryId(contentOnly);
      const manifest = buildProtectedManifestEntry({
        id: this.generateId(),
        parentId: leafId,
        agentSessionId,
        agentVersionId,
        configHash,
        workspaceId,
        journalHighWaterMark: journalAfter.highWaterSequence,
        journalDigest: journalAfter.digest,
        piSdkVersion,
      });
      await repos.journal.appendEntry({
        messageId: this.generateId(),
        agentSessionId,
        orgId: scope.orgId,
        userId: scope.userId,
        runId,
        entry: manifest,
      });
      journalAfter = await repos.journal.loadPayload(agentSessionId, scope);

      const journalFull = journalAfter;
      const journalPayload = validateSnapshotPayload({
        header: journalFull.header,
        entries: journalFull.entries,
      });
      const committedChecksum = materializeChecksum(journalPayload);

      const expectedPi = Number(session.piSessionVersion);
      const snapshotVersion = expectedPi + 1;
      const snapshotId = assertUlid(this.generateId(), 'snapshotId');

      // Fence gate immediately before snapshot write.
      await repos.sessions.assertExecutionFence(
        agentSessionId,
        scope,
        fence,
        { forUpdate: true, requireActive: true },
      );

      const snap = await repos.sessionSnapshots.appendAndAdvance({
        snapshotId,
        agentSessionId,
        orgId: scope.orgId,
        userId: scope.userId,
        snapshotVersion,
        expectedPiSessionVersion: expectedPi,
        expectedExecutionFenceToken: fence,
        snapshotFormat: SNAPSHOT_FORMAT.PI_JSONL_V3,
        snapshotJson: journalPayload,
        workspacePath: input.workspacePath ?? null,
        piSdkVersion,
        checksum: committedChecksum,
      });

      // last_run_id under same ACTIVE + fence CAS (no general update()).
      await repos.sessions.updateLastRunIdIfFence(agentSessionId, scope, {
        expectedFenceToken: fence,
        lastRunId: runId,
      });

      // session.snapshot.saved RunEvent + Outbox
      if (repos.runEvents && repos.outbox) {
        const eventId = assertUlid(this.generateId(), 'eventId');
        const outboxId = assertUlid(this.generateId(), 'outboxId');
        const event = await repos.runEvents.append({
          eventId,
          runId,
          orgId: scope.orgId,
          userId: scope.userId,
          eventType: 'session.snapshot.saved',
          eventVersion: 1,
          payloadJson: {
            agentSessionId,
            snapshotId: snap.snapshotId,
            snapshotVersion: snap.snapshotVersion,
            checksum: committedChecksum,
            piSessionVersion: snap.snapshotVersion,
            journalDigest: journalFull.digest,
            journalHighWaterMark: journalFull.highWaterSequence,
          },
          traceId,
        });
        await repos.outbox.insert({
          outboxId,
          aggregateType: AGGREGATE_TYPE_RUN,
          aggregateId: runId,
          eventType: 'session.snapshot.saved',
          payloadJson: {
            eventId: event.eventId,
            runId,
            sequence: event.sequenceNo,
            type: 'session.snapshot.saved',
            agentSessionId,
            snapshotVersion: snap.snapshotVersion,
            orgId: scope.orgId,
            userId: scope.userId,
          },
        });
      }

      return {
        snapshot: snap,
        checksum: committedChecksum,
        journalDigest: journalFull.digest,
        payload: journalPayload,
      };
    });
  }

  /**
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {number} fence
   * @param {string} reason
   * @param {string} message
   */
  async #markAndThrow(agentSessionId, scope, fence, reason, message) {
    await this.#tryMarkRecoveryRequired(
      agentSessionId,
      scope,
      fence,
      new Error(message),
      reason,
    );
    throw new SessionRecoveryRequiredError(message, {
      agentSessionId,
      recoveryReasonCode: reason,
    });
  }

  /**
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {number} fence
   * @param {unknown} err
   * @param {string} [reason]
   */
  async #tryMarkRecoveryRequired(
    agentSessionId,
    scope,
    fence,
    err,
    reason = RECOVERY_REASON_CODE.RECOVERY_REQUIRED,
  ) {
    try {
      await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        await repos.sessions.markRecoveryRequiredIfFence(
          agentSessionId,
          scope,
          {
            expectedFenceToken: fence,
            recoveryReasonCode: reason,
          },
        );
      });
    } catch (markErr) {
      // Stale fence — do not claim recovery mark from a non-owner.
      if (markErr instanceof SessionFenceConflictError) {
        return;
      }
      // Swallow secondary failures; original recovery error is primary.
      void err;
    }
  }
}

/**
 * @param {{ header?: object, entries?: object[], cwd?: string, id?: string }} opts
 */
export function emptySessionPayload(opts = {}) {
  const header =
    opts.header ||
    buildSessionHeader({
      id: opts.id || 'new-session',
      cwd: opts.cwd || '',
    });
  return validateSnapshotPayload({
    header,
    entries: opts.entries || [],
  });
}

/**
 * Digest helper for tests.
 * @param {string} text
 */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
