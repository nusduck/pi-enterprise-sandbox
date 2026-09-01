/**
 * DshRuntimeFactory must boot remote providers and drive a DSH turn.
 * A stub that emits empty message_end without followup is not the production path.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildExecRpcConfig,
  createDshRuntimeFactory,
  mapDshEventToPi,
} from '../../src/infrastructure/dsh/runtime-factory.js';
import { validateSnapshotPayload } from '../../src/application/session-json-codec.js';

const HMAC = {
  SANDBOX_INTERNAL_HMAC_KEYRING: JSON.stringify({
    'dev-v1': Buffer.from('0'.repeat(32)).toString('base64url'),
  }),
  SANDBOX_INTERNAL_HMAC_ACTIVE_KID: 'dev-v1',
  SANDBOX_BASE_URL: 'http://exec.test',
};

function freshPersistence() {
  return {
    bindOwner: () => () => {},
    has: async () => false,
    runAsOwner: (_owner, fn) => fn(),
  };
}

function assistantEvent(turn, step, text) {
  return {
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  };
}

function factoryEmitting(events, { recovered } = {}) {
  const factory = createDshRuntimeFactory({
    env: HMAC,
    bootRuntime: async () => ({}),
    loadRuntime: async () => ({
      createRemoteProviders: () => ({ fs: {}, shell: {}, jobs: {} }),
      mountSessionPersistence: () => freshPersistence(),
      assembleSystemPrompt: () => 'p',
      runWithExecRpc(_cfg, fn) {
        return fn();
      },
    }),
    async createAgent() {
      return {
        agent: {
          followup() {},
          async whenIdle() {
            this.session.events.push(...events);
          },
          session: { events: [] },
        },
      };
    },
  });
  return factory.create(baseInput(recovered ? { piSnapshot: { snapshotJson: recovered } } : {}));
}

function baseInput(overrides = {}) {
  return {
    model: { id: 'deepseek-v4-flash', provider: 'deepseek-official' },
    cwd: '/home/sandbox/workspace',
    physicalRoots: ['/var/sandbox/workspaces/w1'],
    systemPrompt: 'lead',
    agentSession: {
      agentSessionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      orgId: 'org1',
      userId: 'user1',
      workspaceId: 'ws1',
    },
    context: {
      orgId: 'org1',
      userId: 'user1',
      workspaceId: 'ws1',
      executionFenceToken: 3,
    },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, data: {} })),
    ...overrides,
  };
}

describe('mapDshEventToPi', () => {
  it('maps assistant/chunk text-delta to message_update', () => {
    const mapped = mapDshEventToPi({
      type: 'assistant/chunk',
      data: { turn: 1, step: 0, chunk: { type: 'text-delta', text: 'hello' } },
    });
    assert.deepEqual(mapped, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    });
  });

  it('maps assistant/message to message_end and ignores turn/end', () => {
    const mapped = mapDshEventToPi({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 0,
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      },
    });
    assert.equal(mapped.type, 'message_end');
    assert.equal(mapped.message.content[0].text, 'done');
    assert.equal(mapDshEventToPi({ type: 'turn/end', data: { turn: 1, reason: 'completed' } }), null);
  });
});

describe('buildExecRpcConfig', () => {
  it('fails closed without HMAC material', () => {
    assert.throws(
      () => buildExecRpcConfig(baseInput(), {}),
      /SANDBOX_INTERNAL_HMAC/,
    );
  });

  // 这条性质原本由 `infrastructure/run-scoped-sandbox-transport.unit.test.js`
  // 的 "fails closed without durable org/user (no anonymous Sandbox access)"
  // 守着。那份测试随旧 transport 一起删除，性质必须搬到存活的路径上——
  // 现在通往 exec 的唯一入口是 buildExecRpcConfig。
  it('fails closed without durable org/user/workspace (no anonymous exec access)', () => {
    for (const missing of ['orgId', 'userId', 'workspaceId']) {
      const input = baseInput();
      input.context = { ...input.context, [missing]: '' };
      input.agentSession = { ...input.agentSession, [missing]: '' };
      // workspaceId 还会回落到 cwd，一并清掉才能验到这条分支。
      if (missing === 'workspaceId') input.cwd = '';
      assert.throws(
        () => buildExecRpcConfig(input, HMAC),
        /orgId, userId, and workspaceId/,
        `missing ${missing} must fail closed`,
      );
    }
  });

  it('takes tenant ids from the run context', () => {
    const rpc = buildExecRpcConfig(baseInput(), HMAC);
    assert.equal(rpc.orgId, 'org1');
    assert.equal(rpc.userId, 'user1');
    assert.equal(rpc.workspaceId, 'ws1');
    assert.equal(rpc.fenceToken, 3);
    assert.equal(rpc.baseUrl, 'http://exec.test');
  });

  it('forwards sandboxSessionId so artifact submit is listed under the session the UI queries', () => {
    const input = baseInput();
    input.context = { ...input.context, sandboxSessionId: '01ARZ3NDEKTSV4RRFFQ69G5FAQ' };
    const rpc = buildExecRpcConfig(input, HMAC);
    assert.equal(rpc.sandboxSessionId, '01ARZ3NDEKTSV4RRFFQ69G5FAQ');
  });
});

describe('createDshRuntimeFactory.create', () => {
  it('calls createRemoteProviders and drives followup+whenIdle on prompt', async () => {
    const rpcCalls = [];
    const followups = [];
    const factory = createDshRuntimeFactory({
      env: HMAC,
      bootRuntime: async () => ({ tag: 'booted-ctx' }),
      loadRuntime: async () => ({
        createRemoteProviders(ctx, rpc) {
          rpcCalls.push({ ctx, rpc });
          return { fs: { kind: 'fs' }, shell: { kind: 'shell' }, jobs: { kind: 'jobs' } };
        },
        mountSessionPersistence: () => freshPersistence(),
        assembleSystemPrompt(lead) {
          return `assembled:${lead ?? ''}`;
        },
        runWithExecRpc(cfg, fn) {
          rpcCalls.push({ bound: true, workspaceId: cfg.workspaceId });
          return fn();
        },
      }),
      async createAgent(ctx, options) {
        assert.equal(ctx.tag, 'booted-ctx');
        assert.equal(options.meta.cwd, '/home/sandbox/workspace');
        return {
          agent: {
            id: options.sessionId,
            followup(message) {
              followups.push(message);
            },
            async whenIdle() {
              this._idle = true;
              this.session.events.push({
                type: 'message_end',
                message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
              });
            },
            cancel() {},
            steer(message) {
              followups.push({ steer: true, ...message });
            },
            session: { events: [] },
          },
          async dispose() {},
        };
      },
    });

    const runtime = await factory.create(baseInput());
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].rpc.orgId, 'org1');
    assert.equal(rpcCalls[0].rpc.workspaceId, 'ws1');
    assert.equal(runtime.session.providers.fs.kind, 'fs');
    assert.equal(runtime.session.providers.shell.kind, 'shell');
    assert.match(runtime.session.promptText, /assembled/);
    const header = runtime.sessionManager.getHeader();
    assert.equal(header.type, 'session');
    assert.equal(header.version, 3);
    assert.equal(typeof header.timestamp, 'string');
    assert.match(header.timestamp, /T/);

    const seen = [];
    runtime.session.subscribe((ev) => seen.push(ev));
    await runtime.session.prompt('hello world');
    assert.equal(rpcCalls.some((c) => c.bound === true && c.workspaceId === 'ws1'), true);
    assert.equal(followups.length, 1);
    assert.equal(followups[0].role, 'user');
    assert.equal(followups[0].content[0].text, 'hello world');
    await runtime.session.steer('nudge');
    assert.equal(followups.at(-1).steer, true);
    await runtime.dispose();
  });

  it('persists inline prompt images as DSH attachment references', async () => {
    const saved = [];
    let followed;
    const ref = {
      attachmentId: 'sha256:image-ref',
      mediaType: 'image/png',
      bytes: 5,
      width: 1,
      height: 1,
      name: 'icon.png',
    };
    const factory = createDshRuntimeFactory({
      env: HMAC,
      bootRuntime: async () => ({
        get(name) {
          if (name === 'attachments') {
            return {
              async saveImage(input) {
                saved.push(input);
                return ref;
              },
            };
          }
          return undefined;
        },
      }),
      loadRuntime: async () => ({
        createRemoteProviders: () => ({ fs: {}, shell: {}, jobs: {} }),
        mountSessionPersistence: () => freshPersistence(),
        assembleSystemPrompt: () => 'p',
        runWithExecRpc(_cfg, fn) {
          return fn();
        },
      }),
      async createAgent() {
        return {
          agent: {
            followup(message) {
              followed = message;
            },
            async whenIdle() {
              this.session.events.push({
                type: 'message_end',
                message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
              });
            },
            session: { events: [] },
          },
        };
      },
    });

    const runtime = await factory.create(baseInput());
    await runtime.session.prompt('describe', {
      images: [{
        type: 'image',
        data: Buffer.from('hello').toString('base64'),
        mimeType: 'image/png',
        name: 'icon.png',
      }],
    });

    assert.deepEqual(saved, [{
      data: Buffer.from('hello'),
      mediaType: 'image/png',
      name: 'icon.png',
    }]);
    assert.deepEqual(followed.content, [
      { type: 'text', text: 'describe' },
      { type: 'image', attachment: ref },
    ]);
    await runtime.dispose();
  });

  it('does not re-emit historical session events as this turn\'s assistant output', async () => {
    const factory = createDshRuntimeFactory({
      env: HMAC,
      bootRuntime: async () => ({}),
      loadRuntime: async () => ({
        createRemoteProviders: () => ({ fs: {}, shell: {}, jobs: {} }),
        mountSessionPersistence: () => freshPersistence(),
        assembleSystemPrompt: () => 'p',
        runWithExecRpc(_cfg, fn) {
          return fn();
        },
      }),
      async createAgent() {
        return {
          agent: {
            followup() {},
            async whenIdle() {
              this.session.events.push({
                type: 'assistant/message',
                data: {
                  turn: 2,
                  step: 0,
                  message: { role: 'assistant', content: [{ type: 'text', text: 'current' }] },
                },
              });
            },
            session: {
              events: [
                {
                  type: 'assistant/message',
                  data: {
                    turn: 1,
                    step: 0,
                    message: { role: 'assistant', content: [{ type: 'text', text: 'previous' }] },
                  },
                },
              ],
            },
          },
        };
      },
    });

    const runtime = await factory.create(baseInput());
    const seen = [];
    runtime.session.subscribe((ev) => seen.push(ev));
    await runtime.session.prompt('follow up');
    const texts = seen
      .filter((e) => e.type === 'message_end')
      .map((e) => e.message.content[0].text);
    assert.deepEqual(texts, ['current']);
    await runtime.dispose();
  });

  it('keeps the recovered journal header and entries across runtime rebuilds', async () => {
    const recovered = {
      header: {
        type: 'session',
        version: 3,
        id: baseInput().agentSession.agentSessionId,
        timestamp: '2026-07-18T00:00:00.000Z',
        cwd: '/home/sandbox/workspace',
      },
      entries: [{ type: 'custom', id: 'prior-entry', parentId: null }],
    };
    const factory = createDshRuntimeFactory({
      env: HMAC,
      bootRuntime: async () => ({}),
      loadRuntime: async () => ({
        createRemoteProviders: () => ({ fs: {}, shell: {}, jobs: {} }),
        mountSessionPersistence: () => freshPersistence(),
        assembleSystemPrompt: () => 'p',
      }),
      async createAgent() {
        return {
          agent: {
            followup() {},
            async whenIdle() {},
            session: { events: [] },
          },
        };
      },
    });

    const runtime = await factory.create(baseInput({
      piSnapshot: { snapshotJson: recovered },
    }));
    assert.deepEqual(runtime.sessionManager.getHeader(), recovered.header);
    assert.deepEqual(runtime.sessionManager.getEntries(), recovered.entries);
    await runtime.dispose();
  });

  it('records assistant journal entries with parentId null on an empty session', async () => {
    const runtime = await factoryEmitting([assistantEvent(1, 0, 'hello')]);
    await runtime.session.prompt('hi');
    const entries = runtime.sessionManager.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(entries[0], 'parentId'), true);
    assert.equal(entries[0].parentId, null);
    assert.equal(entries[0].id, 'dsh:assistant:1:0');
    assert.equal(typeof entries[0].timestamp, 'string');
    assert.match(entries[0].timestamp, /T/);
    // Same gate the run checkpoint uses; missing parentId/timestamp fails the Run.
    validateSnapshotPayload({
      header: runtime.sessionManager.getHeader(),
      entries,
    });
    await runtime.dispose();
  });

  it('chains parentId onto the recovered journal leaf and across turns in one prompt', async () => {
    const recovered = {
      header: {
        type: 'session',
        version: 3,
        id: baseInput().agentSession.agentSessionId,
        timestamp: '2026-07-18T00:00:00.000Z',
        cwd: '/home/sandbox/workspace',
      },
      entries: [{
        type: 'custom',
        id: 'prior-entry',
        parentId: null,
        timestamp: '2026-07-18T00:00:00.000Z',
      }],
    };
    const runtime = await factoryEmitting(
      [assistantEvent(2, 0, 'one'), assistantEvent(2, 1, 'two')],
      { recovered },
    );
    await runtime.session.prompt('follow up');
    const entries = runtime.sessionManager.getEntries();
    assert.equal(entries.length, 3);
    assert.equal(entries[1].parentId, 'prior-entry');
    assert.equal(entries[2].parentId, 'dsh:assistant:2:0');
    validateSnapshotPayload({
      header: runtime.sessionManager.getHeader(),
      entries,
    });
    await runtime.dispose();
  });

  it('mounts owner-scoped DSH persistence and resumes an existing session', async () => {
    const calls = [];
    let released = false;
    const persistence = {
      bindOwner(sessionId, owner) {
        calls.push({ kind: 'bind', sessionId, owner });
        return () => { released = true; };
      },
      async has(sessionId) {
        calls.push({ kind: 'has', sessionId });
        return true;
      },
      runAsOwner(_owner, fn) {
        return fn();
      },
    };
    const factory = createDshRuntimeFactory({
      env: HMAC,
      bootRuntime: async () => ({ tag: 'root' }),
      loadRuntime: async () => ({
        createRemoteProviders: () => ({ fs: {}, shell: {}, jobs: {} }),
        mountSessionPersistence(ctx, options) {
          calls.push({ kind: 'mount', ctx, options });
          return persistence;
        },
        assembleSystemPrompt: () => 'p',
      }),
      async createAgent() {
        assert.fail('persisted session must use resume, not create');
      },
      async resumeAgent(ctx, options) {
        calls.push({ kind: 'resume', ctx, options });
        return {
          agent: {
            id: options.resumeSessionId,
            followup() {},
            async whenIdle() {},
            session: { events: [] },
          },
          async dispose() {},
        };
      },
    });

    const runtime = await factory.create(baseInput());
    assert.equal(calls[0].kind, 'mount');
    assert.equal(calls[1].kind, 'bind');
    assert.deepEqual(calls[1].owner, { orgId: 'org1', userId: 'user1' });
    assert.equal(calls[2].kind, 'has');
    assert.equal(calls[3].kind, 'resume');
    assert.equal(calls[3].options.resumeSessionId, baseInput().agentSession.agentSessionId);
    await runtime.dispose();
    assert.equal(released, true);
  });

  it('does NOT rebind the shared remotes; the run tenant reaches RPC through the ALS', async () => {
    // 2026-08-31（ADR 0009 D3 / 计划 H3）：这条以前断言的是**相反**的行为
    // ——「每个 Run 对 provider 调一次 rebind」。那正是 ADR 明文禁止的写法：
    // `ensureCtx` 是全进程 bootOnce，provider 是所有 Run 共用的一份实例，
    // 并发的第二个 Run 会把第一个 Run 的脱敏根换掉（A 的未分类错误按 B 的根
    // 脱敏 = A 的真实物理路径原样泄漏）。串台的复现见
    // tests/runtime/tenant-isolation.test.ts。
    const rebound = [];
    const alsScopes = [];
    const factory = createDshRuntimeFactory({
      env: HMAC,
      bootRuntime: async () => ({}),
      loadRuntime: async () => ({
        createRemoteProviders() {
          const bind = (name) => ({
            rebind(cfg) {
              rebound.push({ name, workspaceId: cfg.workspaceId });
            },
          });
          return { fs: bind('fs'), shell: bind('shell'), jobs: bind('jobs') };
        },
        mountSessionPersistence: () => freshPersistence(),
        assembleSystemPrompt: () => 'p',
        runWithExecRpc: (cfg, fn) => {
          alsScopes.push(cfg.workspaceId);
          return fn();
        },
      }),
      async createAgent() {
        return { agent: { followup() {}, async whenIdle() {}, session: { events: [] } } };
      },
    });
    const runtime = await factory.create(baseInput());
    assert.deepEqual(rebound, [], '共享 provider 不得被按 Run 改写');

    // 租户不是丢了，是换了通路：prompt 把整轮包在本 Run 的 ALS 作用域里。
    // 这个桩 agent 不产出任何事件，prompt 最后会抛「没有 assistant 输出」——
    // 与本条无关，我们只关心那之前 ALS 作用域是不是进对了。
    await runtime.session.prompt('hi').catch(() => undefined);
    assert.deepEqual(alsScopes, ['ws1'], '本 Run 的租户必须经 ALS 作用域传给 RPC');
  });

  it('maps enterprise llmio provider onto the DSH deepseek-official route', async () => {
    let provider;
    const factory = createDshRuntimeFactory({
      env: HMAC,
      bootRuntime: async () => ({}),
      loadRuntime: async () => ({
        createRemoteProviders: () => ({ fs: {}, shell: {}, jobs: {} }),
        mountSessionPersistence: () => freshPersistence(),
        assembleSystemPrompt: () => 'p',
      }),
      async createAgent(_ctx, options) {
        provider = options.agentOptions.provider;
        return {
          agent: {
            followup() {},
            async whenIdle() {},
            session: { events: [] },
          },
        };
      },
    });
    await factory.create(baseInput({
      model: { id: 'deepseek-v4-flash', provider: 'llmio' },
    }));
    assert.equal(provider, 'deepseek-official');
  });

  it('waits for scoped system skill registration before publishing an agent', async () => {
    let registered = false;
    let provider;
    const skillRoot = await mkdtemp(path.join(tmpdir(), 'dsh-system-skill-'));
    await mkdir(path.join(skillRoot, 'docx'));
    await writeFile(
      path.join(skillRoot, 'docx', 'SKILL.md'),
      '---\nname: docx\ndescription: test document skill\n---\n\nDOCX skill body\n',
    );
    const makeFiber = (callback) => {
      let resolve;
      const ready = new Promise((r) => { resolve = r; });
      const fiber = () => undefined;
      fiber.then = (onFulfilled, onRejected) => ready.then(onFulfilled, onRejected);
      setTimeout(() => {
        callback();
        resolve();
      }, 0);
      return fiber;
    };
    const bootCtx = { get: () => undefined };
    const agentCtx = {
      logger: { warn() {} },
      get(name) {
        if (name === 'fs') {
          return {
            resolve: async () => {
              throw new Error('remote workspace fs cannot resolve mounted skill roots');
            },
          };
        }
        return undefined;
      },
      on: () => () => undefined,
      inject(_names, callback) {
        return makeFiber(() => callback({
          systemPrompt: { section() {} },
          tools: { guard() {} },
          skills: {
            registerProvider(create) {
              provider = create({ signal: new AbortController().signal, invalidate() {} });
              registered = true;
              return () => undefined;
            },
          },
        }));
      },
    };
    const factory = createDshRuntimeFactory({
      env: HMAC,
      bootRuntime: async () => bootCtx,
      loadRuntime: async () => ({
        createRemoteProviders: () => ({ fs: {}, shell: {}, jobs: {} }),
        mountSessionPersistence: () => freshPersistence(),
        assembleSystemPrompt: () => 'p',
        runWithExecRpc(_cfg, fn) {
          return fn();
        },
      }),
      async createAgent(_ctx, options) {
        await options.setup(agentCtx);
        assert.equal(registered, true, 'setup must not resolve before the skill provider exists');
        return { agent: { followup() {}, async whenIdle() {}, session: { events: [] } } };
      },
    });
    try {
      const runtime = await factory.create(baseInput({ additionalSkillPaths: [skillRoot] }));
      assert.equal(registered, true, 'setup must not resolve before the skill provider exists');
      const listed = await provider.list({ cwd: '/home/sandbox/workspace' });
      const candidates = Array.isArray(listed) ? listed : listed.candidates;
      assert.equal(candidates[0]?.name, 'docx');
      const loaded = await provider.get(candidates[0], {});
      assert.equal(loaded?.content, 'DOCX skill body');
      await runtime.dispose();
    } finally {
      await rm(skillRoot, { recursive: true, force: true });
    }
  });

  it('does not resolve prompt without calling followup (stub message_end is not enough)', async () => {
    let followupCalled = false;
    const factory = createDshRuntimeFactory({
      env: HMAC,
      bootRuntime: async () => ({}),
      loadRuntime: async () => ({
        createRemoteProviders: () => ({ fs: {}, shell: {}, jobs: {} }),
        mountSessionPersistence: () => freshPersistence(),
        assembleSystemPrompt: () => 'p',
      }),
      async createAgent() {
        return {
          agent: {
            followup() {
              followupCalled = true;
            },
            async whenIdle() {
              this.session.events.push({
                type: 'message_end',
                message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
              });
            },
            cancel() {},
            session: { events: [] },
          },
        };
      },
    });
    const runtime = await factory.create(baseInput());
    await runtime.session.prompt('x');
    assert.equal(followupCalled, true);
  });
});
