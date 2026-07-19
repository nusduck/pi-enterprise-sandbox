import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PiRunExecutor } from '../../src/application/pi-run-executor.js';
import { PINNED_PI_SDK_VERSION } from '../../src/infrastructure/pi/pi-runtime-factory.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const VERSION = '01K0G2PAV8FPMVC9QHJG7JPN54';
const TOOL = '01K0G2PAV8FPMVC9QHJG7JPN56';
const INTERACTION = '01K0G2PAV8FPMVC9QHJG7JPN57';
const TRACE = 'e'.repeat(32);
const SCOPE = { orgId: ORG, userId: USER };

const MODEL = {
  id: 'test-model',
  name: 'Test',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: 'http://localhost',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

function makeRuntimeFactory(observed) {
  return {
    async create(input) {
      const entries = [
        {
          type: 'message',
          id: 'tool-result-before-answer',
          parentId: 'tool-call-parent',
          timestamp: '2026-07-19T01:00:00.000Z',
          message: {
            role: 'toolResult',
            toolCallId: 'ask-user-1',
            toolName: 'ask_user',
            content: [{ type: 'text', text: 'Waiting for user input' }],
            details: { pending: true },
            isError: false,
          },
        },
      ];
      const messages = [structuredClone(entries[0].message)];
      let branchParent = null;
      const sessionManager = {
        getHeader: () => ({
          type: 'session',
          version: 3,
          id: SESSION,
          timestamp: '2026-07-19T01:00:00.000Z',
          cwd: '/workspace/test',
        }),
        getEntries: () => [...entries],
        getCwd: () => '/workspace/test',
        getSessionId: () => SESSION,
        branch(parentId) {
          branchParent = parentId;
          observed.branches.push(parentId);
        },
        appendMessage(message) {
          messages.push(structuredClone(message));
          entries.push({
            type: 'message',
            id: `tool-result-answer-${entries.length}`,
            parentId: branchParent,
            timestamp: '2026-07-19T01:00:01.000Z',
            message: structuredClone(message),
          });
        },
      };
      let aborted = false;
      const session = {
        agent: { state: { messages } },
        sessionManager,
        abort() {
          aborted = true;
        },
        async steer() {},
        async prompt(text, options) {
          observed.prompts.push({ text, options });
          assert.equal(aborted, false);
        },
      };
      observed.runtimeInput = input;
      observed.session = session;
      return {
        session,
        sessionManager,
        dispose: async () => {},
      };
    },
  };
}

function makeDeps(observed) {
  const generateId = createUlidGenerator({ now: () => 1_721_278_800_000 });
  const durableRun = {
    runId: RUN,
    orgId: ORG,
    userId: USER,
    conversationId: CONV,
    agentSessionId: SESSION,
    agentVersionId: VERSION,
    triggeringMessageId: '01K0G2PAV8FPMVC9QHJG7JPN55',
    status: RUN_STATUS.RUNNING,
    traceId: TRACE,
    traceState: null,
  };
  const durableInteraction = {
    interactionId: INTERACTION,
    orgId: ORG,
    userId: USER,
    runId: RUN,
    agentSessionId: SESSION,
    toolExecutionId: TOOL,
    toolCallId: 'ask-user-1',
    interactionType: 'input',
    status: 'RESOLVED',
    responseJson: 'yes, use the EU region',
    responseHash: 'f'.repeat(64),
  };
  const durableTool = {
    toolExecutionId: TOOL,
    runId: RUN,
    agentSessionId: SESSION,
    toolCallId: 'ask-user-1',
    toolName: 'ask_user',
    status: 'SUCCEEDED',
  };
  const session = {
    agentSessionId: SESSION,
    conversationId: CONV,
    agentVersionId: VERSION,
    sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN58',
    workspaceId: '01K0G2PAV8FPMVC9QHJG7JPN59',
    status: 'ACTIVE',
  };
  const agentVersion = {
    agentVersionId: VERSION,
    piSdkVersion: PINNED_PI_SDK_VERSION,
    configHash: 'a'.repeat(64),
  };
  const repos = {
    runs: {
      async requireById() {
        return durableRun;
      },
    },
    sessions: {
      async acquireExecutionFenceForRun() {
        return { fenceToken: 1, session };
      },
      async assertExecutionFence() {
        return session;
      },
    },
    catalog: {
      async getVersionById() {
        return agentVersion;
      },
    },
    interactions: {
      async getById() {
        return durableInteraction;
      },
    },
    toolExecutions: {
      async getById() {
        return durableTool;
      },
    },
    journal: {
      async getByEntryId() {
        return null;
      },
    },
    messages: {
      async append() {},
    },
    runEvents: {
      async append() {
        return {
          eventId: generateId(),
          sequenceNo: 1,
        };
      },
    },
    outbox: {
      async insert() {},
    },
  };
  return {
    transactionManager: {
      async run(fn) {
        return fn({});
      },
    },
    createRepositories: () => repos,
    sessionLockManager: {
      renewIntervalMs: 60_000,
      async acquire() {
        return true;
      },
      async renew() {
        return true;
      },
      async release() {
        return true;
      },
    },
    piRuntimeFactory: makeRuntimeFactory(observed),
    modelResolver: async () => MODEL,
    workspaceResolver: async () => '/workspace/test',
    generateId,
    now: () => new Date('2026-07-19T01:02:03.004Z'),
    sessionAdapter: {
      captureSnapshotPayload(manager) {
        return {
          header: manager.getHeader(),
          entries: manager.getEntries(),
        };
      },
    },
    recoveryService: {
      async recover() {
        return {
          source: 'empty',
          payload: null,
          checksum: null,
          snapshotVersion: 0,
          journalDigest: null,
        };
      },
      async checkpoint(input) {
        observed.checkpoint = input;
      },
    },
    agentDir: '/tmp/agent-dir',
    sessionLockRenewIntervalMs: 60_000,
  };
}

describe('PiRunExecutor interaction continuation', () => {
  it('replaces the parked ask_user result and continues without issuing the question again', async () => {
    const observed = { prompts: [], branches: [] };
    const executor = new PiRunExecutor(makeDeps(observed));
    const result = await executor.execute({
      run: {
        runId: RUN,
        interactionResume: {
          interactionId: INTERACTION,
          status: 'RESOLVED',
          interactionType: 'input',
          response: 'yes, use the EU region',
          responseHash: 'f'.repeat(64),
          toolExecutionId: TOOL,
          toolCallId: 'ask-user-1',
          toolName: 'ask_user',
        },
      },
      scope: SCOPE,
      workerId: 'worker-resume',
      signal: new AbortController().signal,
    });

    assert.equal(result.outcome, RUN_STATUS.SUCCEEDED);
    assert.equal(observed.prompts.length, 1);
    assert.match(observed.prompts[0].text, /interaction resolved/i);
    assert.match(observed.prompts[0].text, /do not ask the same question again/i);
    assert.equal(observed.prompts[0].text.includes('hello world'), false);
    assert.deepEqual(observed.branches, ['tool-call-parent']);
    const answered = observed.session.agent.state.messages.at(-1);
    assert.equal(answered.role, 'toolResult');
    assert.equal(answered.toolCallId, 'ask-user-1');
    assert.match(answered.content[0].text, /yes, use the EU region/);
    assert.equal(answered.isError, false);
    assert.match(
      observed.checkpoint.payload.entries.at(-1).message.content[0].text,
      /yes, use the EU region/,
    );
    await executor.dispose();
  });

  it('fails closed when the durable response hash no longer matches the worker resume context', async () => {
    const observed = { prompts: [], branches: [] };
    const deps = makeDeps(observed);
    const executor = new PiRunExecutor(deps);
    const result = await executor.execute({
      run: {
        runId: RUN,
        interactionResume: {
          interactionId: INTERACTION,
          status: 'RESOLVED',
          interactionType: 'input',
          response: 'tampered answer',
          responseHash: '0'.repeat(64),
          toolExecutionId: TOOL,
          toolCallId: 'ask-user-1',
          toolName: 'ask_user',
        },
      },
      scope: SCOPE,
      workerId: 'worker-tamper',
      signal: new AbortController().signal,
    });

    assert.equal(result.outcome, RUN_STATUS.FAILED);
    assert.match(result.statusReason, /response hash changed/i);
    assert.equal(observed.prompts.length, 0);
    await executor.dispose().catch(() => {});
  });
});
