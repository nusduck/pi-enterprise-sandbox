/**
 * PiRunExecutor offline tests with fakes (PR-05 slice B).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createFakeRedis } from '../redis/fake-redis.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import {
  DshRunExecutor,
  appendCurrentTurnAttachmentContext,
  attachmentsFromTriggeringMessage,
  createDshRunExecutorFactory,
  generateRunLeaseOwnerToken,
  derivePromptFromTriggeringMessage,
  imageAttachmentsFromTriggeringMessage,
  requestedModelIdFromTriggeringMessage,
  toDshPromptInvocation,
} from '../../src/application/dsh-run-executor.js';
import { SessionLockManager } from '../../src/infrastructure/redis/session-lock-manager.js';
import { LeaseManager } from '../../src/infrastructure/redis/lease-manager.js';
import { ExecuteRunService } from '../../src/application/execute-run-service.js';
import { createStubRunExecutor } from '../../src/application/run-executor.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';
import { PINNED_PI_SDK_VERSION } from '../../src/infrastructure/dsh/runtime-factory.js';

import {
  CONV,
  DEF,
  ORG,
  RUN,
  SBX,
  SESS,
  TRIG,
  USER,
  VER,
  WSP,
  fullModel,
  seedExecutorWorld,
} from './executor-world.js';


/**
 * Minimal fake Pi runtime factory for offline tests.
 * @param {{
 *   onPrompt?: Function,
 *   onSteer?: Function,
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
        async steer(text) {
          if (typeof opts.onSteer === 'function') await opts.onSteer(text);
        },
        async prompt(p, promptOptions) {
          if (opts.failPrompt) throw opts.failPrompt;
          if (typeof opts.onPrompt === 'function') {
            await opts.onPrompt(p, { aborted, options: promptOptions });
          }
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

  it('adapts stored content parts to the Pi prompt(text, { images }) API', () => {
    const invocation = toDshPromptInvocation([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
      { type: 'image', data: 'base64-data', mimeType: 'image/png' },
    ]);

    assert.equal(invocation.text, 'first\nsecond');
    assert.deepEqual(invocation.options, {
      images: [
        { type: 'image', data: 'base64-data', mimeType: 'image/png' },
      ],
    });
  });

  it('adapts browser text-part messages to a string prompt', () => {
    const durable = derivePromptFromTriggeringMessage({
      contentJson: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'browser prompt' }] },
        ],
      },
    });

    assert.deepEqual(toDshPromptInvocation(durable), {
      text: 'browser prompt',
    });
  });

  it('extracts model and image attachment ids without trusting browser paths', () => {
    const message = {
      contentJson: {
        modelId: 'deepseek-v4-flash-vision-exp',
        messages: [{
          role: 'user',
          content: 'look',
          attachments: [{
            attachment_id: 'dataset-1',
            workspace_path: '../../outside.png',
            mime_type: 'image/png',
            size: 123,
          }],
        }],
      },
    };
    assert.equal(requestedModelIdFromTriggeringMessage(message), 'deepseek-v4-flash-vision-exp');
    assert.deepEqual(imageAttachmentsFromTriggeringMessage(message), [{
      attachmentId: 'dataset-1',
      mimeType: 'image/png',
      name: 'image',
      size: 123,
    }]);
    assert.equal(
      'workspacePath' in imageAttachmentsFromTriggeringMessage(message)[0],
      false,
    );
    assert.deepEqual(attachmentsFromTriggeringMessage(message), [{
      attachmentId: 'dataset-1',
      filename: 'image',
      mimeType: 'image/png',
      size: 123,
    }]);
    const prompt = appendCurrentTurnAttachmentContext(
      'look',
      attachmentsFromTriggeringMessage(message),
    );
    assert.match(prompt, /attachment_id="dataset-1"/);
    assert.doesNotMatch(prompt, /\.\.\/\.\.\/outside\.png/);
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

describe('DshRunExecutor', () => {
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
    return new DshRunExecutor({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, { now: () => new Date(), generateId }),
      sessionLockManager: new SessionLockManager(redis, {
        ttlMs: 30_000,
        renewIntervalMs: 60_000,
      }),
      piRuntimeFactory: createFakePiRuntimeFactory(factoryOpts),
      modelResolver: async () => factoryOpts.model ?? fullModel,
      promptImageLoader: factoryOpts.promptImageLoader,
      workspaceResolver: async (sess) => `/workspace/${sess.workspaceId}`,
      generateId,
      now: () => new Date(),
      sessionAdapter: factoryOpts.sessionAdapter ?? {
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

  it('keeps session-subscribe projection when the extension bundle is empty', async () => {
    const exec = makeExecutor({
    });
    const result = await exec.execute({
      run: {
        runId: RUN,
        agentSessionId: SESS,
        conversationId: CONV,
        agentVersionId: VER,
        triggeringMessageId: TRIG,
        traceId: 'b'.repeat(32),
        orgId: ORG,
        userId: USER,
      },
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.SUCCEEDED);
    assert.ok(
      state.tables.run_events.some((e) => e.event_type === 'message.completed'),
      'empty Wave-6 bundle must not disable session-subscribe projection',
    );
    await exec.dispose();
  });

  it('does not fail with snapshot header is required when adapter returns a Promise of null', async () => {
    const exec = makeExecutor({
      sessionAdapter: {
        async captureSnapshotPayload() {
          return null;
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
        orgId: ORG,
        userId: USER,
      },
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.SUCCEEDED);
    assert.notEqual(result.statusReason, 'snapshot header is required');
    await exec.dispose();
  });

  it('loads current-turn image ids and passes Pi prompt image content directly', async () => {
    state.tables.messages[0].content_json = JSON.stringify({
      modelId: 'deepseek-v4-flash-vision-exp',
      messages: [{
        role: 'user',
        content: 'describe image',
        attachments: [{
          attachment_id: 'dataset-1',
          mime_type: 'image/png',
          size: 8,
        }],
      }],
    });
    let loaderInput;
    let promptInput;
    const image = {
      type: 'image',
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
    };
    const exec = makeExecutor({
      model: { ...fullModel, id: 'deepseek-v4-flash-vision-exp', input: ['text', 'image'] },
      promptImageLoader: async (input) => {
        loaderInput = input;
        return [image];
      },
      onPrompt: async (text, state) => {
        promptInput = { text, options: state.options };
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
      workerId: 'w-image',
      signal: new AbortController().signal,
    });

    assert.equal(result.outcome, RUN_STATUS.SUCCEEDED);
    assert.equal(loaderInput.attachments[0].attachmentId, 'dataset-1');
    assert.equal(loaderInput.sandboxSessionId, SBX);
    assert.equal(loaderInput.workspaceId, WSP);
    assert.match(promptInput.text, /^describe image/);
    assert.match(promptInput.text, /attachment_id="dataset-1"/);
    assert.deepEqual(promptInput.options, { images: [image] });
    await exec.dispose();
  });

  it('returns FAILED when Pi resolves with a terminal assistant stopReason=error', async () => {
    const exec = makeExecutor({
      entries: [
        {
          type: 'message',
          id: 'assistant-error',
          parentId: null,
          timestamp: '2026-07-18T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'Provider quota exhausted',
          },
        },
      ],
      messageEnds: [
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
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
      workerId: 'w-stop-reason-error',
      signal: new AbortController().signal,
    });

    assert.equal(result.outcome, RUN_STATUS.FAILED);
    assert.match(String(result.statusReason), /stopReason=error/);
    assert.match(String(result.statusReason), /Provider quota exhausted/);
    await exec.dispose();
  });

  it('ignores intermediate Connection error when the final assistant stopReason is stop', async () => {
    // Provider/network flakes record stopReason=error mid-prompt; Pi may retry
    // and finish successfully. Only the last new assistant entry is terminal.
    const exec = makeExecutor({
      entries: [
        {
          type: 'message',
          id: 'assistant-conn-1',
          parentId: null,
          timestamp: '2026-07-18T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'Connection error.',
            provider: 'llmio',
          },
        },
        {
          type: 'message',
          id: 'assistant-conn-2',
          parentId: 'assistant-conn-1',
          timestamp: '2026-07-18T00:00:02.000Z',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'Connection error.',
            provider: 'llmio',
          },
        },
        {
          type: 'message',
          id: 'assistant-ok',
          parentId: 'assistant-conn-2',
          timestamp: '2026-07-18T00:00:03.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Here is your plan.' }],
            stopReason: 'stop',
            provider: 'llmio',
          },
        },
      ],
      messageEnds: [
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Here is your plan.' }],
            stopReason: 'stop',
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
      workerId: 'w-conn-retry-ok',
      signal: new AbortController().signal,
    });

    assert.equal(result.outcome, RUN_STATUS.SUCCEEDED);
    assert.equal(result.statusReason, null);
    await exec.dispose();
  });

  it('still FAILED when the final assistant is stopReason=error after intermediate retries', async () => {
    const exec = makeExecutor({
      entries: [
        {
          type: 'message',
          id: 'assistant-conn-1',
          parentId: null,
          timestamp: '2026-07-18T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'Connection error.',
          },
        },
        {
          type: 'message',
          id: 'assistant-final-error',
          parentId: 'assistant-conn-1',
          timestamp: '2026-07-18T00:00:02.000Z',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'Connection error.',
          },
        },
      ],
      messageEnds: [
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'error',
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
      workerId: 'w-conn-retry-fail',
      signal: new AbortController().signal,
    });

    assert.equal(result.outcome, RUN_STATUS.FAILED);
    assert.match(String(result.statusReason), /Connection error/);
    await exec.dispose();
  });

  it('returns CANCELLED when Pi resolves with a terminal assistant stopReason=aborted', async () => {
    const exec = makeExecutor({
      entries: [
        {
          type: 'message',
          id: 'assistant-aborted',
          parentId: null,
          timestamp: '2026-07-18T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'aborted',
          },
        },
      ],
      messageEnds: [
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'aborted',
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
      workerId: 'w-stop-reason-aborted',
      signal: new AbortController().signal,
    });

    assert.equal(result.outcome, RUN_STATUS.CANCELLED);
    assert.match(String(result.statusReason), /stopReason=aborted/);
    await exec.dispose();
  });

  it('delivers a durable steer request through native session.steer while prompt runs', async () => {
    const steerId = '01K0G2PAV8FPMVC9QHJG7JPN5K';
    const steerMessageId = '01K0G2PAV8FPMVC9QHJG7JPN5M';
    state.tables.messages.push({
      message_id: steerMessageId,
      conversation_id: CONV,
      agent_session_id: SESS,
      run_id: RUN,
      role: 'user',
      message_type: 'steer_instruction',
      content_json: JSON.stringify({ text: 'inspect the outliers first' }),
      sequence_no: 2,
      pi_entry_id: null,
      pi_entry_kind: null,
      created_at: '2026-07-18 00:00:01.000',
    });
    state.tables.run_events.push({
      event_id: steerId,
      run_id: RUN,
      org_id: ORG,
      sequence_no: 1,
      event_type: 'run.steer.requested',
      event_version: 1,
      payload_json: JSON.stringify({
        steerId,
        messageId: steerMessageId,
      }),
      trace_id: 'b'.repeat(32),
      span_id: null,
      created_at: '2026-07-18 00:00:01.000',
    });
    state.tables.runs[0].next_event_sequence = 1;

    const delivered = [];
    const exec = makeExecutor({
      onSteer: async (text) => delivered.push(text),
      onPrompt: async () =>
        new Promise((resolve) => setTimeout(resolve, 30)),
    });
    exec.steerPollIntervalMs = 5;
    const result = await exec.execute({
      run: { runId: RUN },
      scope,
      workerId: 'w-steer',
      signal: new AbortController().signal,
    });

    assert.equal(result.outcome, RUN_STATUS.SUCCEEDED);
    assert.deepEqual(delivered, ['inspect the outliers first']);
    const acknowledged = state.tables.run_events.find(
      (event) => event.event_type === 'run.steer.delivered',
    );
    assert.ok(acknowledged);
    assert.equal(JSON.parse(acknowledged.payload_json).data.steerId, steerId);
    await exec.dispose();
  });

  it('provisions the exact SandboxSession binding before Pi runtime work', async () => {
    const calls = [];
    const exec = makeExecutor();
    exec.sandboxSessionProvisioner = {
      ensure: async (input) => calls.push(input),
    };
    const result = await exec.execute({
      run: { runId: RUN },
      scope,
      workerId: 'w-provision',
      signal: new AbortController().signal,
    });

    assert.equal(result.outcome, RUN_STATUS.SUCCEEDED);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      orgId: ORG,
      userId: USER,
      conversationId: CONV,
      agentSessionId: SESS,
      sandboxSessionId: SBX,
      runId: RUN,
      workspaceId: WSP,
      executionFenceToken: 1,
      traceId: 'b'.repeat(32),
    });
    await exec.dispose();
  });

  it('records two assistant message.completed events in the same run (no role-only dedupe)', async () => {
    const generateId = nextId;
    const exec = new DshRunExecutor({
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

  // 2026-08-31（计划 H8）：这条以前断言的是「注入 bundle 且 sandboxSessionId 为空
  // 时 fail closed」。那条 fail-closed 的**触发条件是 bundle 存在**，而生产从来
  // 没有接过 bundle——所以它只在测试里跑过。bundle 形参删掉之后，改成
  // 「有值才校验格式」：保住「格式不对就别往下走」这一半，不改变哪些 Run 能跑
  // （把它改成无条件会让没有 sandboxSessionId 的 Run 从此起不来，超出 H8 范围）。
  it('fails closed when sandboxSessionId is present but malformed', async () => {
    state.tables.agent_sessions[0].sandbox_session_id = 'not-a-ulid';
    const generateId = nextId;
    const exec = new DshRunExecutor({
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

  it('propagates acquired executionFenceToken into the runtime eventContext', async () => {
    const generateId = nextId;
    /** @type {object[]} */
    const runtimeContexts = [];
    const generateIdFn = generateId;
    const exec = new DshRunExecutor({
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
    assert.equal(runtimeContexts.length, 1);
    // acquire advances 0 → 1
    assert.equal(runtimeContexts[0].executionFenceToken, 1);
    assert.equal(typeof runtimeContexts[0].executionFenceToken, 'number');
    assert.equal(runtimeContexts[0].runId, RUN);
    assert.equal(runtimeContexts[0].sandboxSessionId, SBX);
    // 2026-08-31（计划 H8）：以下这些以前是**经 extensionBundleFactory 的 deps**
    // 观察的（observability / getAgentSession / isDurableInteractionPending /
    // runSuspensionPort）。bundle 形参删掉之后，前两样随之消失（那是给已删除的
    // Pi Extension 用的），而**停泊标记的生命周期是真实不变量**，改成直接断言。
    //
    // 标记本身由 `onDurableInteractionPending` 写入（ask_user 落 durable 请求时），
    // 这里只验它的两端：写入前是空的、dispose 之后被清掉。中间那一段的写入由
    // `prepareInteractionResume` 的用例覆盖。
    assert.equal(
      exec._pendingInteractionToolCallIds.size,
      0,
      '这一轮没有 ask_user 停泊，标记集合应当是空的',
    );
    exec._pendingInteractionToolCallIds.add('ask-user-pending-1');
    await exec.dispose();
    assert.equal(
      exec._pendingInteractionToolCallIds.size,
      0,
      'dispose 必须清掉这个**临时**标记——它只在本 Run 内有意义，' +
        '留着会让同一个 executor 实例的下一轮误判为「已停泊」',
    );
  });

  it('passes a toolPolicyBinding so configJson.toolPolicy is not fail-closed', async () => {
    // Regression: the factory rejects a non-empty configJson.toolPolicy unless
    // a binding proves it is honoured, and nothing used to supply one — so any
    // AgentVersion that configured tool policy at all failed every Run with
    // PI_BINDING_REQUIRED.
    state.tables.agent_versions[0].config_json = JSON.stringify({
      systemPrompt: 'hi',
      toolPolicy: {
        tools: { bash: 'deny' },
        riskLevels: { python: 'high' },
      },
    });
    const generateId = nextId;
    /** @type {object[]} */
    const createInputs = [];
    const exec = new DshRunExecutor({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, { now: () => new Date(), generateId }),
      sessionLockManager: new SessionLockManager(redis, {
        ttlMs: 30_000,
        renewIntervalMs: 60_000,
      }),
      piRuntimeFactory: {
        async create(input) {
          createInputs.push(input);
          return createFakePiRuntimeFactory().create(input);
        },
      },
      modelResolver: async () => fullModel,
      workspaceResolver: async () => `/workspace/${WSP}`,
      generateId,
      agentDir: '/tmp/agent-dir',
      sessionLockRenewIntervalMs: 60_000,
      sessionAdapter: {
        captureSnapshotPayload: (sm) => ({
          header: sm.getHeader(),
          entries: sm.getEntries(),
        }),
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
    assert.equal(createInputs.length, 1);
    const binding = createInputs[0].toolPolicyBinding;
    assert.ok(binding, 'toolPolicyBinding must reach piRuntimeFactory.create');
    assert.equal(binding.appliedBy, 'enterprise-policy');
    assert.deepEqual(binding.tools, { bash: 'deny' });
    assert.ok(binding.riskPolicy, 'riskLevels must project into the risk table');
    await exec.dispose();
  });

  it('AgentVersion 的 toolPolicy 真的到达策略装配（不再只在有 bundle 时才算）', async () => {
    // 2026-08-31（计划 H8）：这条以前叫「没有 bundle 就省掉 toolPolicyBinding，
    // 让工厂的 fail-closed 守卫开火」。两个前提都不成立了：
    //   1) 整段租户层策略算在 `if (extensionBundleFactory)` 里面，也就是只有
    //      测试注入 bundle 时才会算——生产里 AgentVersion 的 toolPolicy 算都不算。
    // 也就是说旧断言守的是「一个不会开火的守卫」加「一段生产不会执行的代码」。
    //
    // 现在断言的是 ADR 0009 D3 真正要的那件事：租户层策略到达按 Run 的风险解析
    // 函数，并且**只能收紧**。
    state.tables.agent_versions[0].config_json = JSON.stringify({
      toolPolicy: { tools: { bash: 'deny' }, riskLevels: { bash: 'critical' } },
    });
    /** @type {object[]} */
    const createInputs = [];
    const exec = makeExecutor();
    exec.piRuntimeFactory = {
      async create(input) {
        createInputs.push(input);
        return createFakePiRuntimeFactory().create(input);
      },
    };
    await exec.execute({
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
    assert.equal(createInputs.length, 1);
    assert.notEqual(
      createInputs[0].toolPolicyBinding,
      undefined,
      'configJson.toolPolicy 非空时必须给出绑定',
    );
    assert.equal(
      typeof createInputs[0].riskOverrides,
      'function',
      '风险解析函数必须按 Run 传给运行时——传扁平 map 表达不了 mcp__x__* 这类前缀规则',
    );
    assert.equal(
      createInputs[0].riskOverrides('bash'),
      'critical',
      '租户层配的风险等级必须真的生效；只算不用正是 2026-08-31 之前的病',
    );
    await exec.dispose();
  });

  it('fails closed on invalid acquired fence before extension/runtime', async () => {
    const generateId = nextId;
    let runtimeCalled = 0;
    const generateIdFn = generateId;
    const baseCreateRepos = (db) =>
      createRepositoryBundle(db, {
        now: () => new Date(),
        generateId: generateIdFn,
      });
    const exec = new DshRunExecutor({
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
      '../../src/application/session-json-codec.js'
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
      '../../src/infrastructure/mysql/repositories/session-journal-repository.js'
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
    const exec = new DshRunExecutor({
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
    const exec2 = new DshRunExecutor({
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
    // The run.agent_version fingerprint event commits in its own transaction
    // before the prompt loop, so it legitimately emits even when the later
    // message.completed batch rolls back. Only the rolled-back batch's events
    // must be absent from the external emit log.
    assert.ok(
      !emitLog2.includes('message.completed'),
      'rolled-back message.completed must not be emitted',
    );
    // Still the load-bearing half: the rolled-back batch must not survive in
    // the durable table either. Only the emit-count assertion had to relax.
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
    const exec = new DshRunExecutor({
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
    const exec = new DshRunExecutor({
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
    const broken = new DshRunExecutor({
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
    const exec = new DshRunExecutor({
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

  it('createDshRunExecutorFactory requires resolvers and is not auto-default', () => {
    assert.throws(
      () => createDshRunExecutorFactory({}),
      /modelResolver/,
    );
    assert.throws(
      () =>
        createDshRunExecutorFactory({
          modelResolver: () => fullModel,
        }),
      /workspaceResolver/,
    );
  });

  it('requires sessionLockManager.acquire at construction', () => {
    assert.throws(
      () =>
        new DshRunExecutor({
          transactionManager: { run: async (fn) => fn({}) },
          createRepositories: () => ({}),
          sessionLockManager: {},
          piRuntimeFactory: { create: async () => ({}) },
          modelResolver: () => fullModel,
          workspaceResolver: () => '/tmp',
          generateId: () => '1',
        }),
      /DshRunExecutor requires sessionLockManager/,
    );
  });

  it('production modules do not assign agent.state.messages', async () => {
    const { readSource } = await import('../support/read-source.js');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const root = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src',
    );
    const files = [
      'application/dsh-run-executor.js',
      'application/session-recovery-service.js',
      'infrastructure/dsh/runtime-factory.js',
    ];
    for (const f of files) {
      const src = readSource(path.join(root, f));
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
