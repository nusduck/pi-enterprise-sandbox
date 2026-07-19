import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';
import { ToolExecutionRepository } from '../../src/infrastructure/mysql/repositories/tool-execution-repository.js';
import { NotFoundError } from '../../src/infrastructure/mysql/errors.js';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const OTHER_USER = '01K0G2PAV8FPMVC9QHJG7JPN99';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const TOOL = '01K0G2PAV8FPMVC9QHJG7JPN5K';

function toolRow() {
  return {
    tool_execution_id: TOOL,
    run_id: RUN,
    agent_session_id: SESSION,
    tool_call_id: 'call-1',
    tool_name: 'bash',
    tool_source: 'sandbox',
    risk_level: 'low',
    arguments_json: { command: 'pwd' },
    result_json: { stdout: '/home/sandbox/workspace' },
    status: 'SUCCEEDED',
    error_code: null,
    trace_id: 'a'.repeat(32),
    request_hash: 'b'.repeat(64),
    request_hash_version: 1,
    execution_fence_token: 3,
    started_at: '2026-07-18 10:00:00.000',
    completed_at: '2026-07-18 10:00:01.000',
    created_at: '2026-07-18 10:00:00.000',
  };
}

describe('ToolExecutionRepository listByRun', () => {
  it('returns public rows for an owned run and fails closed for another owner', async () => {
    const state = createFakeState();
    state.tables.runs = [{ run_id: RUN, org_id: ORG, user_id: USER }];
    state.tables.tool_executions = [toolRow()];
    const repository = new ToolExecutionRepository(createFakeKnex(state));

    const rows = await repository.listByRun(RUN, { orgId: ORG, userId: USER });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].toolCallId, 'call-1');
    assert.deepEqual(rows[0].argumentsJson, { command: 'pwd' });

    await assert.rejects(
      repository.listByRun(RUN, { orgId: ORG, userId: OTHER_USER }),
      NotFoundError,
    );
  });
});

describe('GET /internal/agent-runs/:id/tools', () => {
  let server;
  let port;

  before(async () => {
    server = createAgentHttpServer({
      createRunService: { execute: async () => ({}) },
      getRunService: { execute: async () => ({}) },
      cancelRunService: { execute: async () => ({}) },
      eventQueryService: { listEvents: async () => ({ events: [] }) },
      listToolExecutions: async ({ runId, auth }) => {
        assert.equal(runId, RUN);
        assert.equal(auth.externalUserId, 'user-ext-1');
        return [
          {
            toolExecutionId: TOOL,
            runId: RUN,
            agentSessionId: SESSION,
            toolCallId: 'call-1',
            toolName: 'bash',
            toolSource: 'sandbox',
            riskLevel: 'low',
            argumentsJson: { command: 'pwd' },
            resultJson: { stdout: '/home/sandbox/workspace' },
            status: 'SUCCEEDED',
            errorCode: null,
            startedAt: '2026-07-18T10:00:00.000Z',
            completedAt: '2026-07-18T10:00:01.000Z',
            createdAt: '2026-07-18T10:00:00.000Z',
            _argsIntegrity: 'must-not-leak',
            _policyFingerprint: 'must-not-leak',
          },
        ];
      },
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

  it('requires trusted acting subjects', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/internal/agent-runs/${RUN}/tools`,
    );
    assert.equal(response.status, 400);
  });

  it('presents a frontend-compatible snapshot without internal metadata', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/internal/agent-runs/${RUN}/tools`,
      {
        headers: {
          'X-Acting-User-Id': 'user-ext-1',
          'X-Acting-Organization-Id': 'org-ext-1',
        },
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.tools.length, 1);
    assert.deepEqual(body.tools[0].arguments, { command: 'pwd' });
    assert.equal(body.tools[0].status, 'succeeded');
    assert.equal(body.tools[0].finished_at, '2026-07-18T10:00:01.000Z');
    assert.equal(body.tools[0]._argsIntegrity, undefined);
    assert.equal(body.tools[0]._policyFingerprint, undefined);
    assert.equal(body.tools[0].request_hash, undefined);
  });
});
