/**
 * Session recovery + atomic checkpoint (PR-05 slice B) — offline fakes.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import {
  SessionRecoveryService,
  buildProtectedManifestEntry,
  findProtectedManifest,
} from '../../src/application/session-recovery-service.js';
import {
  SessionRecoveryRequiredError,
  SessionFenceConflictError,
} from '../../src/domain/session/errors.js';
import {
  checksumSnapshotPayload,
  validateSnapshotPayload,
} from '../../src/infrastructure/pi/pi-jsonl-codec.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { SNAPSHOT_FORMAT } from '../../src/infrastructure/mysql/repositories/agent-session-snapshot-repository.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const WSP = '01K0G2PAV8FPMVC9QHJG7JPN5G';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const SBX = '01K0G2PAV8FPMVC9QHJG7JPN5F';

function basePayload(entries = []) {
  return validateSnapshotPayload({
    header: {
      type: 'session',
      version: 3,
      id: 'pi-1',
      timestamp: '2026-07-18T00:00:00.000Z',
      cwd: '/ws',
    },
    entries,
  });
}

function entry(id, text, parentId = null) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-07-18T00:00:01.000Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  };
}

function seedWorld(state, fence = 1) {
  state.tables.conversations = [
    {
      conversation_id: CONV,
      org_id: ORG,
      user_id: USER,
      agent_id: '01K0G2PAV8FPMVC9QHJG7JPN5D',
      title: null,
      status: 'active',
      current_agent_session_id: SESS,
      created_at: '2026-07-18 00:00:00.000',
      updated_at: '2026-07-18 00:00:00.000',
      archived_at: null,
    },
  ];
  state.tables.agent_sessions = [
    {
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
      execution_fence_token: fence,
      recovery_reason_code: null,
      created_at: '2026-07-18 00:00:00.000',
      updated_at: '2026-07-18 00:00:00.000',
      closed_at: null,
    },
  ];
  state.tables.agent_session_snapshots = [];
  state.tables.messages = [];
  state.tables.runs = [
    {
      run_id: RUN,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONV,
      agent_session_id: SESS,
      agent_version_id: VER,
      triggering_message_id: '01K0G2PAV8FPMVC9QHJG7JPN5J',
      source: 'api',
      status: 'RUNNING',
      status_reason: null,
      queue_name: 'runs',
      attempt: 1,
      trace_id: 'a'.repeat(32),
      next_event_sequence: 0,
      cancel_requested_at: null,
      cancel_reason: null,
      started_at: '2026-07-18 00:00:00.000',
      completed_at: null,
      created_at: '2026-07-18 00:00:00.000',
      updated_at: '2026-07-18 00:00:00.000',
    },
  ];
  state.tables.run_events = [];
  state.tables.domain_outbox = [];
}

describe('SessionRecoveryService', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  /** @type {SessionRecoveryService} */
  let service;
  const scope = { orgId: ORG, userId: USER };
  const nextId = createUlidGenerator({ now: () => 1_721_278_800_000 });

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seedWorld(state, 2);
    const generateId = nextId;
    service = new SessionRecoveryService({
      transactionManager: {
        run: (fn) => knex.transaction(fn),
      },
      createRepositories: (db) =>
        createRepositoryBundle(db, { now: () => new Date(), generateId }),
      generateId,
      now: () => new Date(),
      runtimePiSdkVersion: '0.80.3',
    });
  });

  it('empty session returns empty source', async () => {
    const r = await service.recover({
      agentSessionId: SESS,
      ...scope,
      executionFenceToken: 2,
      workspaceId: WSP,
      agentVersionId: VER,
    });
    assert.equal(r.source, 'empty');
    assert.equal(r.payload, null);
  });

  it('two sequential checkpoints produce snapshot v1 then v2 with preserved history', async () => {
    const p1 = basePayload([entry('e1', 'one')]);
    const c1 = await service.checkpoint({
      agentSessionId: SESS,
      ...scope,
      executionFenceToken: 2,
      runId: RUN,
      traceId: 'a'.repeat(32),
      payload: p1,
      agentVersionId: VER,
      configHash: 'b'.repeat(64),
      workspaceId: WSP,
      workspacePath: '/ws',
    });
    assert.equal(c1.snapshot.snapshotVersion, 1);
    assert.equal(state.tables.agent_sessions[0].pi_session_version, 1);

    const p2 = basePayload([
      entry('e1', 'one'),
      entry('e2', 'two', 'e1'),
    ]);
    // re-load fence (still 2)
    const c2 = await service.checkpoint({
      agentSessionId: SESS,
      ...scope,
      executionFenceToken: 2,
      runId: RUN,
      traceId: 'a'.repeat(32),
      payload: p2,
      agentVersionId: VER,
      configHash: 'b'.repeat(64),
      workspaceId: WSP,
    });
    assert.equal(c2.snapshot.snapshotVersion, 2);
    assert.equal(state.tables.agent_sessions[0].pi_session_version, 2);
    assert.equal(state.tables.agent_sessions[0].last_run_id, RUN);

    const recovered = await service.recover({
      agentSessionId: SESS,
      ...scope,
      executionFenceToken: 2,
      workspaceId: WSP,
      agentVersionId: VER,
    });
    assert.equal(recovered.source, 'snapshot');
    assert.ok(recovered.payload.entries.length >= 2);
    assert.ok(
      recovered.payload.entries.some((e) => e.id === 'e1') &&
        recovered.payload.entries.some((e) => e.id === 'e2'),
    );
    assert.ok(
      state.tables.run_events.some(
        (e) => e.event_type === 'session.snapshot.saved',
      ),
    );
  });

  it('corrupted/missing snapshot rebuilds from journal', async () => {
    const p1 = basePayload([
      entry('e1', 'keep-me'),
      {
        type: 'message',
        id: 'e2',
        parentId: 'e1',
        timestamp: '2026-07-18T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'x' },
            {
              type: 'toolCall',
              id: 'tc1',
              name: 'bash',
              arguments: { command: 'ls' },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'e3',
        parentId: 'e2',
        timestamp: '2026-07-18T00:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'tc1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        },
      },
      {
        type: 'compaction',
        id: 'e4',
        parentId: 'e3',
        timestamp: '2026-07-18T00:00:04.000Z',
        summary: 'sum',
        firstKeptEntryId: 'e3',
      },
      {
        type: 'branch_summary',
        id: 'e5',
        parentId: 'e4',
        timestamp: '2026-07-18T00:00:05.000Z',
        fromId: 'e1',
        summary: 'branch',
      },
    ]);
    await service.checkpoint({
      agentSessionId: SESS,
      ...scope,
      executionFenceToken: 2,
      runId: RUN,
      traceId: 'a'.repeat(32),
      payload: p1,
      agentVersionId: VER,
      configHash: 'c'.repeat(64),
      workspaceId: WSP,
    });

    // Corrupt snapshot row but leave journal
    state.tables.agent_session_snapshots[0].checksum = '0'.repeat(64);
    // Pointer still 1 — loadLatest will fail checksum

    const recovered = await service.recover({
      agentSessionId: SESS,
      ...scope,
      executionFenceToken: 2,
      workspaceId: WSP,
      agentVersionId: VER,
    });
    assert.equal(recovered.source, 'journal');
    assert.ok(recovered.payload.entries.some((e) => e.type === 'compaction'));
    assert.ok(recovered.payload.entries.some((e) => e.type === 'branch_summary'));
    const toolMsg = recovered.payload.entries.find((e) => e.id === 'e2');
    assert.equal(toolMsg.message.content[1].type, 'toolCall');
  });

  it('checksum mismatch between snapshot and journal suspends RECOVERY_REQUIRED', async () => {
    const p1 = basePayload([entry('e1', 'a')]);
    await service.checkpoint({
      agentSessionId: SESS,
      ...scope,
      executionFenceToken: 2,
      runId: RUN,
      traceId: 'a'.repeat(32),
      payload: p1,
      agentVersionId: VER,
      configHash: 'd'.repeat(64),
      workspaceId: WSP,
    });

    // Mutate snapshot JSON so materialization differs from journal while checksum
    // stored matches the mutated form (simulate divergent truth).
    const bad = basePayload([entry('e1', 'MUTATED')]);
    const badChecksum = checksumSnapshotPayload(bad);
    state.tables.agent_session_snapshots[0].snapshot_json = bad;
    state.tables.agent_session_snapshots[0].checksum = badChecksum;

    await assert.rejects(
      () =>
        service.recover({
          agentSessionId: SESS,
          ...scope,
          executionFenceToken: 2,
          workspaceId: WSP,
          agentVersionId: VER,
        }),
      (err) => err instanceof SessionRecoveryRequiredError,
    );
    assert.equal(state.tables.agent_sessions[0].status, 'SUSPENDED');
    assert.equal(
      state.tables.agent_sessions[0].recovery_reason_code,
      'RECOVERY_REQUIRED',
    );
  });

  it('stale fence cannot checkpoint', async () => {
    const p1 = basePayload([entry('e1', 'x')]);
    await assert.rejects(
      () =>
        service.checkpoint({
          agentSessionId: SESS,
          ...scope,
          executionFenceToken: 99,
          runId: RUN,
          traceId: 'a'.repeat(32),
          payload: p1,
          agentVersionId: VER,
          configHash: 'e'.repeat(64),
          workspaceId: WSP,
        }),
      (err) => err instanceof SessionFenceConflictError,
    );
  });

  it('protected manifest binds agentVersion/workspace/digest', () => {
    const m = buildProtectedManifestEntry({
      id: 'man-1',
      agentSessionId: SESS,
      agentVersionId: VER,
      configHash: 'f'.repeat(64),
      workspaceId: WSP,
      journalHighWaterMark: 3,
      journalDigest: 'a'.repeat(64),
    });
    assert.equal(m.customType, 'platform.session.manifest');
    const found = findProtectedManifest([entry('e1', 't'), m]);
    assert.equal(found.data.agentVersionId, VER);
  });

  it('AgentVersion pin on session is independent of catalog default', async () => {
    // Session stays on VER even if we do not touch catalog.
    const p1 = basePayload([entry('e1', 'pinned')]);
    await service.checkpoint({
      agentSessionId: SESS,
      ...scope,
      executionFenceToken: 2,
      runId: RUN,
      traceId: 'a'.repeat(32),
      payload: p1,
      agentVersionId: VER,
      configHash: '1'.repeat(64),
      workspaceId: WSP,
    });
    assert.equal(state.tables.agent_sessions[0].agent_version_id, VER);
    // Simulate catalog default change (new active version) — session row unchanged
    state.tables.agent_versions = [
      {
        agent_version_id: '01K0G2PAV8FPMVC9QHJG7JPN99',
        agent_id: '01K0G2PAV8FPMVC9QHJG7JPN5D',
        version_no: 2,
        config_json: '{}',
        config_hash: 'f'.repeat(64),
        pi_sdk_version: '0.80.3',
        status: 'active',
        created_by: USER,
        created_at: '2026-07-18 00:00:00.000',
      },
    ];
    assert.equal(state.tables.agent_sessions[0].agent_version_id, VER);
    // Attempt checkpoint with wrong agentVersionId fails fence binding
    await assert.rejects(
      () =>
        service.checkpoint({
          agentSessionId: SESS,
          ...scope,
          executionFenceToken: 2,
          runId: RUN,
          traceId: 'a'.repeat(32),
          payload: p1,
          agentVersionId: '01K0G2PAV8FPMVC9QHJG7JPN99',
          configHash: '1'.repeat(64),
          workspaceId: WSP,
        }),
      /agentVersion|fence|mismatch/i,
    );
  });

  it('manifest attaches to leaf (not multi-root) across sequential checkpoints', async () => {
    const p1 = basePayload([entry('e1', 'one')]);
    await service.checkpoint({
      agentSessionId: SESS,
      ...scope,
      executionFenceToken: 2,
      runId: RUN,
      traceId: 'a'.repeat(32),
      payload: p1,
      agentVersionId: VER,
      configHash: 'a'.repeat(64),
      workspaceId: WSP,
    });
    const p2 = basePayload([entry('e1', 'one'), entry('e2', 'two', 'e1')]);
    await service.checkpoint({
      agentSessionId: SESS,
      ...scope,
      executionFenceToken: 2,
      runId: RUN,
      traceId: 'a'.repeat(32),
      payload: p2,
      agentVersionId: VER,
      configHash: 'a'.repeat(64),
      workspaceId: WSP,
    });
    const recovered = await service.recover({
      agentSessionId: SESS,
      ...scope,
      executionFenceToken: 2,
      workspaceId: WSP,
      agentVersionId: VER,
    });
    const manifests = recovered.payload.entries.filter(
      (e) => e.type === 'custom' && e.customType === 'platform.session.manifest',
    );
    assert.ok(manifests.length >= 1);
    for (const m of manifests) {
      assert.notEqual(m.parentId, null);
    }
    // Full payload still validates (single root only)
    assert.equal(recovered.payload.entries[0].parentId, null);
  });
});
