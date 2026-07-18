/**
 * PiRuntimeFactory bindExtensions / noExtensions / dispose-on-fail (PR-06).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PiRuntimeFactory,
  PINNED_PI_SDK_VERSION,
  buildExtensionBindings,
} from '../../src/infrastructure/pi/pi-runtime-factory.js';
import { createEnterpriseExtensionBundle } from '../../src/extensions/index.js';

const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const RUN_CTX = {
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: SESS,
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
  traceId: 'b'.repeat(32),
  executionFenceToken: 3,
};

function fullModel(overrides = {}) {
  return {
    id: 'gpt-test',
    name: 'GPT Test',
    api: 'openai-completions',
    provider: 'test',
    baseUrl: 'https://example.test',
    reasoning: true,
    input: ['text'],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  };
}

describe('buildExtensionBindings', () => {
  it('defaults mode rpc with handlers', () => {
    const b = buildExtensionBindings({});
    assert.equal(b.mode, 'rpc');
    assert.equal(typeof b.abortHandler, 'function');
    assert.equal(typeof b.shutdownHandler, 'function');
    assert.equal(typeof b.onError, 'function');
  });
});

describe('PiRuntimeFactory bindExtensions', () => {
  it('calls bindExtensions exactly once and sets rebindSession', async () => {
    let bindCalls = 0;
    let rebindInstalled = false;
    /** @type {string[]} */
    const sessionStarts = [];
    const fakeSession = {
      bindExtensions: async (bindings) => {
        bindCalls += 1;
        assert.equal(bindings.mode, 'rpc');
        assert.equal(typeof bindings.abortHandler, 'function');
        // Simulate session_start emission as real SDK does
        sessionStarts.push('start');
      },
      abort: () => {},
    };
    let seenRlo = null;
    const factories = createEnterpriseExtensionBundle(RUN_CTX);

    const factory = new PiRuntimeFactory({
      agentDir: '/tmp/agent-dir',
      sessionAdapter: {
        createNew: async () => ({ sessionManager: {}, sessionDir: null }),
        dispose: async () => {},
      },
      loadSdk: async () => ({
        VERSION: PINNED_PI_SDK_VERSION,
        createAgentSessionServices: async (opts) => {
          seenRlo = opts.resourceLoaderOptions;
          return {
            diagnostics: [],
            resourceLoader: {
              getExtensions: () => ({ extensions: [], errors: [] }),
            },
          };
        },
        createAgentSessionFromServices: async () => ({ session: fakeSession }),
        createAgentSessionRuntime: async (createRuntime, opts) => {
          const built = await createRuntime({
            cwd: opts.cwd,
            agentDir: opts.agentDir,
            sessionManager: opts.sessionManager,
          });
          return {
            session: built.session,
            services: built.services,
            setRebindSession(fn) {
              rebindInstalled = typeof fn === 'function';
              this._rebind = fn;
            },
            dispose: async () => {},
          };
        },
      }),
    });

    const managed = await factory.create({
      agentDir: '/tmp/agent-dir',
      agentVersion: {
        agentVersionId: VER,
        piSdkVersion: PINNED_PI_SDK_VERSION,
        configJson: {
          extensions: [
            'sandbox-bridge',
            'enterprise-policy',
            'observability',
          ],
        },
      },
      model: fullModel(),
      agentSession: { agentSessionId: SESS },
      cwd: '/ws',
      sessionManager: {},
      extensionFactories: factories,
    });

    assert.equal(bindCalls, 1);
    assert.equal(managed.bindCount, 1);
    assert.equal(rebindInstalled, true);
    assert.equal(seenRlo.noExtensions, true);
    assert.equal(seenRlo.extensionFactories.length, 3);
    await managed.dispose();
  });

  it('disposes runtime when bindExtensions fails', async () => {
    let disposed = 0;
    const factory = new PiRuntimeFactory({
      agentDir: '/tmp/agent-dir',
      sessionAdapter: {
        createNew: async () => ({ sessionManager: {}, sessionDir: '/owned' }),
        dispose: async () => {},
      },
      loadSdk: async () => ({
        VERSION: PINNED_PI_SDK_VERSION,
        createAgentSessionServices: async () => ({
          diagnostics: [],
          resourceLoader: {
            getExtensions: () => ({ extensions: [], errors: [] }),
          },
        }),
        createAgentSessionFromServices: async () => ({
          session: {
            bindExtensions: async () => {
              throw new Error('bind boom');
            },
          },
        }),
        createAgentSessionRuntime: async (createRuntime, opts) => {
          const built = await createRuntime({
            cwd: opts.cwd,
            agentDir: opts.agentDir,
            sessionManager: opts.sessionManager,
          });
          return {
            session: built.session,
            services: built.services,
            dispose: async () => {
              disposed += 1;
            },
          };
        },
      }),
    });

    await assert.rejects(
      () =>
        factory.create({
          agentDir: '/tmp/agent-dir',
          agentVersion: {
            agentVersionId: VER,
            piSdkVersion: PINNED_PI_SDK_VERSION,
            configJson: {
              extensions: [
                'sandbox-bridge',
                'enterprise-policy',
                'observability',
              ],
            },
          },
          model: fullModel(),
          agentSession: { agentSessionId: SESS },
          cwd: '/ws',
          sessionManager: {},
          extensionFactories: createEnterpriseExtensionBundle(RUN_CTX),
        }),
      /bind boom|PI_BIND/,
    );
    assert.equal(disposed, 1);
  });

  it('per-create extensionFactories do not leak across creates', async () => {
    /** @type {unknown[][]} */
    const seen = [];
    const factory = new PiRuntimeFactory({
      agentDir: '/tmp/agent-dir',
      sessionAdapter: {
        createNew: async () => ({ sessionManager: {}, sessionDir: null }),
        dispose: async () => {},
      },
      loadSdk: async () => ({
        VERSION: PINNED_PI_SDK_VERSION,
        createAgentSessionServices: async (opts) => {
          seen.push(opts.resourceLoaderOptions?.extensionFactories || []);
          return {
            diagnostics: [],
            resourceLoader: {
              getExtensions: () => ({ extensions: [], errors: [] }),
            },
          };
        },
        createAgentSessionFromServices: async () => ({
          session: {
            bindExtensions: async () => {},
          },
        }),
        createAgentSessionRuntime: async (createRuntime, opts) => {
          const built = await createRuntime({
            cwd: opts.cwd,
            agentDir: opts.agentDir,
            sessionManager: opts.sessionManager,
          });
          return {
            session: built.session,
            services: built.services,
            setRebindSession() {},
            dispose: async () => {},
          };
        },
      }),
    });

    const f1 = createEnterpriseExtensionBundle({
      ...RUN_CTX,
      runId: '01K0G2PAV8FPMVC9QHJG7JPN5A',
    });
    const f2 = createEnterpriseExtensionBundle({
      ...RUN_CTX,
      runId: '01K0G2PAV8FPMVC9QHJG7JPN5B',
    });

    await factory.create({
      agentDir: '/tmp/agent-dir',
      agentVersion: {
        agentVersionId: VER,
        piSdkVersion: PINNED_PI_SDK_VERSION,
        configJson: {
          extensions: [
            'sandbox-bridge',
            'enterprise-policy',
            'observability',
          ],
        },
      },
      model: fullModel(),
      agentSession: { agentSessionId: SESS },
      cwd: '/ws',
      sessionManager: {},
      extensionFactories: f1,
    });
    await factory.create({
      agentDir: '/tmp/agent-dir',
      agentVersion: {
        agentVersionId: VER,
        piSdkVersion: PINNED_PI_SDK_VERSION,
        configJson: {
          extensions: [
            'sandbox-bridge',
            'enterprise-policy',
            'observability',
          ],
        },
      },
      model: fullModel(),
      agentSession: { agentSessionId: SESS },
      cwd: '/ws',
      sessionManager: {},
      extensionFactories: f2,
    });

    assert.equal(seen.length, 2);
    assert.notEqual(seen[0][0], seen[1][0]);
  });
});
