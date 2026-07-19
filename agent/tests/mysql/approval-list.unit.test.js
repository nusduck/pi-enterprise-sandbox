import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ApprovalRepository } from '../../src/infrastructure/mysql/repositories/approval-repository.js';
import { createFakeKnex, createFakeState } from './fake-knex.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const FOREIGN = '01K0G2PAV8FPMVC9QHJG7JPN5F';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const FOREIGN_RUN = '01K0G2PAV8FPMVC9QHJG7JPN5G';
const PENDING = '01K0G2PAV8FPMVC9QHJG7JPN55';
const APPROVED = '01K0G2PAV8FPMVC9QHJG7JPN57';

function approval(approvalId, runId, status, createdAt) {
  return {
    approval_id: approvalId,
    org_id: ORG,
    run_id: runId,
    tool_execution_id: '01K0G2PAV8FPMVC9QHJG7JPN56',
    requested_by: USER,
    decision_by: null,
    status,
    request_json: JSON.stringify({ toolName: 'bash', argsSummary: { command: 'pwd' } }),
    decision_reason: null,
    expires_at: null,
    created_at: createdAt,
    decided_at: null,
  };
}

describe('ApprovalRepository owner list', () => {
  it('filters status, orders newest first, and excludes a foreign user in the same org', async () => {
    const state = createFakeState();
    state.tables.runs = [
      { run_id: RUN, org_id: ORG, user_id: USER, conversation_id: '01K0G2PAV8FPMVC9QHJG7JPN51' },
      { run_id: FOREIGN_RUN, org_id: ORG, user_id: FOREIGN, conversation_id: '01K0G2PAV8FPMVC9QHJG7JPN5E' },
    ];
    state.tables.approvals = [
      approval(PENDING, RUN, 'PENDING', '2026-07-18 06:00:00.000'),
      approval(APPROVED, RUN, 'APPROVED', '2026-07-18 07:00:00.000'),
      approval('01K0G2PAV8FPMVC9QHJG7JPN58', FOREIGN_RUN, 'PENDING', '2026-07-18 08:00:00.000'),
    ];
    const repo = new ApprovalRepository(createFakeKnex(state));

    const all = await repo.listForOwner({ orgId: ORG, userId: USER });
    assert.deepEqual(all.map((row) => row.approvalId), [APPROVED, PENDING]);

    const pending = await repo.listForOwner(
      { orgId: ORG, userId: USER },
      { status: 'pending', limit: 1 },
    );
    assert.deepEqual(pending.map((row) => row.approvalId), [PENDING]);
  });

  it('rejects invalid status and unbounded limits', async () => {
    const state = createFakeState();
    state.tables.runs = [];
    state.tables.approvals = [];
    const repo = new ApprovalRepository(createFakeKnex(state));
    await assert.rejects(
      repo.listForOwner({ orgId: ORG, userId: USER }, { status: 'unknown' }),
      /Invalid approval status/,
    );
    await assert.rejects(
      repo.listForOwner({ orgId: ORG, userId: USER }, { limit: 201 }),
      /limit must be an integer/,
    );
  });
});
