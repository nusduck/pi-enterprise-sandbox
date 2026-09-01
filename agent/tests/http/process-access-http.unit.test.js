import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProcessExecutionRepository } from '../../src/infrastructure/mysql/repositories/process-execution-repository.js';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const OTHER_USER = '01K0G2PAV8FPMVC9QHJG7JPN59';
const PROCESS = '01K0G2PAV8FPMVC9QHJG7JPN5P';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const EXECUTION = '01K0G2PAV8FPMVC9QHJG7JPN5E';

function row() {
  return {
    process_id: PROCESS,
    org_id: ORG,
    user_id: USER,
    sandbox_session_id: SESSION,
    run_id: RUN,
    execution_id: EXECUTION,
    command_json: { command: 'sleep 10' },
    status: 'running',
    pid: 123,
    exit_code: null,
    stdout_path: null,
    stderr_path: null,
    started_at: '2026-07-18 10:00:00.000',
    ended_at: null,
    created_at: '2026-07-18 10:00:00.000',
  };
}

describe('ProcessExecutionRepository owner scope', () => {
  it('lists and reads only rows for the requested owner', async () => {
    const state = createFakeState();
    state.tables.process_executions = [row()];
    const repository = new ProcessExecutionRepository(createFakeKnex(state));

    const owned = await repository.getById(PROCESS, { orgId: ORG, userId: USER });
    assert.equal(owned.processId, PROCESS);
    assert.equal(owned.command, 'sleep 10');
    assert.equal(
      await repository.getById(PROCESS, { orgId: ORG, userId: OTHER_USER }),
      null,
    );
    assert.equal((await repository.list({ orgId: ORG, userId: USER })).length, 1);
    assert.equal(
      (await repository.list({ orgId: ORG, userId: OTHER_USER })).length,
      0,
    );
  });
});
