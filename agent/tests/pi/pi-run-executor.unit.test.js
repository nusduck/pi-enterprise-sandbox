/**
 * PiRunExecutor offline tests with fakes (PR-05 slice B).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createFakeRedis } from '../redis/fake-redis.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import {
  PiRunExecutor,
  createPiRunExecutorFactory,
  generateRunLeaseOwnerToken,
  derivePromptFromTriggeringMessage,
} from '../../src/application/pi-run-executor.js';
import { SessionLockManager } from '../../src/infrastructure/redis/session-lock-manager.js';
import { LeaseManager } from '../../src/infrastructure/redis/lease-manager.js';
import { ExecuteRunService } from '../../src/application/execute-run-service.js';
import { createStubRunExecutor } from '../../src/application/run-executor.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';
import { PINNED_PI_SDK_VERSION } from '../../src/infrastructure/pi/pi-runtime-factory.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const WSP = '01K0G2PAV8FPMVC9QHJG7JPN5G';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const SBX = '01K0G2PAV8FPMVC9QHJG7JPN5F';
const TRIG = '01K0G2PAV8FPMVC9QHJG7JPN5J';
const DEF = '01K0G2PAV8FPMVC9QHJG7JPN5D';

const fullModel = {
  id: 'test-model',
  name: 'Test',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

function seedExecutorWorld(state) {
  state.tables.conversations = [
    {
      conversation_id: CONV,
      org_id: ORG,
      user_id: USER,
      agent_id: DEF,
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
      execution_fence_token: 0,
      recovery_reason_code: null,
      created_at: '2026-07-18 00:00:00.000',
      updated_at: '2026-07-18 00:00:00.000',
      closed_at: null,
    },
  ];
  state.tables.agent_session_snapshots = [];
  state.tables.agent_definitions = [
    {
      agent_id: DEF,
      org_id: ORG,
      name: 'default',
      description: null,
      status: 'active',
      active_version_id: VER,
      created_by: USER,
      created_at: '2026-07-18 00:00:00.000',
      updated_at: '2026-07-18 00:00:00.000',
    },
  ];
  state.tables.agent_versions = [
    {
      agent_version_id: VER,
      agent_id: DEF,
      version_no: 1,
      config_json: JSON.stringify({ systemPrompt: 'hi' }),
      config_hash: 'a'.repeat(64),
      pi_sdk_version: PINNED_PI_SDK_VERSION,
      status: 'active',
      created_by: USER,
      created_at: '2026-07-18 00:00:00.000',
    },
  ];
  state.tables.messages = [
    {
      message_id: TRIG,
      conversation_id: CONV,
      agent_session_id: SESS,
      run_id: RUN,
      role: 'user',
      message_type: 'text',
      content_json: JSON.stringify({
        messages: [{ role: 'user', content: 'hello world' }],
      }),
      sequence_no: 1,
      pi_entry_id: null,
      pi_entry_kind: null,
      created_at: '2026-07-18 00:00:00.000',
    },
  ];
  state.tables.runs = [
    {
      run_id: RUN,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONV,
      agent_session_id: SESS,
      agent_version_id: VER,
      triggering_message_id: TRIG,
      source: 'api',
      status: 'RUNNING',
      status_reason: null,
      queue_name: 'runs',
      attempt: 1,
      trace_id: 'b'.repeat(32),
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

/**
 * Minimal fake Pi runtime factory for offline tests.
 * @param {{
 *   onPrompt?: Function,
 *   entries?: object[],
 *   failPrompt?: Error,
 *   lockLossOnEvent?: boolean,
 *   messageEnds?: object[],
 * }} [opts]
 */
function createFakePiRuntimeFactory(opts = {}) {
  const entries = opts.entries ?? [
    {
      type: 'message',
      id: 'r1',
      parentId: null,
      timestamp: '2026-07-18T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      },
    },
  ];
  const messageEnds = opts.messageEnds ?? [
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
      },
    },
  ];
  return {
    async create(input) {
      assert.ok(input.model);
      assert.ok(input.cwd);
      /** @type {Array<(ev: object) => void>} */
      const subs = [];
      let aborted = false;
      const sessionManager = {
        getHeader: () => ({
          type: 'session',
          version: 3,
          id: input.agentSession.agentSessionId,
          timestamp: '2026-07-18T00:00:00.000Z',
          cwd: input.cwd,
        }),
        getEntries: () =>
          opts.captureFromSnapshot && input.piSnapshot?.snapshotJson?.entries
            ? [...input.piSnapshot.snapshotJson.entries, ...entries]
            : [...entries],
        getCwd: () => input.cwd,
        getSessionId: () => input.agentSession.agentSessionId,
      };
      const session = {
        subscribe(fn) {
          subs.push(fn);
          return () => {
            const i = subs.indexOf(fn);
            if (i >= 0) subs.splice(i, 1);
          };
        },
        abort() {
          aborted = true;
        },
        async prompt(p) {
          if (opts.failPrompt) throw opts.failPrompt;
          if (typeof opts.onPrompt === 'function') await opts.onPrompt(p, { aborted });
          for (const ev of messageEnds) {
            for (const fn of subs) fn(ev);
          }
        },
      };
      return {
        session,
        sessionManager,
        dispose: async () => {},
        _aborted: () => aborted,
      };
    },
  };
}

describe('derivePromptFromTriggeringMessage', () => {
  it('uses durable user content only (not full history dump)', () => {
    const prompt = derivePromptFromTriggeringMessage({
      contentJson: {
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'second' },
        ],
      },
    });
    assert.equal(prompt, 'second');
  });

  it('supports image parts', () => {
    const prompt = derivePromptFromTriggeringMessage({
      contentJson: {
        parts: [
          { type: 'text', text: 'see' },
          { type: 'image', data: 'base64…' },
        ],
      },
    });
    assert.equal(prompt.length, 2);
    assert.equal(prompt[1].type, 'image');
  });
});

describe('generateRunLeaseOwnerToken', () => {
  it('unique per attempt for same workerId', () => {
    const a = generateRunLeaseOwnerToken('worker-1');
    const b = generateRunLeaseOwnerToken('worker-1');
    assert.notEqual(a, b);
    assert.match(a, /^worker-1:[0-9a-f]+$/);
  });
});

describe('PiRunExecutor', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  /** @type {ReturnType<typeof createFakeRedis>} */
  let redis;
  const nextId = createUlidGenerator({ now: () => 1_721_278_800_000 });
  const scope = { orgId: ORG, userId: USER };

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    redis = createFakeRedis();
    seedExecutorWorld(state);
  });

  function makeExecutor(factoryOpts = {}) {
    const generateId = nextId;
    return new PiRunExecutor({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, { now: () => new Date(), generateId }),
      sessionLockManager: new SessionLockManager(redis, {
        ttlMs: 30_000,
        renewIntervalMs: 60_000,
      }),
      piRuntimeFactory: createFakePiRuntimeFactory(factoryOpts),
      modelResolver: async () => fullModel,
      workspaceResolver: async (sess) => `/workspace/${sess.workspaceId}`,
      generateId,
      now: () => new Date(),
      sessionAdapter: {
        captureSnapshotPayload(sm, opts) {
          return {
            header: sm.getHeader(),
            entries: sm.getEntries(),
            ...(opts?.cwd ? {} : {}),
          };
        },
      },
      agentDir: '/tmp/agent-dir',
      sessionLockRenewIntervalMs: 60_000,
    });
  }

  it('executes, projects events, checkpoints snapshot v1, returns SUCCEEDED', async () => {
    const exec = makeExecutor();
    const run = {
      runId: RUN,
      agentSessionId: SESS,
      conversationId: CONV,
      agentVersionId: VER,
      triggeringMessageId: TRIG,
      traceId: 'b'.repeat(32),
      orgId: ORG,
      userId: USER,
    };
    const result = await exec.execute({
      run,
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.SUCCEEDED);
    assert.equal(state.tables.agent_sessions[0].pi_session_version, 1);
    assert.ok(state.tables.run_events.some((e) => e.event_type === 'message.completed'));
    assert.ok(
      state.tables.messages.some((m) => m.pi_entry_id != null),
      'journal rows written',
    );
    // Ordinary UI assistant message (not journal system channel)
    const uiAssistant = state.tables.messages.find(
      (m) =>
        m.role === 'assistant' &&
        String(m.pi_entry_id || '').startsWith('ui:assistant:'),
    );
    assert.ok(uiAssistant, 'UI assistant message persisted for history');
    assert.notEqual(uiAssistant.message_type, 'pi_journal_entry');
    await exec.dispose();
  });

  it('records two assistant message.completed events in the same run (no role-only dedupe)', async () => {
    const generateId = nextId;
    const exec = new PiRunExecutor({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, { now: () => new Date(), generateId }),
      sessionLockManager: new SessionLockManager(redis, {
        ttlMs: 30_000,
        renewIntervalMs: 60_000,
      }),
      piRuntimeFactory: createFakePiRuntimeFactory({
        messageEnds: [
          {
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'first' }],
            },
          },
          {
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'second' }],
            },
          },
        ],
        entries: [
          {
            type: 'message',
            id: 'a1',
            parentId: null,
            timestamp: '2026-07-18T00:00:01.000Z',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'first' }],
            },
          },
          {
            type: 'message',
            id: 'a2',
            parentId: 'a1',
            timestamp: '2026-07-18T00:00:02.000Z',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'second' }],
            },
          },
        ],
      }),
      modelResolver: async () => fullModel,
      workspaceResolver: async (sess) => `/workspace/${sess.workspaceId}`,
      generateId,
      now: () => new Date(),
      sessionAdapter: {
        captureSnapshotPayload(sm) {
          return { header: sm.getHeader(), entries: sm.getEntries() };
        },
      },
      agentDir: '/tmp/agent-dir',
      sessionLockRenewIntervalMs: 60_000,
    });
    const result = await exec.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.SUCCEEDED);
    const completed = state.tables.run_events.filter(
      (e) => e.event_type === 'message.completed',
    );
    assert.equal(completed.length, 2, 'both assistant messages durable');
    await exec.dispose();
  });

  it('fails closed when extensionBundleFactory set but sandboxSessionId missing', async () => {
    state.tables.agent_sessions[0].sandbox_session_id = null;
    const generateId = nextId;
    const exec = new PiRunExecutor({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, { now: () => new Date(), generateId }),
      sessionLockManager: new SessionLockManager(redis, {
        ttlMs: 30_000,
        renewIntervalMs: 60_000,
      }),
      piRuntimeFactory: createFakePiRuntimeFactory(),
      modelResolver: async () => fullModel,
      workspaceResolver: async () => `/workspace/${WSP}`,
      generateId,
      agentDir: '/tmp/agent-dir',
      sessionLockRenewIntervalMs: 60_000,
      extensionBundleFactory: () => {
        throw new Error('bundle must not be called without sandboxSessionId');
      },
    });
    const result = await exec.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.FAILED);
    assert.match(String(result.statusReason), /sandboxSessionId/);
    await exec.dispose().catch(() => {});
  });

  it('propagates acquired executionFenceToken into eventContext for bundle and runtime', async () => {
    const generateId = nextId;
    /** @type {object[]} */
    const bundleContexts = [];
    /** @type {object[]} */
    const runtimeContexts = [];
    const generateIdFn = generateId;
    const exec = new PiRunExecutor({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, {
          now: () => new Date(),
          generateId: generateIdFn,
        }),
      sessionLockManager: new SessionLockManager(redis, {
        ttlMs: 30_000,
        renewIntervalMs: 60_000,
      }),
      piRuntimeFactory: {
        async create(input) {
          runtimeContexts.push(input.context);
          const base = await createFakePiRuntimeFactory().create(input);
          return base;
        },
      },
      modelResolver: async () => fullModel,
      workspaceResolver: async () => `/workspace/${WSP}`,
      generateId: generateIdFn,
      agentDir: '/tmp/agent-dir',
      sessionLockRenewIntervalMs: 60_000,
      extensionBundleFactory: (eventContext) => {
        bundleContexts.push(eventContext);
        return [];
      },
      sessionAdapter: {
        captureSnapshotPayload(sm) {
          return { header: sm.getHeader(), entries: sm.getEntries() };
        },
      },
    });
    const result = await exec.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.SUCCEEDED);
    assert.equal(bundleContexts.length, 1);
    assert.equal(runtimeContexts.length, 1);
    // acquire advances 0 → 1
    assert.equal(bundleContexts[0].executionFenceToken, 1);
    assert.equal(typeof bundleContexts[0].executionFenceToken, 'number');
    assert.equal(runtimeContexts[0].executionFenceToken, 1);
    assert.equal(runtimeContexts[0].runId, RUN);
    assert.equal(runtimeContexts[0].sandboxSessionId, SBX);
    await exec.dispose();
  });

  it('fails closed on invalid acquired fence before extension/runtime', async () => {
    const generateId = nextId;
    let bundleCalled = 0;
    let runtimeCalled = 0;
    const generateIdFn = generateId;
    const baseCreateRepos = (db) =>
      createRepositoryBundle(db, {
        now: () => new Date(),
        generateId: generateIdFn,
      });
    const exec = new PiRunExecutor({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) => {
        const repos = baseCreateRepos(db);
        return {
          ...repos,
          sessions: {
            ...repos.sessions,
            async acquireExecutionFenceForRun(...args) {
              const r = await repos.sessions.acquireExecutionFenceForRun(
                ...args,
              );
              // Simulate corrupt fence after acquisition without coercing.
              return { ...r, fenceToken: 0 };
            },
          },
        };
      },
      sessionLockManager: new SessionLockManager(redis, {
        ttlMs: 30_000,
        renewIntervalMs: 60_000,
      }),
      piRuntimeFactory: {
        async create() {
          runtimeCalled += 1;
          throw new Error('runtime must not be created');
        },
      },
      modelResolver: async () => fullModel,
      workspaceResolver: async () => `/workspace/${WSP}`,
      generateId: generateIdFn,
      agentDir: '/tmp/agent-dir',
      sessionLockRenewIntervalMs: 60_000,
      extensionBundleFactory: () => {
        bundleCalled += 1;
        throw new Error('bundle must not be called');
      },
    });
    const result = await exec.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.FAILED);
    assert.match(String(result.statusReason), /executionFenceToken|positive/i);
    assert.equal(bundleCalled, 0);
    assert.equal(runtimeCalled, 0);
    await exec.dispose().catch(() => {});
  });

  it('rejects triggering message that does not bind to run', async () => {
    state.tables.messages[0].conversation_id = '01K0G2PAV8FPMVC9QHJG7JPN99';
    // Keep conversation row for ownership of wrong conv absent → getById null
    // Force wrong conversation id on message while same run
    state.tables.conversations.push({
      conversation_id: '01K0G2PAV8FPMVC9QHJG7JPN99',
      org_id: ORG,
      user_id: USER,
      agent_id: DEF,
      title: null,
      status: 'active',
      current_agent_session_id: null,
      created_at: '2026-07-18 00:00:00.000',
      updated_at: '2026-07-18 00:00:00.000',
      archived_at: null,
    });
    const exec = makeExecutor();
    const result = await exec.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.FAILED);
    assert.match(String(result.statusReason), /conversationId|triggering/i);
  });

  it('fails closed when triggering agentSessionId or runId is null or mismatched', async () => {
    // null agentSessionId
    state.tables.messages[0].agent_session_id = null;
    let exec = makeExecutor();
    let result = await exec.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.FAILED);
    assert.match(String(result.statusReason), /agentSessionId/i);
    await exec.dispose().catch(() => {});

    // reset + null runId
    seedExecutorWorld(state);
    knex = createFakeKnex(state);
    redis = createFakeRedis();
    state.tables.messages[0].run_id = null;
    exec = makeExecutor();
    result = await exec.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.FAILED);
    assert.match(String(result.statusReason), /runId/i);
    await exec.dispose().catch(() => {});

    // mismatch runId
    seedExecutorWorld(state);
    knex = createFakeKnex(state);
    redis = createFakeRedis();
    state.tables.messages[0].run_id = '01K0G2PAV8FPMVC9QHJG7JPN9A';
    exec = makeExecutor();
    result = await exec.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.FAILED);
    assert.match(String(result.statusReason), /runId/i);
  });

  it('only writes UI assistant for this-run entries; recovered history not rebound', async () => {
    // Seed recovered journal/snapshot with prior assistant entry e-old (no UI row).
    const { checksumSnapshotPayload } = await import(
      '../../src/infrastructure/pi/pi-jsonl-codec.js'
    );
    const oldPayload = {
      header: {
        type: 'session',
        version: 3,
        id: SESS,
        timestamp: '2026-07-18T00:00:00.000Z',
        cwd: `/workspace/${WSP}`,
      },
      entries: [
        {
          type: 'message',
          id: 'e-old',
          parentId: null,
          timestamp: '2026-07-18T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'prior history' }],
          },
        },
      ],
    };
    const checksum = checksumSnapshotPayload(oldPayload);
    state.tables.agent_session_snapshots = [
      {
        snapshot_id: '01K0G2PAV8FPMVC9QHJG7JPN9B',
        agent_session_id: SESS,
        snapshot_version: 1,
        snapshot_format: 'pi_jsonl_v3',
        snapshot_json: oldPayload,
        workspace_path: `/workspace/${WSP}`,
        checksum,
        pi_sdk_version: PINNED_PI_SDK_VERSION,
        captured_fence_token: 0,
        created_at: '2026-07-18 00:00:00.000',
      },
    ];
    state.tables.agent_sessions[0].pi_session_version = 1;
    // Journal rows for old entry (recovery truth) — no ui:assistant:e-old
    state.tables.messages.push({
      message_id: '01K0G2PAV8FPMVC9QHJG7JPN9C',
      conversation_id: CONV,
      agent_session_id: SESS,
      run_id: '01K0G2PAV8FPMVC9QHJG7JPN9D',
      role: 'system',
      message_type: 'pi_journal_header',
      content_json: JSON.stringify({
        kind: 'pi_journal_header',
        header: oldPayload.header,
        payloadHash: checksumSnapshotPayload({
          header: oldPayload.header,
          entries: [],
        }).slice(0, 64),
      }),
      sequence_no: 2,
      pi_entry_id: '__pi_session_header__',
      pi_entry_kind: 'session',
      created_at: '2026-07-18 00:00:00.000',
    });
    // Note: payloadHash for header alone may not match full checksum — use real hash helper
    const { hashJournalPayload } = await import(
      '../../src/infrastructure/mysql/repositories/pi-session-journal-repository.js'
    );
    state.tables.messages[state.tables.messages.length - 1].content_json =
      JSON.stringify({
        kind: 'pi_journal_header',
        header: oldPayload.header,
        payloadHash: hashJournalPayload(oldPayload.header),
      });
    state.tables.messages.push({
      message_id: '01K0G2PAV8FPMVC9QHJG7JPN9E',
      conversation_id: CONV,
      agent_session_id: SESS,
      run_id: '01K0G2PAV8FPMVC9QHJG7JPN9D',
      role: 'system',
      message_type: 'pi_journal_entry',
      content_json: JSON.stringify({
        kind: 'pi_journal_entry',
        entry: oldPayload.entries[0],
        payloadHash: hashJournalPayload(oldPayload.entries[0]),
      }),
      sequence_no: 3,
      pi_entry_id: 'e-old',
      pi_entry_kind: 'message',
      created_at: '2026-07-18 00:00:00.000',
    });

    const exec = makeExecutor({
      captureFromSnapshot: true,
      entries: [
        {
          type: 'message',
          id: 'e-new',
          parentId: 'e-old',
          timestamp: '2026-07-18T00:00:02.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'this run only' }],
          },
        },
      ],
    });
    const result = await exec.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.SUCCEEDED);
    const uiRows = state.tables.messages.filter(
      (m) =>
        m.role === 'assistant' &&
        String(m.pi_entry_id || '').startsWith('ui:assistant:'),
    );
    assert.equal(uiRows.length, 1);
    assert.equal(uiRows[0].pi_entry_id, 'ui:assistant:e-new');
    assert.equal(uiRows[0].run_id, RUN);
    // Must not have re-bound old history to this run
    assert.ok(!uiRows.some((m) => m.pi_entry_id === 'ui:assistant:e-old'));
    await exec.dispose();
  });

  it('external emit runs only after DB commit (no ghost on rollback)', async () => {
    const emitLog = [];
    /** @type {{ fail: boolean }} */
    const outboxCtrl = { fail: false };
    const generateId = nextId;
    const wrapRepos = (db) => {
      const repos = createRepositoryBundle(db, {
        now: () => new Date(),
        generateId,
      });
      return {
        ...repos,
        outbox: {
          insert: async (input) => {
            if (outboxCtrl.fail && input.eventType === 'message.completed') {
              throw new Error('outbox boom after runEvents');
            }
            return repos.outbox.insert(input);
          },
        },
      };
    };
    const exec = new PiRunExecutor({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: wrapRepos,
      sessionLockManager: new SessionLockManager(redis, {
        ttlMs: 30_000,
        renewIntervalMs: 60_000,
      }),
      piRuntimeFactory: createFakePiRuntimeFactory(),
      modelResolver: async () => fullModel,
      workspaceResolver: async () => `/workspace/${WSP}`,
      generateId,
      sessionAdapter: {
        captureSnapshotPayload(sm) {
          return { header: sm.getHeader(), entries: sm.getEntries() };
        },
      },
      agentDir: '/tmp/agent-dir',
      sessionLockRenewIntervalMs: 60_000,
    });

    // Happy path: emit after durable events exist
    outboxCtrl.fail = false;
    const r1 = await exec.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
      emit: async (env) => {
        const found = state.tables.run_events.some(
          (e) => e.event_id === env.payload.eventId,
        );
        emitLog.push({ type: env.type, durable: found });
      },
    });
    assert.equal(r1.outcome, RUN_STATUS.SUCCEEDED);
    assert.ok(emitLog.length > 0);
    assert.ok(emitLog.every((e) => e.durable === true));
    await exec.dispose();

    // Rollback path: outbox fails → emit must not fire for that event batch
    seedExecutorWorld(state);
    knex = createFakeKnex(state);
    redis = createFakeRedis();
    const emitLog2 = [];
    outboxCtrl.fail = true;
    const exec2 = new PiRunExecutor({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: wrapRepos,
      sessionLockManager: new SessionLockManager(redis, {
        ttlMs: 30_000,
        renewIntervalMs: 60_000,
      }),
      piRuntimeFactory: createFakePiRuntimeFactory(),
      modelResolver: async () => fullModel,
      workspaceResolver: async () => `/workspace/${WSP}`,
      generateId,
      sessionAdapter: {
        captureSnapshotPayload(sm) {
          return { header: sm.getHeader(), entries: sm.getEntries() };
        },
      },
      agentDir: '/tmp/agent-dir',
      sessionLockRenewIntervalMs: 60_000,
    });
    const r2 = await exec2.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w2',
      signal: new AbortController().signal,
      emit: async (env) => {
        emitLog2.push(env.type);
      },
    });
    assert.equal(emitLog2.length, 0);
    assert.ok(
      !state.tables.run_events.some((e) => e.event_type === 'message.completed'),
      'rolled-back message.completed must not remain',
    );
    await exec2.dispose().catch(() => {});
    void r2;
  });

  it('renew=false before writes: no assistant UI and no snapshot commit', async () => {
    const generateId = nextId;
    const baseLocks = new SessionLockManager(redis, {
      ttlMs: 30_000,
      renewIntervalMs: 60_000,
    });
    let allowRenew = true;
    const locks = {
      renewIntervalMs: 60_000,
      acquire: (id, tok) => baseLocks.acquire(id, tok),
      release: (id, tok) => baseLocks.release(id, tok),
      renew: async (id, tok) => {
        if (!allowRenew) return false;
        return baseLocks.renew(id, tok);
      },
    };
    const exec = new PiRunExecutor({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, { now: () => new Date(), generateId }),
      sessionLockManager: locks,
      piRuntimeFactory: createFakePiRuntimeFactory({
        onPrompt: async () => {
          // After prompt work, pre-write confirmSessionLock must fail.
          allowRenew = false;
        },
      }),
      modelResolver: async () => fullModel,
      workspaceResolver: async () => `/workspace/${WSP}`,
      generateId,
      sessionAdapter: {
        captureSnapshotPayload(sm) {
          return { header: sm.getHeader(), entries: sm.getEntries() };
        },
      },
      agentDir: '/tmp/agent-dir',
      sessionLockRenewIntervalMs: 60_000,
    });
    const result = await exec.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.FAILED);
    assert.match(String(result.statusReason), /lock lost/i);
    assert.equal(
      state.tables.messages.filter((m) =>
        String(m.pi_entry_id || '').startsWith('ui:assistant:'),
      ).length,
      0,
    );
    assert.equal(state.tables.agent_session_snapshots.length, 0);
    assert.equal(state.tables.agent_sessions[0].pi_session_version, 0);
    await exec.dispose().catch(() => {});
  });

  it('old session keeps agentVersionId when catalog default changes', async () => {
    // Catalog now points at a different active version
    const NEW_VER = '01K0G2PAV8FPMVC9QHJG7JPN99';
    state.tables.agent_versions.push({
      agent_version_id: NEW_VER,
      agent_id: DEF,
      version_no: 2,
      config_json: JSON.stringify({ systemPrompt: 'new default' }),
      config_hash: 'f'.repeat(64),
      pi_sdk_version: PINNED_PI_SDK_VERSION,
      status: 'active',
      created_by: USER,
      created_at: '2026-07-18 00:00:00.000',
    });
    state.tables.agent_definitions[0].active_version_id = NEW_VER;
    // Session + run still pin VER
    assert.equal(state.tables.agent_sessions[0].agent_version_id, VER);
    assert.equal(state.tables.runs[0].agent_version_id, VER);

    let resolvedVersionId = null;
    const generateId = nextId;
    const exec = new PiRunExecutor({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, { now: () => new Date(), generateId }),
      sessionLockManager: new SessionLockManager(redis, {
        ttlMs: 30_000,
        renewIntervalMs: 60_000,
      }),
      piRuntimeFactory: createFakePiRuntimeFactory(),
      modelResolver: async (agentVersion) => {
        resolvedVersionId = agentVersion.agentVersionId;
        return fullModel;
      },
      workspaceResolver: async (sess) => `/workspace/${sess.workspaceId}`,
      generateId,
      sessionAdapter: {
        captureSnapshotPayload(sm) {
          return { header: sm.getHeader(), entries: sm.getEntries() };
        },
      },
      agentDir: '/tmp/agent-dir',
      sessionLockRenewIntervalMs: 60_000,
    });
    const result = await exec.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.SUCCEEDED);
    assert.equal(resolvedVersionId, VER);
    assert.notEqual(resolvedVersionId, NEW_VER);
    await exec.dispose();
  });

  it('same-session concurrent executor loses/busy lock', async () => {
    const locks = new SessionLockManager(redis, { ttlMs: 30_000 });
    const tokenA = 'w1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    assert.equal(await locks.acquire(SESS, tokenA), true);

    const exec = makeExecutor();
    const result = await exec.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w2',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.FAILED);
    assert.match(String(result.statusReason), /lock busy/i);
  });

  it('stale fence cannot journal/event/checkpoint after lose', async () => {
    const exec = makeExecutor();
    // Pre-advance fence so acquire gets 1, then we break by changing fence mid-flight
    // via onPrompt
    const factory = createFakePiRuntimeFactory({
      onPrompt: async () => {
        state.tables.agent_sessions[0].execution_fence_token = 999;
      },
    });
    const generateId = nextId;
    const broken = new PiRunExecutor({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, { now: () => new Date(), generateId }),
      sessionLockManager: new SessionLockManager(redis, { ttlMs: 30_000 }),
      piRuntimeFactory: factory,
      modelResolver: async () => fullModel,
      workspaceResolver: async () => '/ws',
      generateId,
      sessionAdapter: {
        captureSnapshotPayload(sm) {
          return { header: sm.getHeader(), entries: sm.getEntries() };
        },
      },
      agentDir: '/tmp/a',
    });
    const result = await broken.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.FAILED);
    // No success snapshot under stolen fence
    assert.equal(
      state.tables.agent_session_snapshots.filter(
        (s) => Number(s.captured_fence_token) === 1,
      ).length,
      0,
    );
  });

  it('cancellation aborts runtime and dispose releases lock once', async () => {
    const ac = new AbortController();
    /** @type {{ aborted: boolean }} */
    const runtime = { aborted: false };
    const factory = {
      async create() {
        const subs = [];
        const sessionManager = {
          getHeader: () => ({
            type: 'session',
            version: 3,
            id: SESS,
            timestamp: '2026-07-18T00:00:00.000Z',
            cwd: '/ws',
          }),
          getEntries: () => [],
          getCwd: () => '/ws',
        };
        return {
          session: {
            subscribe(fn) {
              subs.push(fn);
              return () => {};
            },
            abort() {
              runtime.aborted = true;
            },
            async prompt() {
              // Abort mid-prompt so AbortSignal handler runs runtime.session.abort
              ac.abort();
              await new Promise((r) => setTimeout(r, 10));
              if (ac.signal.aborted) {
                const err = new Error('aborted');
                err.name = 'AbortError';
                throw err;
              }
            },
          },
          sessionManager,
          dispose: async () => {},
        };
      },
    };
    const generateId = nextId;
    const locks = new SessionLockManager(redis, { ttlMs: 30_000 });
    const exec = new PiRunExecutor({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, { now: () => new Date(), generateId }),
      sessionLockManager: locks,
      piRuntimeFactory: factory,
      modelResolver: async () => fullModel,
      workspaceResolver: async () => '/ws',
      generateId,
      sessionAdapter: {
        captureSnapshotPayload(sm) {
          return { header: sm.getHeader(), entries: sm.getEntries() };
        },
      },
      agentDir: '/tmp/a',
    });
    const result = await exec.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
      },
      scope,
      workerId: 'w1',
      signal: ac.signal,
    });
    assert.ok(
      result.outcome === RUN_STATUS.CANCELLED ||
        result.outcome === RUN_STATUS.FAILED,
    );
    assert.equal(runtime.aborted, true);
    await exec.dispose();
    await exec.dispose(); // idempotent
    // Lock released — re-acquire succeeds
    assert.equal(await locks.acquire(SESS, 'w1:postdisposeaaaaaaaaaaaaaaaaaa'), true);
  });

  it('createPiRunExecutorFactory requires resolvers and is not auto-default', () => {
    assert.throws(
      () => createPiRunExecutorFactory({}),
      /modelResolver/,
    );
    assert.throws(
      () =>
        createPiRunExecutorFactory({
          modelResolver: () => fullModel,
        }),
      /workspaceResolver/,
    );
  });

  it('production modules do not assign agent.state.messages', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const root = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src',
    );
    const files = [
      'application/pi-run-executor.js',
      'application/session-recovery-service.js',
      'infrastructure/pi/pi-session-adapter.js',
      'infrastructure/pi/pi-runtime-factory.js',
    ];
    for (const f of files) {
      const src = readFileSync(path.join(root, f), 'utf8');
      assert.equal(
        /agent\.state\.messages\s*=/.test(src),
        false,
        `${f} must not assign agent.state.messages`,
      );
    }
  });
});

describe('ExecuteRunService unique run lease token', () => {
  it('delayed release from old attempt cannot release newer lease with same workerId', async () => {
    const redis = createFakeRedis();
    const leaseManager = new LeaseManager(redis, { ttlMs: 60_000 });
    const runId = RUN;
    const workerId = 'worker-shared';

    const tokenOld = generateRunLeaseOwnerToken(workerId, {
      randomBytes: () => Buffer.alloc(16, 1),
    });
    const tokenNew = generateRunLeaseOwnerToken(workerId, {
      randomBytes: () => Buffer.alloc(16, 2),
    });
    assert.notEqual(tokenOld, tokenNew);

    assert.equal(await leaseManager.acquire(runId, tokenOld), true);
    // Simulate old attempt still holding, then new attempt cannot acquire
    assert.equal(await leaseManager.acquire(runId, tokenNew), false);

    // New attempt wins after old releases
    assert.equal(await leaseManager.release(runId, tokenOld), true);
    assert.equal(await leaseManager.acquire(runId, tokenNew), true);

    // Delayed release from OLD token must not drop NEW lease
    assert.equal(await leaseManager.release(runId, tokenOld), false);
    assert.equal(await leaseManager.renew(runId, tokenNew), true);
    assert.equal(await leaseManager.release(runId, tokenNew), true);
  });

  it('ExecuteRunService uses unique tokens (regression via lease manager)', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    seedExecutorWorld(state);
    // Put run in QUEUED so execute advances — use stub executor
    state.tables.runs[0].status = 'QUEUED';
    state.tables.runs[0].attempt = 0;

    const redis = createFakeRedis();
    const leaseManager = new LeaseManager(redis, { ttlMs: 60_000 });
    const tokens = [];
    const wrappingLease = {
      renewIntervalMs: 60_000,
      acquire: async (runId, token) => {
        tokens.push(token);
        return leaseManager.acquire(runId, token);
      },
      renew: (runId, token) => leaseManager.renew(runId, token),
      release: (runId, token) => leaseManager.release(runId, token),
    };

    const generateId = createUlidGenerator({ now: () => 1_721_278_800_000 });
    const svc = new ExecuteRunService({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, { now: () => new Date(), generateId }),
      leaseManager: wrappingLease,
      runExecutorFactory: () => createStubRunExecutor(),
      generateId,
      now: () => new Date(),
      cancelPollIntervalMs: 50,
      leaseRenewIntervalMs: 60_000,
    });

    await svc.execute({
      runId: RUN,
      orgId: ORG,
      traceId: 'b'.repeat(32),
      workerId: 'w-same',
    });
    assert.equal(tokens.length, 1);
    assert.match(tokens[0], /^w-same:[0-9a-f]{32}$/);

    // Second execute with same workerId gets a different token
    state.tables.runs[0].status = 'QUEUED';
    state.tables.runs[0].attempt = 1;
    state.tables.runs[0].completed_at = null;
    await svc.execute({
      runId: RUN,
      orgId: ORG,
      traceId: 'b'.repeat(32),
      workerId: 'w-same',
    });
    assert.equal(tokens.length, 2);
    assert.notEqual(tokens[0], tokens[1]);
  });
});
