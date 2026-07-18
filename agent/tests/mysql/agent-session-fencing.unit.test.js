/**
 * AgentSessionRepository + Snapshot fencing/CAS (PR-05) — fake knex offline.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from './fake-knex.js';
import { AgentSessionRepository } from '../../src/infrastructure/mysql/repositories/agent-session-repository.js';
import {
  AgentSessionSnapshotRepository,
  checksumSnapshotPayload,
  SNAPSHOT_FORMAT,
} from '../../src/infrastructure/mysql/repositories/agent-session-snapshot-repository.js';
import { ConflictError, NotFoundError } from '../../src/infrastructure/mysql/errors.js';
import {
  SessionFenceConflictError,
  SessionSnapshotError,
  InvalidSessionTransitionError,
} from '../../src/domain/session/errors.js';
import { RECOVERY_REASON_CODE } from '../../src/domain/session/index.js';
import {
  SNAPSHOTS_FORBID_UPDATE_TRIGGER,
  SNAPSHOTS_FORBID_DELETE_TRIGGER,
} from '../../src/infrastructure/mysql/migrations/20260718000006_agent_session_snapshot_fencing.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const USER2 = '01K0G2PAV8FPMVC9QHJG7JPN5A';
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const SBX = '01K0G2PAV8FPMVC9QHJG7JPN55';
const WSP = '01K0G2PAV8FPMVC9QHJG7JPN56';
const SNAP = '01K0G2PAV8FPMVC9QHJG7JPN5D';
const SNAP2 = '01K0G2PAV8FPMVC9QHJG7JPN5E';

function sessionRow(overrides = {}) {
  return {
    agent_session_id: SESS,
    org_id: ORG,
    user_id: USER,
    conversation_id: CONV,
    agent_version_id: VER,
    sandbox_session_id: SBX,
    workspace_id: WSP,
    status: 'ACTIVE',
    pi_session_version: 0,
    last_run_id: null,
    execution_fence_token: 3,
    recovery_reason_code: null,
    created_at: '2026-07-18 00:00:00.000',
    updated_at: '2026-07-18 00:00:00.000',
    closed_at: null,
    ...overrides,
  };
}

function samplePayload(entries = []) {
  return {
    header: {
      type: 'session',
      version: 3,
      id: 'sess-1',
      timestamp: '2026-07-18T00:00:00.000Z',
      cwd: '/tmp/ws',
    },
    entries,
  };
}

describe('AgentSessionRepository fencing/CAS', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  const scope = { orgId: ORG, userId: USER };

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    state.tables.agent_sessions = [sessionRow()];
    state.tables.agent_session_snapshots = [];
  });

  it('maps fence + recovery fields and scopes getById', async () => {
    const repo = new AgentSessionRepository(knex);
    const row = await repo.getById(SESS, scope);
    assert.equal(row.executionFenceToken, 3);
    assert.equal(await repo.getById(SESS, { orgId: ORG, userId: USER2 }), null);
  });

  it('transitionIf validates SM edges and rejects ACTIVE→CLOSED', async () => {
    const repo = new AgentSessionRepository(knex);
    await assert.rejects(
      () =>
        repo.transitionIf(SESS, scope, {
          expectedStatus: 'ACTIVE',
          status: 'CLOSED',
        }),
      InvalidSessionTransitionError,
    );
  });

  it('transitionIf ACTIVE→CLOSING→CLOSED', async () => {
    const repo = new AgentSessionRepository(knex);
    const closing = await repo.transitionIf(SESS, scope, {
      expectedStatus: 'ACTIVE',
      status: 'CLOSING',
    });
    assert.equal(closing.status, 'CLOSING');
    const closed = await repo.transitionIf(SESS, scope, {
      expectedStatus: 'CLOSING',
      status: 'CLOSED',
    });
    assert.equal(closed.status, 'CLOSED');
    assert.ok(closed.closedAt);
  });

  it('markRecoveryRequired requires fence CAS; ACTIVE→SUSPENDED; rejects CREATING', async () => {
    const repo = new AgentSessionRepository(knex);
    await assert.rejects(
      () => repo.markRecoveryRequired(SESS, scope, {}),
      /expectedExecutionFenceToken/,
    );
    const s = await repo.markRecoveryRequired(SESS, scope, {
      expectedExecutionFenceToken: 3,
    });
    assert.equal(s.status, 'SUSPENDED');
    assert.equal(s.recoveryReasonCode, 'RECOVERY_REQUIRED');

    // re-reason under same fence
    const s2 = await repo.markRecoveryRequired(SESS, scope, {
      expectedExecutionFenceToken: 3,
      recoveryReasonCode: RECOVERY_REASON_CODE.SNAPSHOT_INVALID,
    });
    assert.equal(s2.recoveryReasonCode, 'SNAPSHOT_INVALID');

    state.tables.agent_sessions[0].status = 'CREATING';
    state.tables.agent_sessions[0].recovery_reason_code = null;
    state.tables.agent_sessions[0].execution_fence_token = 3;
    await assert.rejects(
      () =>
        repo.markRecoveryRequired(SESS, scope, {
          expectedExecutionFenceToken: 3,
        }),
      InvalidSessionTransitionError,
    );
  });

  it('update() disabled; updateLastRunIdIfFence is the only last_run_id path', async () => {
    const repo = new AgentSessionRepository(knex);
    await assert.rejects(() => repo.update(), /disabled|updateLastRunIdIfFence/);
    await assert.rejects(
      () => repo.advancePiSessionVersionIf(),
      /disabled|appendAndAdvance/,
    );
    const s = await repo.updateLastRunIdIfFence(SESS, scope, {
      expectedFenceToken: 3,
      lastRunId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
    });
    assert.equal(s.lastRunId, '01K0G2PAV8FPMVC9QHJG7JPN5H');
  });

  it('advanceExecutionFence is monotonic CAS', async () => {
    const repo = new AgentSessionRepository(knex);
    const r1 = await repo.advanceExecutionFence(SESS, scope, { expectedToken: 3 });
    assert.equal(r1.fenceToken, 4);
    await assert.rejects(
      () => repo.advanceExecutionFence(SESS, scope, { expectedToken: 3 }),
      SessionFenceConflictError,
    );
  });

  it('acquireNextExecutionFence requires ACTIVE and assertExecutionFence gates writers', async () => {
    const repo = new AgentSessionRepository(knex);
    const { fenceToken } = await repo.acquireNextExecutionFence(SESS, scope);
    assert.equal(fenceToken, 4);
    await repo.assertExecutionFence(SESS, scope, 4);
    await assert.rejects(
      () => repo.assertExecutionFence(SESS, scope, 3),
      SessionFenceConflictError,
    );
    state.tables.agent_sessions[0].status = 'SUSPENDED';
    await assert.rejects(
      () => repo.acquireNextExecutionFence(SESS, scope),
      SessionFenceConflictError,
    );
  });

  it('acquireExecutionFenceForRun requires runId and validates owned RUNNING run', async () => {
    const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
    const repo = new AgentSessionRepository(knex);
    state.tables.runs = [
      {
        run_id: RUN,
        org_id: ORG,
        user_id: USER,
        conversation_id: CONV,
        agent_session_id: SESS,
        agent_version_id: VER,
        status: 'RUNNING',
        created_at: '2026-07-18 00:00:00.000',
        updated_at: '2026-07-18 00:00:00.000',
      },
    ];

    // runId required before any fence advance
    await assert.rejects(
      () =>
        repo.acquireExecutionFenceForRun(SESS, scope, {
          conversationId: CONV,
          agentVersionId: VER,
        }),
      /runId is required/,
    );
    assert.equal(state.tables.agent_sessions[0].execution_fence_token, 3);

    // session conversation mismatch — fence unchanged
    await assert.rejects(
      () =>
        repo.acquireExecutionFenceForRun(SESS, scope, {
          conversationId: '01K0G2PAV8FPMVC9QHJG7JPN99',
          agentVersionId: VER,
          runId: RUN,
        }),
      /conversation binding/i,
    );
    assert.equal(state.tables.agent_sessions[0].execution_fence_token, 3);

    // agentVersion mismatch — fence unchanged
    await assert.rejects(
      () =>
        repo.acquireExecutionFenceForRun(SESS, scope, {
          conversationId: CONV,
          agentVersionId: '01K0G2PAV8FPMVC9QHJG7JPN99',
          runId: RUN,
        }),
      /agentVersion binding/i,
    );
    assert.equal(state.tables.agent_sessions[0].execution_fence_token, 3);

    // missing run — fence unchanged
    await assert.rejects(
      () =>
        repo.acquireExecutionFenceForRun(SESS, scope, {
          conversationId: CONV,
          agentVersionId: VER,
          runId: '01K0G2PAV8FPMVC9QHJG7JPN5Z',
        }),
      NotFoundError,
    );
    assert.equal(state.tables.agent_sessions[0].execution_fence_token, 3);

    // cross-owner run — fence unchanged
    state.tables.runs[0].user_id = USER2;
    await assert.rejects(
      () =>
        repo.acquireExecutionFenceForRun(SESS, scope, {
          conversationId: CONV,
          agentVersionId: VER,
          runId: RUN,
        }),
      NotFoundError,
    );
    assert.equal(state.tables.agent_sessions[0].execution_fence_token, 3);
    state.tables.runs[0].user_id = USER;

    // run bound to other session — fence unchanged
    state.tables.runs[0].agent_session_id = '01K0G2PAV8FPMVC9QHJG7JPN99';
    await assert.rejects(
      () =>
        repo.acquireExecutionFenceForRun(SESS, scope, {
          conversationId: CONV,
          agentVersionId: VER,
          runId: RUN,
        }),
      /agent_session_id binding/i,
    );
    assert.equal(state.tables.agent_sessions[0].execution_fence_token, 3);
    state.tables.runs[0].agent_session_id = SESS;

    // non-RUNNING run — fence unchanged
    state.tables.runs[0].status = 'SUCCEEDED';
    await assert.rejects(
      () =>
        repo.acquireExecutionFenceForRun(SESS, scope, {
          conversationId: CONV,
          agentVersionId: VER,
          runId: RUN,
        }),
      /RUNNING run/i,
    );
    assert.equal(state.tables.agent_sessions[0].execution_fence_token, 3);
    state.tables.runs[0].status = 'RUNNING';

    // success advances fence exactly once
    const { fenceToken } = await repo.acquireExecutionFenceForRun(SESS, scope, {
      conversationId: CONV,
      agentVersionId: VER,
      runId: RUN,
    });
    assert.equal(fenceToken, 4);
    assert.equal(state.tables.agent_sessions[0].execution_fence_token, 4);
  });

  it('markRecoveryRequiredIfFence is fence-CAS gated', async () => {
    const repo = new AgentSessionRepository(knex);
    await assert.rejects(
      () =>
        repo.markRecoveryRequiredIfFence(SESS, scope, {
          expectedFenceToken: 99,
        }),
      SessionFenceConflictError,
    );
    const s = await repo.markRecoveryRequiredIfFence(SESS, scope, {
      expectedFenceToken: 3,
      recoveryReasonCode: RECOVERY_REASON_CODE.RECOVERY_REQUIRED,
    });
    assert.equal(s.status, 'SUSPENDED');
    assert.equal(s.recoveryReasonCode, 'RECOVERY_REQUIRED');
  });
});

describe('AgentSessionSnapshotRepository atomic appendAndAdvance', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  const scope = { orgId: ORG, userId: USER };

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    state.tables.agent_sessions = [sessionRow()];
    state.tables.agent_session_snapshots = [];
  });

  it('checksum is SHA-256 of materialized JSONL (shared with adapter)', async () => {
    const payload = samplePayload([
      {
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: '2026-07-18T00:00:01.000Z',
        message: { role: 'user', content: 'hi', timestamp: 1 },
      },
    ]);
    const fromRepo = checksumSnapshotPayload(payload);
    const { materializeJsonl, checksumJsonl } = await import(
      '../../src/infrastructure/pi/pi-jsonl-codec.js'
    );
    assert.equal(fromRepo, checksumJsonl(materializeJsonl(payload)));
  });

  it('appendAndAdvance commits snapshot + pointer under fence', async () => {
    const repo = new AgentSessionSnapshotRepository(knex, {
      runtimePiSdkVersion: '0.80.3',
    });
    const payload = samplePayload();
    const snap = await repo.appendAndAdvance({
      snapshotId: SNAP,
      agentSessionId: SESS,
      orgId: ORG,
      userId: USER,
      snapshotVersion: 1,
      expectedPiSessionVersion: 0,
      expectedExecutionFenceToken: 3,
      snapshotFormat: SNAPSHOT_FORMAT.PI_JSONL_V3,
      snapshotJson: payload,
      piSdkVersion: '0.80.3',
    });
    assert.equal(snap.snapshotVersion, 1);
    assert.equal(snap.capturedFenceToken, 3);
    assert.equal(snap.checksum, checksumSnapshotPayload(payload));
    assert.equal(state.tables.agent_sessions[0].pi_session_version, 1);
  });

  it('CAS loser rolls back insert (no orphan snapshot)', async () => {
    const repo = new AgentSessionSnapshotRepository(knex);
    // Force CAS fail: fence mismatch after insert would roll back whole trx.
    await assert.rejects(
      () =>
        repo.appendAndAdvance({
          snapshotId: SNAP,
          agentSessionId: SESS,
          orgId: ORG,
          userId: USER,
          snapshotVersion: 1,
          expectedPiSessionVersion: 0,
          expectedExecutionFenceToken: 99, // stale fence
          snapshotJson: samplePayload(),
          piSdkVersion: '0.80.3',
        }),
      ConflictError,
    );
    assert.equal(state.tables.agent_session_snapshots.length, 0);
    assert.equal(state.tables.agent_sessions[0].pi_session_version, 0);
  });

  it('rejects wrong status SUSPENDED / terminal for snapshot write', async () => {
    const repo = new AgentSessionSnapshotRepository(knex);
    state.tables.agent_sessions[0].status = 'SUSPENDED';
    await assert.rejects(
      () =>
        repo.appendAndAdvance({
          snapshotId: SNAP,
          agentSessionId: SESS,
          orgId: ORG,
          userId: USER,
          snapshotVersion: 1,
          expectedPiSessionVersion: 0,
          expectedExecutionFenceToken: 3,
          snapshotJson: samplePayload(),
        }),
      ConflictError,
    );
  });

  it('rejects foreign owner', async () => {
    const repo = new AgentSessionSnapshotRepository(knex);
    await assert.rejects(
      () =>
        repo.appendAndAdvance({
          snapshotId: SNAP,
          agentSessionId: SESS,
          orgId: ORG,
          userId: USER2,
          snapshotVersion: 1,
          expectedPiSessionVersion: 0,
          expectedExecutionFenceToken: 3,
          snapshotJson: samplePayload(),
        }),
      NotFoundError,
    );
  });

  it('requires snapshotVersion === expectedPiSessionVersion+1', async () => {
    const repo = new AgentSessionSnapshotRepository(knex);
    await assert.rejects(
      () =>
        repo.appendAndAdvance({
          snapshotId: SNAP,
          agentSessionId: SESS,
          orgId: ORG,
          userId: USER,
          snapshotVersion: 2,
          expectedPiSessionVersion: 0,
          expectedExecutionFenceToken: 3,
          snapshotJson: samplePayload(),
        }),
      SessionSnapshotError,
    );
  });

  it('detects checksum corruption on loadLatest via re-materialize', async () => {
    const repo = new AgentSessionSnapshotRepository(knex);
    await repo.appendAndAdvance({
      snapshotId: SNAP,
      agentSessionId: SESS,
      orgId: ORG,
      userId: USER,
      snapshotVersion: 1,
      expectedPiSessionVersion: 0,
      expectedExecutionFenceToken: 3,
      snapshotJson: samplePayload(),
      piSdkVersion: '0.80.3',
    });
    state.tables.agent_session_snapshots[0].checksum = 'a'.repeat(64);
    await assert.rejects(
      () => repo.loadLatest(SESS, scope),
      (err) =>
        err instanceof SessionSnapshotError &&
        err.code === 'SNAPSHOT_CHECKSUM_MISMATCH',
    );
  });

  it('version race on pi_session_version rolls back', async () => {
    const repo = new AgentSessionSnapshotRepository(knex);
    // Concurrent pointer advance simulation: expected 0 but actual 5.
    state.tables.agent_sessions[0].pi_session_version = 5;
    await assert.rejects(
      () =>
        repo.appendAndAdvance({
          snapshotId: SNAP,
          agentSessionId: SESS,
          orgId: ORG,
          userId: USER,
          snapshotVersion: 1,
          expectedPiSessionVersion: 0,
          expectedExecutionFenceToken: 3,
          snapshotJson: samplePayload(),
          piSdkVersion: '0.80.3',
        }),
      ConflictError,
    );
    assert.equal(state.tables.agent_session_snapshots.length, 0);
  });

  it('loadLatest uses pi_session_version pointer, ignores stray higher version', async () => {
    const repo = new AgentSessionSnapshotRepository(knex, {
      runtimePiSdkVersion: '0.80.3',
    });
    await repo.appendAndAdvance({
      snapshotId: SNAP,
      agentSessionId: SESS,
      orgId: ORG,
      userId: USER,
      snapshotVersion: 1,
      expectedPiSessionVersion: 0,
      expectedExecutionFenceToken: 3,
      snapshotJson: samplePayload(),
      piSdkVersion: '0.80.3',
    });
    // Stray higher row not reflected by pointer (must not become "latest").
    state.tables.agent_session_snapshots.push({
      snapshot_id: SNAP2,
      agent_session_id: SESS,
      snapshot_version: 99,
      snapshot_format: 'pi_jsonl_v3',
      snapshot_json: samplePayload(),
      workspace_path: null,
      checksum: checksumSnapshotPayload(samplePayload()),
      pi_sdk_version: '0.80.3',
      captured_fence_token: 3,
      created_at: '2026-07-18 00:00:01.000',
    });
    assert.equal(state.tables.agent_sessions[0].pi_session_version, 1);
    const loaded = await repo.loadLatest(SESS, scope);
    assert.equal(loaded.snapshotVersion, 1);
    assert.equal(loaded.snapshotId, SNAP);
  });

  it('loadLatest fails closed when pointed row is missing', async () => {
    const repo = new AgentSessionSnapshotRepository(knex);
    state.tables.agent_sessions[0].pi_session_version = 2;
    state.tables.agent_session_snapshots = [];
    await assert.rejects(
      () => repo.loadLatest(SESS, scope),
      (err) =>
        err instanceof SessionSnapshotError &&
        err.code === 'SNAPSHOT_POINTER_MISSING',
    );
  });

  it('loadLatest returns null only when pointer is 0', async () => {
    const repo = new AgentSessionSnapshotRepository(knex);
    assert.equal(state.tables.agent_sessions[0].pi_session_version, 0);
    assert.equal(await repo.loadLatest(SESS, scope), null);
  });

  it('assertPiSdkVersionCompatible requires exact equality', async () => {
    const {
      assertPiSdkVersionCompatible,
    } = await import(
      '../../src/infrastructure/mysql/repositories/agent-session-snapshot-repository.js'
    );
    assert.equal(assertPiSdkVersionCompatible('0.80.3', '0.80.3'), true);
    assert.throws(
      () => assertPiSdkVersionCompatible('0.80.3', '0.80.4'),
      (err) =>
        err instanceof SessionSnapshotError &&
        err.code === 'SNAPSHOT_SDK_VERSION_INCOMPATIBLE',
    );
    // No same-major/minor soft match
    assert.throws(
      () => assertPiSdkVersionCompatible('0.80.0', '0.80.3'),
      SessionSnapshotError,
    );
  });

  it('does not expose appendWithoutPointerAdvance', () => {
    assert.equal(
      AgentSessionSnapshotRepository.prototype.appendWithoutPointerAdvance,
      undefined,
    );
  });
});

describe('snapshot migration append-only triggers (static)', () => {
  it('migration 00006 defines forbid UPDATE/DELETE triggers and drops them in down', () => {
    const file = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src/infrastructure/mysql/migrations/20260718000006_agent_session_snapshot_fencing.js',
    );
    const src = readFileSync(file, 'utf8');
    assert.ok(src.includes(SNAPSHOTS_FORBID_UPDATE_TRIGGER));
    assert.ok(src.includes(SNAPSHOTS_FORBID_DELETE_TRIGGER));
    assert.ok(src.includes('captured_fence_token'));
    assert.ok(src.includes('DROP TRIGGER IF EXISTS'));
    assert.ok(/BEFORE UPDATE ON agent_session_snapshots/.test(src));
    assert.ok(/BEFORE DELETE ON agent_session_snapshots/.test(src));
  });
});
