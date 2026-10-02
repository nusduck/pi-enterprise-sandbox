/**
 * HiAgent 委派：续聊绑定、`new_conversation`、失效重建、跨用户隔离
 * （docs/design/hiagent-remote-delegation.md H2/H3/H5）。
 *
 * 出站 HTTP 本身见 tests/a2a-client/hiagent-client.test.ts；这里用假客户端与
 * 内存绑定 store，只测编排。模型参数里永远没有远端会话 ID（H3）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executeRemoteDelegation } from '../../src/runtime/providers/delegate-to-remote-agent.js';
import { runWithRunServices } from '../../src/runtime/providers/run-services.js';
import { HiAgentError } from '../../src/runtime/providers/hiagent-client.js';
import { RemoteA2aError } from '../../src/runtime/providers/a2a-remote-client.js';
import type {
  HiAgentRemoteAgentEntry,
  RemoteAgentEntry,
} from '../../src/runtime/providers/a2a-remote-registry.js';
import {
  bindRemoteConversationBindings,
  buildRunServices,
  type RemoteConversationStore,
} from '../../src/application/durable-subagent-port.js';
import { withDelegationSection } from '../../src/application/delegation-prompt.js';

const ENTRY: HiAgentRemoteAgentEntry = {
  id: 'hi-helper',
  name: '火山助手',
  description: '通用问答',
  protocol: 'hiagent',
  baseUrl: 'https://hiagent.example/app/v1',
  authTokenRef: 'HIAGENT_APP_KEY',
  timeoutMs: 60_000,
};

const A2A_ENTRY: RemoteAgentEntry = {
  id: 'finance-bot',
  name: '财务助手',
  description: '报销与预算',
  protocol: 'a2a',
  cardUrl: 'https://finance.example/card.json',
  authTokenRef: 'A2A_FINANCE_TOKEN',
  timeoutMs: 60_000,
};

/** 按 (org, user, conversation, remote) 键控的内存 store：断言跨用户隔离用。 */
function memoryStore() {
  const rows = new Map<string, string>();
  const key = (i: { orgId: string; userId: string; conversationId: string; remoteAgentId: string }) =>
    `${i.orgId}/${i.userId}/${i.conversationId}/${i.remoteAgentId}`;
  const store: RemoteConversationStore = {
    get: async (i) => rows.get(key(i)) ?? null,
    set: async (i) => {
      rows.set(key(i), i.remoteConversationId);
    },
    clear: async (i) => {
      rows.delete(key(i));
    },
  };
  return { store, rows };
}

/** `failChat` 按全局 chat 计数决定哪一次抛错（首次建会话的 chat 也计数）。 */
function fakeHiAgent(opts: { failChat?: (chatIndex: number) => Error | null } = {}) {
  const calls = { creates: 0, chats: [] as Array<{ remoteConversationId: string; prompt: string }> };
  let seq = 0;
  let chatSeq = 0;
  return {
    calls,
    async createConversation() {
      calls.creates += 1;
      seq += 1;
      return `conv-${seq}`;
    },
    async chat(input: { remoteConversationId: string; prompt: string }) {
      chatSeq += 1;
      calls.chats.push({ remoteConversationId: input.remoteConversationId, prompt: input.prompt });
      const fail = opts.failChat?.(chatSeq);
      if (fail) throw fail;
      return { taskId: 'task-1', text: `answer:${input.prompt}` };
    },
  };
}

const sessionGone = () =>
  new HiAgentError('HIAGENT_FAILED', 'remote hi-helper ConversationNotFound: gone', 'ConversationNotFound');

function fakeA2a() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    async delegate(input: Record<string, unknown>) {
      calls.push(input);
      return { remoteAgent: 'finance-bot', taskId: 't-1', state: 'completed', text: 'ok', artifacts: [] };
    },
  };
}

const SPAWN = { spawn: async () => ({}), getStatuses: async () => [] };

function inRun<T>(
  store: RemoteConversationStore,
  scope: { orgId: string; userId: string; conversationId: string },
  remoteAgents: string[],
  fn: () => Promise<T>,
  opts: { withScope?: boolean } = {},
) {
  const services = buildRunServices({
    spawnPort: SPAWN,
    parentRunId: 'run-1',
    tenant: { orgId: scope.orgId, userId: scope.userId },
    delegation: { agents: [], remoteAgents },
    ...(opts.withScope === false ? {} : { remoteScope: scope }),
    remoteConversations: store,
  });
  return runWithRunServices(services, fn);
}

const SCOPE = { orgId: 'o', userId: 'u', conversationId: '01J0000000000000000000000H' };
const ARGS = { agent: 'hi-helper', description: 'ask', prompt: 'first question' };

describe('hiagent delegation continuity (H3)', () => {
  it('creates a remote conversation on first call and persists the binding', async () => {
    const { store, rows } = memoryStore();
    const hiagent = fakeHiAgent();
    const result = await inRun(store, SCOPE, ['hi-helper'], () =>
      executeRemoteDelegation({ registry: [ENTRY], client: fakeA2a(), hiagent }, ARGS));
    assert.equal(result.text, 'answer:first question');
    assert.equal(result.taskId, 'task-1');
    assert.equal(result.state, 'completed');
    assert.deepEqual(result.artifacts, []);
    assert.equal(hiagent.calls.creates, 1);
    assert.equal(rows.get(`o/u/${SCOPE.conversationId}/hi-helper`), 'conv-1');
  });

  it('reuses the binding on the second call in the same session', async () => {
    const { store } = memoryStore();
    const hiagent = fakeHiAgent();
    const deps = { registry: [ENTRY], client: fakeA2a(), hiagent };
    await inRun(store, SCOPE, ['hi-helper'], () => executeRemoteDelegation(deps, ARGS));
    const second = await inRun(store, SCOPE, ['hi-helper'], () =>
      executeRemoteDelegation(deps, { ...ARGS, prompt: 'follow-up' }));
    assert.equal(hiagent.calls.creates, 1);
    assert.deepEqual(hiagent.calls.chats.map((c) => c.remoteConversationId), ['conv-1', 'conv-1']);
    assert.equal(second.text, 'answer:follow-up');
  });

  it('starts a fresh conversation with new_conversation: true and replaces the binding', async () => {
    const { store, rows } = memoryStore();
    const hiagent = fakeHiAgent();
    const deps = { registry: [ENTRY], client: fakeA2a(), hiagent };
    await inRun(store, SCOPE, ['hi-helper'], () => executeRemoteDelegation(deps, ARGS));
    await inRun(store, SCOPE, ['hi-helper'], () =>
      executeRemoteDelegation(deps, { ...ARGS, new_conversation: true }));
    assert.equal(hiagent.calls.creates, 2);
    assert.equal(rows.get(`o/u/${SCOPE.conversationId}/hi-helper`), 'conv-2');
    assert.equal(hiagent.calls.chats[1]?.remoteConversationId, 'conv-2');
  });

  it('rebuilds once when the remote session is gone, then succeeds', async () => {
    const { store, rows } = memoryStore();
    // chat#1（首次）成功，chat#2（续聊）报会话失效 → 重建后 chat#3 成功。
    const hiagent = fakeHiAgent({ failChat: (i) => (i === 2 ? sessionGone() : null) });
    const deps = { registry: [ENTRY], client: fakeA2a(), hiagent };
    await inRun(store, SCOPE, ['hi-helper'], () => executeRemoteDelegation(deps, ARGS));
    const result = await inRun(store, SCOPE, ['hi-helper'], () =>
      executeRemoteDelegation(deps, { ...ARGS, prompt: 'again' }));
    assert.equal(result.text, 'answer:again');
    // 删绑定 → 新建 → 重试：create 共 2 次（首次 + 重建），chat 共 3 次。
    assert.equal(hiagent.calls.creates, 2);
    assert.equal(hiagent.calls.chats.length, 3);
    assert.equal(rows.get(`o/u/${SCOPE.conversationId}/hi-helper`), 'conv-2');
  });

  it('retries at most once when the rebuilt session is also invalid', async () => {
    const { store } = memoryStore();
    const hiagent = fakeHiAgent({ failChat: (i) => (i >= 2 ? sessionGone() : null) });
    const deps = { registry: [ENTRY], client: fakeA2a(), hiagent };
    await inRun(store, SCOPE, ['hi-helper'], () => executeRemoteDelegation(deps, ARGS));
    await assert.rejects(
      inRun(store, SCOPE, ['hi-helper'], () => executeRemoteDelegation(deps, { ...ARGS, prompt: 'again' })),
      (err: HiAgentError) => err.code === 'HIAGENT_FAILED',
    );
    assert.equal(hiagent.calls.creates, 2);
    assert.equal(hiagent.calls.chats.length, 3);
  });

  it('returns non-session errors directly without rebuilding', async () => {
    const { store } = memoryStore();
    const badQuery = new HiAgentError('HIAGENT_FAILED', 'remote hi-helper InvalidQuery: bad query', 'InvalidQuery');
    const hiagent = fakeHiAgent({ failChat: (i) => (i === 2 ? badQuery : null) });
    const deps = { registry: [ENTRY], client: fakeA2a(), hiagent };
    await inRun(store, SCOPE, ['hi-helper'], () => executeRemoteDelegation(deps, ARGS));
    await assert.rejects(
      inRun(store, SCOPE, ['hi-helper'], () => executeRemoteDelegation(deps, { ...ARGS, prompt: 'again' })),
      (err: HiAgentError) => err.code === 'HIAGENT_FAILED' && /InvalidQuery/.test(err.message),
    );
    assert.equal(hiagent.calls.creates, 1);
  });

  it('never sends the remote conversation id through model arguments', async () => {
    const { store } = memoryStore();
    const hiagent = fakeHiAgent();
    const deps = { registry: [ENTRY], client: fakeA2a(), hiagent };
    await inRun(store, SCOPE, ['hi-helper'], () => executeRemoteDelegation(deps, ARGS));
    // 即使模型在参数里塞远端会话 ID，也会被忽略：用的永远是服务端绑定。
    const result = await inRun(store, SCOPE, ['hi-helper'], () =>
      executeRemoteDelegation(deps, { ...ARGS, remote_conversation_id: 'conv-evil' }));
    assert.equal(result.text, 'answer:first question');
    assert.equal(hiagent.calls.creates, 1);
    assert.equal(hiagent.calls.chats[1]?.remoteConversationId, 'conv-1');
  });
});

describe('hiagent delegation isolation (H3)', () => {
  it('does not leak a binding across users on the same conversation', async () => {
    const { store, rows } = memoryStore();
    const hiagent = fakeHiAgent();
    const deps = { registry: [ENTRY], client: fakeA2a(), hiagent };
    await inRun(store, SCOPE, ['hi-helper'], () => executeRemoteDelegation(deps, ARGS));
    const other = { ...SCOPE, userId: 'intruder' };
    const result = await inRun(store, other, ['hi-helper'], () => executeRemoteDelegation(deps, ARGS));
    assert.equal(result.text, 'answer:first question');
    assert.equal(hiagent.calls.creates, 2);
    assert.equal(rows.get(`o/u/${SCOPE.conversationId}/hi-helper`), 'conv-1');
    assert.equal(rows.get(`o/intruder/${SCOPE.conversationId}/hi-helper`), 'conv-2');
  });

  it('bindRemoteConversationBindings always carries the assembled scope', async () => {
    const { store } = memoryStore();
    const bindings = bindRemoteConversationBindings(SCOPE, store);
    await bindings.setBinding('hi-helper', 'conv-9');
    assert.equal(await bindings.getBinding('hi-helper'), 'conv-9');
    await bindings.clearBinding('hi-helper');
    assert.equal(await bindings.getBinding('hi-helper'), null);
  });
});

describe('hiagent delegation fail-closed', () => {
  it('refuses without run scope or bindings', async () => {
    const { store } = memoryStore();
    const hiagent = fakeHiAgent();
    await assert.rejects(
      inRun(store, SCOPE, ['hi-helper'], () =>
        executeRemoteDelegation({ registry: [ENTRY], client: fakeA2a(), hiagent }, ARGS), { withScope: false }),
      (err: RemoteA2aError) => err.code === 'DELEGATION_CONTEXT_MISSING',
    );
    assert.equal(hiagent.calls.creates, 0);
  });

  it('refuses when the hiagent client is not wired', async () => {
    const { store } = memoryStore();
    await assert.rejects(
      inRun(store, SCOPE, ['hi-helper'], () =>
        executeRemoteDelegation({ registry: [ENTRY], client: fakeA2a() }, ARGS)),
      (err: RemoteA2aError) => err.code === 'DELEGATION_CONTEXT_MISSING',
    );
  });

  it('ignores new_conversation for a2a remotes', async () => {
    const { store } = memoryStore();
    const a2a = fakeA2a();
    const { runWithToolExecutionContext } = await import('../../src/runtime/providers/tool-execution-context.js');
    await inRun(store, SCOPE, ['finance-bot'], () =>
      runWithToolExecutionContext({ callId: 'call-1', toolName: 'delegate_to_remote_agent', args: {} }, () =>
        executeRemoteDelegation(
          { registry: [A2A_ENTRY], client: a2a },
          { agent: 'finance-bot', description: 'budget', prompt: 'Q?', new_conversation: true },
        )));
    assert.equal(a2a.calls.length, 1);
  });
});

describe('Delegation prompt marks continuing hiagent remotes', () => {
  async function promptFor(registry: Array<{ id: string; description: string; protocol?: string }>) {
    return withDelegationSection({
      lead: '',
      delegation: { agents: [], remoteAgents: registry.map((r) => r.id) },
      orgId: 'o',
      transactionManager: { run: async (fn) => fn({}) },
      createRepositories: () => ({}),
      remoteRegistry: registry,
    });
  }

  it('adds the new_conversation hint only for hiagent remotes', async () => {
    const prompt = await promptFor([
      { id: 'finance-bot', description: '报销', protocol: 'a2a' },
      { id: 'hi-helper', description: '问答', protocol: 'hiagent' },
    ]);
    assert.match(prompt, /hi-helper.*continue from the previous turn/);
    assert.match(prompt, /new_conversation: true/);
  });

  it('adds no hint when every remote is a2a', async () => {
    const prompt = await promptFor([{ id: 'finance-bot', description: '报销', protocol: 'a2a' }]);
    assert.equal(prompt.includes('new_conversation'), false);
  });
});
