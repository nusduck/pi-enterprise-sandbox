import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';
import { OwnerScopedNotFoundError } from '../../src/application/errors.js';
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

describe('Agent process HTTP authority', () => {
  let server;
  let port;
  const calls = [];

  before(async () => {
    const processAccessService = {
      async list({ auth, limit }) {
        calls.push({ action: 'list', auth, limit });
        return auth.externalUserId === 'foreign' ? [] : [
          {
            processId: PROCESS,
            sandboxSessionId: SESSION,
            runId: RUN,
            executionId: EXECUTION,
            command: 'sleep 10',
            status: 'running',
            pid: 123,
            exitCode: null,
            startedAt: '2026-07-18T10:00:00.000Z',
            endedAt: null,
            createdAt: '2026-07-18T10:00:00.000Z',
          },
        ];
      },
      async get({ processId, auth }) {
        calls.push({ action: 'get', processId, auth });
        if (auth.externalUserId === 'foreign') {
          throw new OwnerScopedNotFoundError('Process not found', {
            resource: 'process_executions',
          });
        }
        return (await this.list({ auth, limit: 1 }))[0];
      },
      async logs(input) {
        calls.push({ action: 'logs', ...input });
        return { stdout: 'ok\n', stderr: '', next_offset: 3, completed: false, truncated: false };
      },
      async read(input) {
        calls.push({ action: 'read', ...input });
        return { process_id: PROCESS, stream: input.stream, cursor: input.cursor, next_cursor: '0-3', data: 'ok\n' };
      },
      async stdin(input) {
        calls.push({ action: 'stdin', ...input });
        return { ok: true };
      },
      async signal(input) {
        calls.push({ action: 'signal', ...input });
        return { ok: true, signaled: true, status: 'running' };
      },
      async cancel(input) {
        calls.push({ action: 'cancel', ...input });
        return { process_id: PROCESS, status: 'cancelled' };
      },
    };
    server = createAgentHttpServer({
      createRunService: { execute: async () => ({}) },
      getRunService: { execute: async () => ({}) },
      cancelRunService: { execute: async () => ({}) },
      eventQueryService: { listEvents: async () => ({ events: [] }) },
      processAccessService,
      config: {},
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function request(method, path, { user = 'owner', body } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Acting-User-Id': user,
        'X-Acting-Organization-Id': 'org-external',
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  it('returns durable history/status and hides a foreign process as 404', async () => {
    const history = await request('GET', '/internal/processes?limit=25');
    assert.equal(history.status, 200);
    assert.equal(history.body.processes[0].process_id, PROCESS);

    const status = await request('GET', `/internal/processes/${PROCESS}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.status, 'running');

    const foreign = await request('GET', `/internal/processes/${PROCESS}`, {
      user: 'foreign',
    });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error, 'Process not found');
  });

  it('forwards cursor reads and control only with trusted acting subjects', async () => {
    const read = await request(
      'GET',
      `/internal/processes/${PROCESS}/read?stream=stderr&cursor=0-7&limit=64`,
    );
    assert.equal(read.status, 200);
    const readCall = calls.findLast((call) => call.action === 'read');
    assert.equal(readCall.stream, 'stderr');
    assert.equal(readCall.cursor, '0-7');
    assert.equal(readCall.limit, '64');

    const signal = await request('POST', `/internal/processes/${PROCESS}/signal`, {
      body: { signal: 'SIGKILL' },
    });
    assert.equal(signal.status, 200);
    assert.equal(calls.findLast((call) => call.action === 'signal').signal, 'SIGKILL');

    const unauthenticated = await fetch(
      `http://127.0.0.1:${port}/internal/processes/${PROCESS}`,
    );
    assert.equal(unauthenticated.status, 400);
  });
});
