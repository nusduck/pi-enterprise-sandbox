/**
 * Pi session journal repository (PR-05 slice B) — fake knex offline.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import {
  PiSessionJournalRepository,
  hashJournalPayload,
  JOURNAL_HEADER_ENTRY_ID,
  JOURNAL_MESSAGE_TYPE,
} from '../../src/infrastructure/mysql/repositories/pi-session-journal-repository.js';
import { SessionJournalError } from '../../src/domain/session/errors.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const MSG1 = '01K0G2PAV8FPMVC9QHJG7JPN5A';
const MSG2 = '01K0G2PAV8FPMVC9QHJG7JPN5B';
const MSG3 = '01K0G2PAV8FPMVC9QHJG7JPN5C';

function seed(state) {
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
      agent_version_id: '01K0G2PAV8FPMVC9QHJG7JPN5E',
      sandbox_session_id: '01K0G2PAV8FPMVC9QHJG7JPN5F',
      workspace_id: '01K0G2PAV8FPMVC9QHJG7JPN5G',
      status: 'ACTIVE',
      pi_session_version: 0,
      last_run_id: null,
      execution_fence_token: 1,
      recovery_reason_code: null,
      created_at: '2026-07-18 00:00:00.000',
      updated_at: '2026-07-18 00:00:00.000',
      closed_at: null,
    },
  ];
  state.tables.messages = [];
}

const header = {
  type: 'session',
  version: 3,
  id: 'pi-sess-1',
  timestamp: '2026-07-18T00:00:00.000Z',
  cwd: '/tmp/ws',
};

function msgEntry(id, text, parentId = null) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-07-18T00:00:01.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text },
        {
          type: 'toolCall',
          id: `tc-${id}`,
          name: 'bash',
          arguments: { command: 'echo hi' },
        },
      ],
    },
  };
}

function toolResultEntry(id, parentId) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-07-18T00:00:02.000Z',
    message: {
      role: 'toolResult',
      toolCallId: `tc-${parentId}`,
      toolName: 'bash',
      content: [{ type: 'text', text: 'hi' }],
      isError: false,
    },
  };
}

function compactionEntry(id, parentId, firstKept) {
  return {
    type: 'compaction',
    id,
    parentId,
    timestamp: '2026-07-18T00:00:03.000Z',
    summary: 'compacted history',
    firstKeptEntryId: firstKept,
    tokensBefore: 1000,
  };
}

function branchEntry(id, parentId, fromId) {
  return {
    type: 'branch_summary',
    id,
    parentId,
    timestamp: '2026-07-18T00:00:04.000Z',
    fromId,
    summary: 'branched',
  };
}

describe('PiSessionJournalRepository', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  const scope = { orgId: ORG, userId: USER };
  const nextId = createUlidGenerator({ now: () => 1_721_278_800_000 });

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seed(state);
  });

  it('appends header + full toolCall/toolResult/compaction/branch entries', async () => {
    const repo = new PiSessionJournalRepository(knex, {
      generateId: nextId,
    });
    const e1 = msgEntry('e1', 'hello');
    const e2 = toolResultEntry('e2', 'e1');
    const e3 = compactionEntry('e3', 'e2', 'e2');
    const e4 = branchEntry('e4', 'e3', 'e1');

    await repo.appendHeader({
      messageId: MSG1,
      agentSessionId: SESS,
      ...scope,
      header,
    });
    for (const [mid, entry] of [
      [MSG2, e1],
      [MSG3, e2],
      [nextId(), e3],
      [nextId(), e4],
    ]) {
      await repo.appendEntry({
        messageId: mid,
        agentSessionId: SESS,
        ...scope,
        entry,
      });
    }

    const loaded = await repo.loadPayload(SESS, scope);
    assert.equal(loaded.header.id, 'pi-sess-1');
    assert.equal(loaded.entries.length, 4);
    assert.equal(loaded.entries[0].message.content[1].type, 'toolCall');
    assert.equal(loaded.entries[1].message.role, 'toolResult');
    assert.equal(loaded.entries[2].type, 'compaction');
    assert.equal(loaded.entries[3].type, 'branch_summary');
    assert.ok(loaded.digest);
  });

  it('duplicate pi_entry_id is idempotent; hash conflict throws', async () => {
    const repo = new PiSessionJournalRepository(knex);
    const entry = msgEntry('dup-1', 'v1');
    await repo.appendEntry({
      messageId: MSG1,
      agentSessionId: SESS,
      ...scope,
      entry,
    });
    const again = await repo.appendEntry({
      messageId: MSG2,
      agentSessionId: SESS,
      ...scope,
      entry,
    });
    assert.equal(again.idempotent, true);
    assert.equal(state.tables.messages.filter((m) => m.pi_entry_id === 'dup-1').length, 1);

    await assert.rejects(
      () =>
        repo.appendEntry({
          messageId: MSG3,
          agentSessionId: SESS,
          ...scope,
          entry: msgEntry('dup-1', 'v2-different'),
        }),
      (err) => err instanceof SessionJournalError && err.code === 'JOURNAL_HASH_CONFLICT',
    );
  });

  it('paginates beyond 200 without truncating full rebuild', async () => {
    const repo = new PiSessionJournalRepository(knex);
    await repo.appendHeader({
      messageId: nextId(),
      agentSessionId: SESS,
      ...scope,
      header,
    });
    let parent = null;
    for (let i = 0; i < 250; i += 1) {
      const id = `ent-${i}`;
      const entry = msgEntry(id, `t${i}`, parent);
      // parent chain: first has null, rest point previous
      if (i > 0) entry.parentId = `ent-${i - 1}`;
      await repo.appendEntry({
        messageId: nextId(),
        agentSessionId: SESS,
        ...scope,
        entry,
      });
      parent = id;
    }
    const all = await repo.listAllBySession(SESS, scope, { pageSize: 50 });
    // header + 250 entries
    assert.equal(all.length, 251);
    const payload = await repo.loadPayload(SESS, scope);
    assert.equal(payload.entries.length, 250);
  });

  it('owner-scopes journal reads', async () => {
    const repo = new PiSessionJournalRepository(knex);
    await repo.appendHeader({
      messageId: MSG1,
      agentSessionId: SESS,
      ...scope,
      header,
    });
    await assert.rejects(
      () =>
        repo.listBySession(SESS, {
          orgId: ORG,
          userId: '01K0G2PAV8FPMVC9QHJG7JPN99',
        }),
      /not found/i,
    );
  });

  it('stores payloadHash deterministically', () => {
    const a = hashJournalPayload(header);
    const b = hashJournalPayload({ ...header });
    assert.equal(a, b);
    assert.equal(a.length, 64);
  });

  it('header uses stable JOURNAL_HEADER_ENTRY_ID', async () => {
    const repo = new PiSessionJournalRepository(knex);
    await repo.appendHeader({
      messageId: MSG1,
      agentSessionId: SESS,
      ...scope,
      header,
    });
    const row = await repo.getByEntryId(SESS, JOURNAL_HEADER_ENTRY_ID, scope);
    assert.equal(row.messageType, JOURNAL_MESSAGE_TYPE.HEADER);
    assert.equal(row.piEntryKind, 'session');
  });

  it('never trusts stored payloadHash — mismatch fails closed', async () => {
    const repo = new PiSessionJournalRepository(knex);
    const entry = msgEntry('hash-1', 'v1');
    await repo.appendEntry({
      messageId: MSG1,
      agentSessionId: SESS,
      ...scope,
      entry,
    });
    // Corrupt stored payloadHash while leaving entry body intact
    const row = state.tables.messages.find((m) => m.pi_entry_id === 'hash-1');
    const content =
      typeof row.content_json === 'string'
        ? JSON.parse(row.content_json)
        : row.content_json;
    content.payloadHash = '0'.repeat(64);
    row.content_json = JSON.stringify(content);

    await assert.rejects(
      () => repo.loadPayload(SESS, scope),
      (err) =>
        err instanceof SessionJournalError && err.code === 'JOURNAL_HASH_MISMATCH',
    );
  });
});
