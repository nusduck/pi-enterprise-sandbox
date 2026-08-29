/**
 * DshRuntimeFactory must boot remote providers and drive a DSH turn.
 * A stub that emits empty message_end without followup is not the production path.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExecRpcConfig,
  createDshRuntimeFactory,
} from '../../src/infrastructure/dsh/runtime-factory.js';

const HMAC = {
  SANDBOX_INTERNAL_HMAC_KEYRING: JSON.stringify({
    'dev-v1': Buffer.from('0'.repeat(32)).toString('base64url'),
  }),
  SANDBOX_INTERNAL_HMAC_ACTIVE_KID: 'dev-v1',
  SANDBOX_BASE_URL: 'http://exec.test',
};

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

describe('buildExecRpcConfig', () => {
  it('fails closed without HMAC material', () => {
    assert.throws(
      () => buildExecRpcConfig(baseInput(), {}),
      /SANDBOX_INTERNAL_HMAC/,
    );
  });

  it('takes tenant ids from the run context', () => {
    const rpc = buildExecRpcConfig(baseInput(), HMAC);
    assert.equal(rpc.orgId, 'org1');
    assert.equal(rpc.userId, 'user1');
    assert.equal(rpc.workspaceId, 'ws1');
    assert.equal(rpc.fenceToken, 3);
    assert.equal(rpc.baseUrl, 'http://exec.test');
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
        createSessionBackend() {
          return { name: 'mysql-memory', close: async () => {} };
        },
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

  it('rebinds boot remotes onto the run tenant before prompt', async () => {
    const rebound = [];
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
        createSessionBackend: () => ({ name: 'mem' }),
        assembleSystemPrompt: () => 'p',
      }),
      async createAgent() {
        return { agent: { followup() {}, async whenIdle() {}, session: { events: [] } } };
      },
    });
    await factory.create(baseInput());
    assert.equal(rebound.length, 3);
    assert.equal(rebound.every((r) => r.workspaceId === 'ws1'), true);
  });

  it('maps enterprise llmio provider onto the DSH deepseek-official route', async () => {
    let provider;
    const factory = createDshRuntimeFactory({
      env: HMAC,
      bootRuntime: async () => ({}),
      loadRuntime: async () => ({
        createRemoteProviders: () => ({ fs: {}, shell: {}, jobs: {} }),
        createSessionBackend: () => ({ name: 'mem' }),
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

  it('does not resolve prompt without calling followup (stub message_end is not enough)', async () => {
    let followupCalled = false;
    const factory = createDshRuntimeFactory({
      env: HMAC,
      bootRuntime: async () => ({}),
      loadRuntime: async () => ({
        createRemoteProviders: () => ({ fs: {}, shell: {}, jobs: {} }),
        createSessionBackend: () => ({ name: 'mem' }),
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
