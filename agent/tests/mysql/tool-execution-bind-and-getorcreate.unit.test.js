/**
 * PR-07B batch 2A2: ToolExecutionRepository getOrCreate ownership +
 * bindSandboxRequest CAS/lock-order branches (fake knex, offline).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from './fake-knex.js';
import { ToolExecutionRepository } from '../../src/infrastructure/mysql/repositories/tool-execution-repository.js';
import { ConflictError, NotFoundError } from '../../src/infrastructure/mysql/errors.js';
import { TOOL_EXECUTION_STATUS } from '../../src/domain/tool/tool-execution-status.js';
import { createHash } from 'node:crypto';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const OTHER_USER = '01K0G2PAV8FPMVC9QHJG7JPN99';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const CONV2 = '01K0G2PAV8FPMVC9QHJG7JPN5A';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const SESS2 = '01K0G2PAV8FPMVC9QHJG7JPN5B';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const RUN2 = '01K0G2PAV8FPMVC9QHJG7JPN5J';
const TE = '01K0G2PAV8FPMVC9QHJG7JPN5K';
const TE2 = '01K0G2PAV8FPMVC9QHJG7JPN5M';
const TRACE = 'b'.repeat(32);
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const SBX = '01K0G2PAV8FPMVC9QHJG7JPN5F';
const FENCE = 3;
const HASH =
  '67299dd95ff1e9e856fb845da8ef636af2e7726214ccd61de3f6992ba25064c2';
const HASH2 = createHash('sha256').update('other').digest('hex');

function seed(state, overrides = {}) {
  const run = {
    run_id: RUN,
    org_id: ORG,
    user_id: USER,
    conversation_id: CONV,
    agent_session_id: SESS,
    agent_version_id: VER,
    status: 'RUNNING',
    created_at: '2026-07-18 00:00:00.000',
    updated_at: '2026-07-18 00:00:00.000',
    ...(overrides.run || {}),
  };
  const session = {
    agent_session_id: SESS,
    org_id: ORG,
    user_id: USER,
    conversation_id: CONV,
    sandbox_session_id: SBX,
    agent_version_id: VER,
    status: 'ACTIVE',
    execution_fence_token: FENCE,
    created_at: '2026-07-18 00:00:00.000',
    updated_at: '2026-07-18 00:00:00.000',
    ...(overrides.session || {}),
  };
  const tool = {
    tool_execution_id: TE,
    run_id: RUN,
    agent_session_id: SESS,
    tool_call_id: 'tc-bind',
    tool_name: 'bash',
    tool_source: 'sandbox',
    risk_level: 'low',
    arguments_json: JSON.stringify({
      $v: 1,
      $integrity: createHash('sha256').update('{}').digest('hex'),
      $payload: {},
    }),
    result_json: null,
    status: TOOL_EXECUTION_STATUS.RUNNING,
    error_code: null,
    trace_id: TRACE,
    request_hash: null,
    request_hash_version: null,
    execution_fence_token: null,
    started_at: '2026-07-18 00:00:00.000',
    completed_at: null,
    created_at: '2026-07-18 00:00:00.000',
    ...(overrides.tool || {}),
  };
  state.tables.runs = [run];
  state.tables.agent_sessions = [session];
  state.tables.tool_executions = overrides.noTool ? [] : [tool];
}

function baseBind(extra = {}) {
  return {
    agentSessionId: SESS,
    conversationId: CONV,
    sandboxSessionId: SBX,
    toolName: 'bash',
    requestHash: HASH,
    requestHashVersion: 1,
    executionFenceToken: FENCE,
    orgId: ORG,
    userId: USER,
    ...extra,
  };
}

describe('ToolExecutionRepository.getOrCreate run ownership', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  /** @type {ToolExecutionRepository} */
  let repo;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    repo = new ToolExecutionRepository(knex);
    seed(state, { noTool: true });
  });

  const createInput = (extra = {}) => ({
    toolExecutionId: TE,
    runId: RUN,
    agentSessionId: SESS,
    toolCallId: 'tc-new',
    toolName: 'bash',
    toolSource: 'sandbox',
    riskLevel: 'low',
    argumentsJson: { command: 'echo 1' },
    traceId: TRACE,
    orgId: ORG,
    userId: USER,
    ...extra,
  });

  it('conflicts when run.agent_session_id mismatches before insert', async () => {
    state.tables.runs[0].agent_session_id = SESS2;
    await assert.rejects(
      () => repo.getOrCreate(createInput()),
      (err) =>
        err instanceof ConflictError &&
        /agent_session_id does not match/i.test(err.message),
    );
    assert.equal(state.tables.tool_executions.length, 0);
  });

  it('conflicts when optional conversationId mismatches before insert', async () => {
    await assert.rejects(
      () => repo.getOrCreate(createInput({ conversationId: CONV2 })),
      (err) =>
        err instanceof ConflictError &&
        /conversation_id does not match/i.test(err.message),
    );
    assert.equal(state.tables.tool_executions.length, 0);
  });

  it('succeeds when conversationId matches owned run', async () => {
    const r = await repo.getOrCreate(createInput({ conversationId: CONV }));
    assert.equal(r.created, true);
    assert.equal(r.toolExecution.agentSessionId, SESS);
    assert.equal(r.toolExecution.requestHash, null);
    assert.equal(r.toolExecution.requestHashVersion, null);
    assert.equal(r.toolExecution.executionFenceToken, null);
  });

  it('replay still requires matching agent_session_id', async () => {
    await repo.getOrCreate(createInput());
    state.tables.runs[0].agent_session_id = SESS2;
    await assert.rejects(
      () =>
        repo.getOrCreate(
          createInput({
            toolExecutionId: TE2,
            toolCallId: 'tc-new',
          }),
        ),
      ConflictError,
    );
  });
});

describe('ToolExecutionRepository.bindSandboxRequest', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  /** @type {ToolExecutionRepository} */
  let repo;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    repo = new ToolExecutionRepository(knex);
    seed(state);
  });

  it('binds null→set atomically via toolExecutionId path', async () => {
    const r = await repo.bindSandboxRequest(
      baseBind({ toolExecutionId: TE }),
    );
    assert.equal(r.bound, true);
    assert.equal(r.toolExecution.requestHash, HASH);
    assert.equal(r.toolExecution.requestHashVersion, 1);
    assert.equal(r.toolExecution.executionFenceToken, FENCE);
    assert.equal(state.tables.tool_executions[0].request_hash, HASH);
  });

  it('binds via runId+toolCallId', async () => {
    const r = await repo.bindSandboxRequest(
      baseBind({ runId: RUN, toolCallId: 'tc-bind' }),
    );
    assert.equal(r.bound, true);
    assert.equal(r.toolExecution.toolExecutionId, TE);
  });

  it('idempotent all-same replay returns bound:false', async () => {
    await repo.bindSandboxRequest(baseBind({ toolExecutionId: TE }));
    const r = await repo.bindSandboxRequest(baseBind({ toolExecutionId: TE }));
    assert.equal(r.bound, false);
    assert.equal(r.toolExecution.requestHash, HASH);
  });

  it('rejects partial/different binding', async () => {
    state.tables.tool_executions[0].request_hash = HASH;
    state.tables.tool_executions[0].request_hash_version = null;
    state.tables.tool_executions[0].execution_fence_token = null;
    await assert.rejects(
      () => repo.bindSandboxRequest(baseBind({ toolExecutionId: TE })),
      /binding conflict|partial/i,
    );

    state.tables.tool_executions[0].request_hash = HASH;
    state.tables.tool_executions[0].request_hash_version = 1;
    state.tables.tool_executions[0].execution_fence_token = FENCE;
    await assert.rejects(
      () =>
        repo.bindSandboxRequest(
          baseBind({ toolExecutionId: TE, requestHash: HASH2 }),
        ),
      /binding conflict|partial/i,
    );
  });

  it('rejects stale fence / non-ACTIVE session', async () => {
    await assert.rejects(
      () =>
        repo.bindSandboxRequest(
          baseBind({ toolExecutionId: TE, executionFenceToken: 99 }),
        ),
      /stale execution fence/i,
    );
    state.tables.agent_sessions[0].status = 'SUSPENDED';
    await assert.rejects(
      () => repo.bindSandboxRequest(baseBind({ toolExecutionId: TE })),
      /ACTIVE session/i,
    );
  });

  it('rejects non-RUNNING run / conversation mismatch / session mismatch', async () => {
    state.tables.runs[0].status = 'SUCCEEDED';
    await assert.rejects(
      () => repo.bindSandboxRequest(baseBind({ toolExecutionId: TE })),
      /Run must be RUNNING/i,
    );
    state.tables.runs[0].status = 'RUNNING';

    state.tables.runs[0].conversation_id = CONV2;
    await assert.rejects(
      () => repo.bindSandboxRequest(baseBind({ toolExecutionId: TE })),
      /conversation_id does not match/i,
    );
    state.tables.runs[0].conversation_id = CONV;

    state.tables.runs[0].agent_session_id = SESS2;
    await assert.rejects(
      () => repo.bindSandboxRequest(baseBind({ toolExecutionId: TE })),
      /not bound to agentSessionId/i,
    );
  });

  it('rejects conversationId / sandboxSessionId / toolName context mismatches', async () => {
    await assert.rejects(
      () =>
        repo.bindSandboxRequest(
          baseBind({ toolExecutionId: TE, conversationId: CONV2 }),
        ),
      /conversation_id does not match context/i,
    );
    await assert.rejects(
      () =>
        repo.bindSandboxRequest(
          baseBind({
            toolExecutionId: TE,
            sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN9Z',
          }),
        ),
      /sandbox_session_id does not match context/i,
    );
    await assert.rejects(
      () =>
        repo.bindSandboxRequest(
          baseBind({ toolExecutionId: TE, toolName: 'python' }),
        ),
      /tool_name mismatch/i,
    );
  });

  it('parent locks are FOR SHARE; tool lock is direct FOR UPDATE without join', async () => {
    state.lockCalls = [];
    await repo.bindSandboxRequest(
      baseBind({ runId: RUN, toolCallId: 'tc-bind' }),
    );
    const locks = state.lockCalls;
    assert.ok(locks.length >= 3, JSON.stringify(locks));
    // First agent_sessions share, then runs share, then tool_executions update
    const sessionLock = locks.find((l) => l.table === 'agent_sessions');
    const runLock = locks.find((l) => l.table === 'runs');
    const toolLock = locks.find((l) => l.table === 'tool_executions');
    assert.ok(sessionLock, 'session lock recorded');
    assert.ok(runLock, 'run lock recorded');
    assert.ok(toolLock, 'tool lock recorded');
    assert.equal(sessionLock.mode, 'share');
    assert.equal(runLock.mode, 'share');
    assert.equal(toolLock.mode, 'update');
    assert.equal(toolLock.joined, false);
    // No exclusive lock on parent rows
    assert.equal(
      locks.some((l) => l.table === 'agent_sessions' && l.mode === 'update'),
      false,
    );
    assert.equal(
      locks.some((l) => l.table === 'runs' && l.mode === 'update'),
      false,
    );
  });

  it('assertPositiveSafeInt rejects strings/bools/floats/unsafe', async () => {
    const { assertPositiveSafeInt } = await import(
      '../../src/infrastructure/mysql/repositories/tool-execution-repository.js'
    );
    for (const bad of [
      '7',
      '1',
      true,
      false,
      1.5,
      NaN,
      Infinity,
      -1,
      0,
      null,
      undefined,
      2 ** 53,
    ]) {
      assert.throws(
        () => assertPositiveSafeInt(bad, 'field'),
        /positive safe integer/,
        `bad=${String(bad)}`,
      );
    }
    assert.equal(assertPositiveSafeInt(1, 'field'), 1);
    assert.equal(assertPositiveSafeInt(7, 'field'), 7);
  });

  it('rejects wrong tool source/status/session/run', async () => {
    state.tables.tool_executions[0].tool_source = 'mcp';
    await assert.rejects(
      () => repo.bindSandboxRequest(baseBind({ toolExecutionId: TE })),
      /tool_source=sandbox/i,
    );
    state.tables.tool_executions[0].tool_source = 'sandbox';

    state.tables.tool_executions[0].status = TOOL_EXECUTION_STATUS.SUCCEEDED;
    await assert.rejects(
      () => repo.bindSandboxRequest(baseBind({ toolExecutionId: TE })),
      /only RUNNING may bind/i,
    );
    state.tables.tool_executions[0].status = TOOL_EXECUTION_STATUS.UNKNOWN;
    await assert.rejects(
      () => repo.bindSandboxRequest(baseBind({ toolExecutionId: TE })),
      /only RUNNING may bind/i,
    );
    state.tables.tool_executions[0].status = TOOL_EXECUTION_STATUS.RUNNING;

    state.tables.tool_executions[0].agent_session_id = SESS2;
    await assert.rejects(
      () => repo.bindSandboxRequest(baseBind({ toolExecutionId: TE })),
      /agentSessionId mismatch/i,
    );
    state.tables.tool_executions[0].agent_session_id = SESS;

    state.tables.tool_executions[0].run_id = RUN2;
    // run lookup uses peek run_id; seed second run so requireOwnedRun fails or mismatch
    state.tables.runs.push({
      run_id: RUN2,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONV,
      agent_session_id: SESS,
      agent_version_id: VER,
      status: 'RUNNING',
      created_at: '2026-07-18 00:00:00.000',
      updated_at: '2026-07-18 00:00:00.000',
    });
    // tool row under RUN2 but bind with runId+toolCallId for RUN conflicts
    state.tables.tool_executions[0].run_id = RUN;
    await assert.rejects(
      () =>
        repo.bindSandboxRequest(
          baseBind({
            toolExecutionId: TE,
            runId: RUN2,
            toolCallId: 'tc-bind',
          }),
        ),
      /run_id does not match validated run|does not match runId\+toolCallId|tool row runId mismatch/i,
    );
  });

  it('rejects invalid hash / non-positive version or fence', async () => {
    await assert.rejects(
      () =>
        repo.bindSandboxRequest(
          baseBind({ toolExecutionId: TE, requestHash: 'ABC'.repeat(21) + 'A' }),
        ),
      /64 lowercase hex/i,
    );
    await assert.rejects(
      () =>
        repo.bindSandboxRequest(
          baseBind({ toolExecutionId: TE, requestHashVersion: 0 }),
        ),
      /positive safe integer/i,
    );
    await assert.rejects(
      () =>
        repo.bindSandboxRequest(
          baseBind({ toolExecutionId: TE, executionFenceToken: -1 }),
        ),
      /positive safe integer/i,
    );
    await assert.rejects(
      () =>
        repo.bindSandboxRequest(
          baseBind({
            toolExecutionId: TE,
            requestHashVersion: null,
          }),
        ),
      /positive safe integer/i,
    );
  });

  it('rejects cross-owner and missing tool', async () => {
    await assert.rejects(
      () =>
        repo.bindSandboxRequest(
          baseBind({ toolExecutionId: TE, userId: OTHER_USER }),
        ),
      NotFoundError,
    );
    await assert.rejects(
      () =>
        repo.bindSandboxRequest(
          baseBind({ toolExecutionId: '01K0G2PAV8FPMVC9QHJG7JPN5Z' }),
        ),
      NotFoundError,
    );
  });

  it('CAS race: concurrent update of null fields loses with ConflictError', async () => {
    // After lock read sees all-null, force the whereNull CAS update to match
    // 0 rows (another writer won), yielding ConflictError without blind update.
    class RaceRepo extends ToolExecutionRepository {
      async bindSandboxRequest(input) {
        const self = this;
        const orig = self.db;
        let phase = 0;
        self.db = (table) => {
          const q = orig(table);
          if (
            (table === 'tool_executions' ||
              String(table).startsWith('tool_executions')) &&
            typeof q.update === 'function'
          ) {
            const u = q.update.bind(q);
            q.update = (patch) => {
              if (phase === 0 && patch && patch.request_hash) {
                phase = 1;
                return Promise.resolve(0);
              }
              return u(patch);
            };
          }
          return q;
        };
        try {
          return await super.bindSandboxRequest(input);
        } finally {
          self.db = orig;
        }
      }
    }
    const raceRepo = new RaceRepo(knex);
    await assert.rejects(
      () => raceRepo.bindSandboxRequest(baseBind({ toolExecutionId: TE })),
      /CAS lost race|binding conflict/i,
    );
    // Original row remains unbound (no blind update applied).
    assert.equal(state.tables.tool_executions[0].request_hash, null);
  });

  it('requires toolExecutionId or runId+toolCallId', async () => {
    await assert.rejects(
      () => repo.bindSandboxRequest(baseBind()),
      /toolExecutionId or exact runId\+toolCallId/,
    );
  });
});

describe('ToolExecutionRepository.transitionStatus UNKNOWN', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ToolExecutionRepository} */
  let repo;

  beforeEach(() => {
    state = createFakeState();
    const knex = createFakeKnex(state);
    repo = new ToolExecutionRepository(knex);
    seed(state);
  });

  it('RUNNING → UNKNOWN succeeds; UNKNOWN is terminal', async () => {
    const tr = await repo.transitionStatus({
      toolExecutionId: TE,
      orgId: ORG,
      userId: USER,
      fromStatus: TOOL_EXECUTION_STATUS.RUNNING,
      toStatus: TOOL_EXECUTION_STATUS.UNKNOWN,
      resultJson: { unknown: true },
      setCompletedAt: true,
    });
    assert.equal(tr.changed, true);
    assert.equal(tr.toolExecution.status, TOOL_EXECUTION_STATUS.UNKNOWN);
    assert.ok(tr.toolExecution.completedAt);

    // same UNKNOWN + same result idempotent
    const again = await repo.transitionStatus({
      toolExecutionId: TE,
      orgId: ORG,
      userId: USER,
      fromStatus: TOOL_EXECUTION_STATUS.UNKNOWN,
      toStatus: TOOL_EXECUTION_STATUS.UNKNOWN,
      resultJson: { unknown: true },
    });
    assert.equal(again.changed, false);

    // no outgoing
    await assert.rejects(
      () =>
        repo.transitionStatus({
          toolExecutionId: TE,
          orgId: ORG,
          userId: USER,
          fromStatus: TOOL_EXECUTION_STATUS.UNKNOWN,
          toStatus: TOOL_EXECUTION_STATUS.FAILED,
        }),
      /illegal tool execution transition|CAS failed/i,
    );
  });

  it('PROPOSED cannot go directly to UNKNOWN', async () => {
    state.tables.tool_executions[0].status = TOOL_EXECUTION_STATUS.PROPOSED;
    await assert.rejects(
      () =>
        repo.transitionStatus({
          toolExecutionId: TE,
          orgId: ORG,
          userId: USER,
          fromStatus: TOOL_EXECUTION_STATUS.PROPOSED,
          toStatus: TOOL_EXECUTION_STATUS.UNKNOWN,
        }),
      /illegal tool execution transition/i,
    );
  });
});
