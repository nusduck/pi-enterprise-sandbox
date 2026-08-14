/**
 * PiRuntimeFactory offline tests + static installed SDK export surface (PR-05).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PiRuntimeFactory,
  PINNED_PI_SDK_VERSION,
  assertModelShape,
  assertSdkVersionPinned,
  bindAgentVersionConfig,
  createSkillAllowlistOverride,
  resolveConcreteModel,
  resolveAgentVersionBindings,
} from '../../src/infrastructure/pi/pi-runtime-factory.js';
import { PiRuntimeFactoryError } from '../../src/infrastructure/pi/errors.js';
import { REQUIRED_EXTENSION_NAMES } from '../../src/extensions/index.js';

const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5C';

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

describe('assertModelShape / bindAgentVersionConfig', () => {
  it('requires full pi-ai Model fields including reasoning:boolean', () => {
    assert.doesNotThrow(() => assertModelShape(fullModel()));
    assert.throws(() => assertModelShape(null), PiRuntimeFactoryError);
    assert.throws(
      () => assertModelShape({ id: 'm', reasoning: true }),
      PiRuntimeFactoryError,
    );
    assert.throws(
      () => assertModelShape(fullModel({ reasoning: 'high' })),
      PiRuntimeFactoryError,
    );
    assert.throws(
      () => assertModelShape(fullModel({ output: ['text'] })),
      PiRuntimeFactoryError,
    );
  });

  it('binds immutable agent version config with exact pin', () => {
    const bound = bindAgentVersionConfig({
      agentVersionId: VER,
      piSdkVersion: '0.80.3',
      configJson: {
        systemPrompt: 'be helpful',
        modelPolicy: { model: fullModel({ reasoning: false }) },
        extensions: [
          'sandbox-bridge',
          'enterprise-policy',
          'observability',
        ],
      },
    });
    assert.equal(bound.agentVersionId, VER);
    assert.equal(bound.model.reasoning, false);
    assert.ok(Object.isFrozen(bound));
  });

  it('rejects non-exact piSdkVersion', () => {
    assert.throws(
      () =>
        bindAgentVersionConfig({
          agentVersionId: VER,
          piSdkVersion: '0.80.4',
          configJson: {},
        }),
      PiRuntimeFactoryError,
    );
  });
});

describe('assertSdkVersionPinned', () => {
  it('accepts exact pin and rejects mismatch', () => {
    assert.doesNotThrow(() =>
      assertSdkVersionPinned({ VERSION: PINNED_PI_SDK_VERSION }),
    );
    assert.throws(
      () => assertSdkVersionPinned({ VERSION: '0.80.4' }),
      (err) =>
        err instanceof PiRuntimeFactoryError &&
        err.code === 'PI_SDK_VERSION_MISMATCH',
    );
    assert.throws(
      () => assertSdkVersionPinned({}),
      (err) => err.code === 'PI_SDK_VERSION_MISMATCH',
    );
  });
});

describe('PiRuntimeFactory canonical create path', () => {
  it('uses createAgentSessionRuntime and createFromServices exactly once', async () => {
    let fromServicesCalls = 0;
    let runtimeCalls = 0;
    let servicesCalls = 0;
    const fakeSession = { dispose: async () => {} };
    const fakeSm = { getEntries: () => [] };

    const factory = new PiRuntimeFactory({
      agentDir: '/tmp/agent-dir',
      sessionAdapter: {
        createNew: async () => ({ sessionManager: fakeSm, sessionDir: '/t' }),
        dispose: async () => {},
      },
      loadSdk: async () => ({
        VERSION: PINNED_PI_SDK_VERSION,
        createAgentSessionServices: async () => {
          servicesCalls += 1;
          return {
            cwd: '/ws',
            agentDir: '/tmp/agent-dir',
            diagnostics: [],
          };
        },
        createAgentSessionFromServices: async () => {
          fromServicesCalls += 1;
          return { session: fakeSession };
        },
        createAgentSessionRuntime: async (createRuntime, opts) => {
          runtimeCalls += 1;
          const built = await createRuntime({
            cwd: opts.cwd,
            agentDir: opts.agentDir,
            sessionManager: opts.sessionManager,
          });
          return {
            session: built.session,
            services: built.services,
            cwd: opts.cwd,
            diagnostics: built.diagnostics,
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
        configJson: {},
      },
      model: fullModel(),
      agentSession: { agentSessionId: SESS },
      cwd: '/ws',
      sessionManager: fakeSm,
    });

    assert.equal(runtimeCalls, 1);
    assert.equal(fromServicesCalls, 1);
    assert.equal(servicesCalls, 1);
    assert.equal(managed.session, fakeSession);
    await managed.dispose();
    await managed.dispose(); // idempotent
  });

  it('injects request-scoped provider auth through SDK AuthStorage', async () => {
    let seenAuthStorage = null;
    let seededCredentials = null;
    const fakeSession = { dispose: async () => {} };
    const model = fullModel({ provider: 'llmio' });
    const factory = new PiRuntimeFactory({
      agentDir: '/tmp/agent-dir',
      sessionAdapter: {
        createNew: async () => ({ sessionManager: {}, sessionDir: null }),
        dispose: async () => {},
      },
      loadSdk: async () => ({
        VERSION: PINNED_PI_SDK_VERSION,
        AuthStorage: {
          inMemory(credentials) {
            seededCredentials = credentials;
            return { kind: 'request-auth' };
          },
        },
        createAgentSessionServices: async (opts) => {
          seenAuthStorage = opts.authStorage;
          return { diagnostics: [] };
        },
        createAgentSessionFromServices: async () => ({ session: fakeSession }),
        createAgentSessionRuntime: async (createRuntime, opts) => {
          const built = await createRuntime(opts);
          return {
            session: built.session,
            services: built.services,
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
        configJson: {},
      },
      model,
      requestAuth: { provider: 'llmio', apiKey: 'request-secret' },
      agentSession: { agentSessionId: SESS },
      cwd: '/ws',
      sessionManager: {},
    });

    assert.deepEqual(seededCredentials, {
      llmio: { type: 'api_key', key: 'request-secret' },
    });
    assert.deepEqual(seenAuthStorage, { kind: 'request-auth' });
    assert.equal(model.headers, undefined);
    await managed.dispose();
  });

  it('reuses injected services inside createRuntime (no direct bypass path)', async () => {
    let fromServicesCalls = 0;
    let runtimeCalls = 0;
    let servicesCalls = 0;
    const injected = {
      cwd: '/ws',
      agentDir: '/tmp/agent-dir',
      diagnostics: [],
      marker: 'injected',
    };
    const fakeSession = { dispose: async () => {} };

    const factory = new PiRuntimeFactory({
      agentDir: '/tmp/agent-dir',
      sessionAdapter: {
        createNew: async () => ({ sessionManager: {}, sessionDir: null }),
        dispose: async () => {},
      },
      loadSdk: async () => ({
        VERSION: PINNED_PI_SDK_VERSION,
        createAgentSessionServices: async () => {
          servicesCalls += 1;
          return { cwd: '/ws', agentDir: '/tmp/agent-dir', diagnostics: [] };
        },
        createAgentSessionFromServices: async (opts) => {
          fromServicesCalls += 1;
          assert.equal(opts.services.marker, 'injected');
          assert.ok(opts.model);
          return { session: fakeSession };
        },
        createAgentSessionRuntime: async (createRuntime, opts) => {
          runtimeCalls += 1;
          const built = await createRuntime({
            cwd: opts.cwd,
            agentDir: opts.agentDir,
            sessionManager: opts.sessionManager,
          });
          return {
            session: built.session,
            services: built.services,
            cwd: opts.cwd,
            diagnostics: [],
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
        configJson: {},
      },
      model: fullModel(),
      agentSession: { agentSessionId: SESS },
      cwd: '/ws',
      sessionManager: {},
      services: injected,
    });

    assert.equal(runtimeCalls, 1);
    assert.equal(fromServicesCalls, 1);
    assert.equal(servicesCalls, 0, 'injected services must skip createServices');
    assert.equal(managed.services.marker, 'injected');
  });

  it('requires concrete model (PI_MODEL_REQUIRED)', async () => {
    const factory = new PiRuntimeFactory({
      agentDir: '/tmp/agent-dir',
      loadSdk: async () => ({ VERSION: PINNED_PI_SDK_VERSION }),
    });
    await assert.rejects(
      () =>
        factory.create({
          agentDir: '/tmp/agent-dir',
          agentVersion: {
            agentVersionId: VER,
            piSdkVersion: '0.80.3',
            configJson: {},
          },
          agentSession: { agentSessionId: SESS },
          cwd: '/ws',
          sessionManager: {},
        }),
      (err) =>
        err instanceof PiRuntimeFactoryError && err.code === 'PI_MODEL_REQUIRED',
    );
  });

  it('fails closed on SDK VERSION mismatch', async () => {
    const factory = new PiRuntimeFactory({
      agentDir: '/tmp/agent-dir',
      sessionAdapter: {
        createNew: async () => ({ sessionManager: {}, sessionDir: null }),
        dispose: async () => {},
      },
      loadSdk: async () => ({
        VERSION: '0.79.0',
        createAgentSessionServices: async () => ({}),
        createAgentSessionFromServices: async () => ({ session: {} }),
        createAgentSessionRuntime: async () => ({ session: {} }),
      }),
    });
    await assert.rejects(
      () =>
        factory.create({
          agentDir: '/tmp/agent-dir',
          agentVersion: {
            agentVersionId: VER,
            piSdkVersion: '0.80.3',
            configJson: {},
          },
          model: fullModel(),
          agentSession: { agentSessionId: SESS },
          cwd: '/ws',
          sessionManager: {},
        }),
      (err) => err.code === 'PI_SDK_VERSION_MISMATCH',
    );
  });

  it('disposes invalid runtime object before cleanup', async () => {
    let disposed = 0;
    const factory = new PiRuntimeFactory({
      agentDir: '/tmp/agent-dir',
      sessionAdapter: {
        createNew: async () => ({ sessionManager: {}, sessionDir: '/owned' }),
        dispose: async () => {},
      },
      loadSdk: async () => ({
        VERSION: PINNED_PI_SDK_VERSION,
        createAgentSessionServices: async () => ({ diagnostics: [] }),
        createAgentSessionFromServices: async () => ({ session: { id: 's' } }),
        createAgentSessionRuntime: async (createRuntime, opts) => {
          await createRuntime({
            cwd: opts.cwd,
            agentDir: opts.agentDir,
            sessionManager: opts.sessionManager,
          });
          return {
            // invalid: no session
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
            piSdkVersion: '0.80.3',
            configJson: {},
          },
          model: fullModel(),
          agentSession: { agentSessionId: SESS },
          cwd: '/ws',
          sessionManager: {},
        }),
      (err) => err.code === 'PI_RUNTIME_CREATE_FAILED',
    );
    assert.equal(disposed, 1);
  });

  it('requires agentDir and cleans up on failure', async () => {
    let ownedDisposed = 0;
    const factory = new PiRuntimeFactory({
      sessionAdapter: {
        createNew: async () => ({ sessionManager: {}, sessionDir: '/owned' }),
        dispose: async () => {
          ownedDisposed += 1;
        },
      },
      loadSdk: async () => ({
        VERSION: PINNED_PI_SDK_VERSION,
        createAgentSessionServices: async () => ({}),
        createAgentSessionFromServices: async () => {
          throw new Error('boom');
        },
        createAgentSessionRuntime: async (createRuntime, opts) =>
          createRuntime({
            cwd: opts.cwd,
            agentDir: opts.agentDir,
            sessionManager: opts.sessionManager,
          }),
      }),
    });

    await assert.rejects(
      () =>
        factory.create({
          agentVersion: {
            agentVersionId: VER,
            piSdkVersion: '0.80.3',
            configJson: {},
          },
          model: fullModel(),
          agentSession: { agentSessionId: SESS },
          cwd: '/ws',
        }),
      /agentDir is required/,
    );

    await assert.rejects(
      () =>
        factory.create({
          agentDir: '/tmp/agent-dir',
          agentVersion: {
            agentVersionId: VER,
            piSdkVersion: '0.80.3',
            configJson: {},
          },
          model: fullModel(),
          agentSession: { agentSessionId: SESS },
          cwd: '/ws',
        }),
      /boom/,
    );
    assert.ok(ownedDisposed >= 1);
  });
});

describe('immutable AgentVersion model + bindings', () => {
  it('forbids input.model override when AgentVersion embeds full model', () => {
    const bound = bindAgentVersionConfig({
      agentVersionId: VER,
      piSdkVersion: '0.80.3',
      configJson: {
        modelPolicy: { model: fullModel({ id: 'pinned-model' }) },
      },
    });
    assert.equal(
      resolveConcreteModel(bound, fullModel({ id: 'pinned-model' })).id,
      'pinned-model',
    );
    assert.throws(
      () => resolveConcreteModel(bound, fullModel({ id: 'other-model' })),
      (err) => err.code === 'PI_MODEL_OVERRIDE_FORBIDDEN',
    );
  });

  it('validates logical modelPolicy constraints on resolved model', () => {
    const bound = bindAgentVersionConfig({
      agentVersionId: VER,
      piSdkVersion: '0.80.3',
      configJson: {
        modelPolicy: {
          provider: 'test',
          modelId: 'gpt-test',
          api: 'openai-completions',
        },
      },
    });
    assert.doesNotThrow(() =>
      resolveConcreteModel(bound, fullModel({ id: 'gpt-test' })),
    );
    assert.throws(
      () => resolveConcreteModel(bound, fullModel({ id: 'wrong', provider: 'test' })),
      (err) => err.code === 'PI_MODEL_POLICY_MISMATCH',
    );
  });

  it('fail-closes non-empty extensions/mcp without bindings', () => {
    const bound = bindAgentVersionConfig({
      agentVersionId: VER,
      piSdkVersion: '0.80.3',
      configJson: {
        extensions: [
          'sandbox-bridge',
          'enterprise-policy',
          'observability',
        ],
        skills: ['s1'],
        mcpServers: [{ name: 'db' }],
      },
    });
    assert.throws(
      () => resolveAgentVersionBindings(bound, {}),
      (err) => err.code === 'PI_BINDING_REQUIRED',
    );
    // Rejects incomplete extension set / wrong count
    assert.throws(
      () =>
        resolveAgentVersionBindings(
          bindAgentVersionConfig({
            agentVersionId: VER,
            piSdkVersion: '0.80.3',
            configJson: { extensions: ['sandbox-bridge'] },
          }),
          { extensionFactories: [() => {}] },
        ),
      (err) => err.code === 'PI_EXTENSIONS_INVALID',
    );
    // A factory count that does not match the resolved extension set fails closed.
    assert.throws(
      () =>
        resolveAgentVersionBindings(bound, {
          extensionFactories: [() => {}, () => {}, () => {}],
        }),
      (err) => err.code === 'PI_EXTENSIONS_COUNT',
    );
    // Anonymous factories (no extensionName) fail closed
    assert.throws(
      () =>
        resolveAgentVersionBindings(bound, {
          extensionFactories: REQUIRED_EXTENSION_NAMES.map(() => () => {}),
        }),
      (err) => err.code === 'PI_EXTENSIONS_NAME_MISMATCH',
    );
    const named = REQUIRED_EXTENSION_NAMES.map((name) => {
      const f = () => {};
      f.extensionName = name;
      return f;
    });
    // Named factories but missing skills/mcp bindings
    assert.throws(
      () =>
        resolveAgentVersionBindings(bound, {
          extensionFactories: named,
        }),
      (err) => err.code === 'PI_BINDING_REQUIRED',
    );
    // Wrong order
    const wrongOrder = [...named].reverse();
    assert.throws(
      () =>
        resolveAgentVersionBindings(bound, {
          extensionFactories: wrongOrder,
          skillsOverride: () => ({ skills: [], diagnostics: [] }),
          mcpResolver: () => ({}),
        }),
      (err) => err.code === 'PI_EXTENSIONS_NAME_MISMATCH',
    );
    const ok = resolveAgentVersionBindings(bound, {
      extensionFactories: named,
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      mcpResolver: () => ({}),
    });
    // Every runtime gets the enterprise path/tool prompt; this prevents Pi's
    // SDK default from advertising host/node_modules skill locations.
    assert.match(ok.resourceLoaderOptions.systemPrompt, /## Skills \(progressive disclosure\)/);
    assert.match(ok.resourceLoaderOptions.systemPrompt, /\/home\/sandbox\/skill/);
    assert.deepEqual(ok.additionalSkillPaths, ['/home/sandbox/skill']);
    assert.equal(ok.resourceLoaderOptions.noExtensions, true);
  });

  it('realises AgentVersion.skills as an allowlist without a caller binding', () => {
    // Regression: this field used to fail every Run with PI_BINDING_REQUIRED
    // because no caller ever built the skillsOverride it demanded.
    const bound = bindAgentVersionConfig({
      agentVersionId: VER,
      piSdkVersion: '0.80.3',
      configJson: { skills: ['pdf-report', 'sql-review'] },
    });
    const bindings = resolveAgentVersionBindings(bound, {});
    assert.equal(typeof bindings.skillsOverride, 'function');
    assert.equal(
      typeof bindings.resourceLoaderOptions.skillsOverride,
      'function',
      'the override must reach the Pi ResourceLoader',
    );

    const filtered = bindings.skillsOverride({
      skills: [
        { name: 'pdf-report', description: 'a' },
        { name: 'sql-review', description: 'b' },
        { name: 'not-listed', description: 'c' },
      ],
      diagnostics: [],
    });
    assert.deepEqual(
      filtered.skills.map((s) => s.name),
      ['pdf-report', 'sql-review'],
    );
    assert.equal(filtered.diagnostics.length, 0);
  });

  it('warns rather than fails when an allowlisted skill is not installed', () => {
    const override = createSkillAllowlistOverride(['present', 'missing']);
    const out = override({
      skills: [{ name: 'present', description: 'a' }],
      diagnostics: [{ type: 'warning', message: 'pre-existing' }],
    });
    assert.deepEqual(out.skills.map((s) => s.name), ['present']);
    assert.equal(out.diagnostics.length, 2, 'pre-existing diagnostics survive');
    assert.match(out.diagnostics[1].message, /missing/);
    assert.equal(out.diagnostics[1].type, 'warning');
  });

  it('reports sandboxPolicy as unsupported, not as a missing binding', () => {
    // The distinction is what an operator acts on: nothing in this build can
    // enforce per-AgentVersion sandbox limits, so "wire a binding" would be
    // the wrong instruction.
    const bound = bindAgentVersionConfig({
      agentVersionId: VER,
      piSdkVersion: '0.80.3',
      configJson: { sandboxPolicy: { networkEgress: false } },
    });
    assert.throws(
      () => resolveAgentVersionBindings(bound, {}),
      (err) =>
        err.code === 'PI_FEATURE_NOT_ENABLED' &&
        /SANDBOX_\*/.test(err.message),
    );
    // Unconditional: the message asserts nothing enforces the field, so no
    // caller-supplied value may wave it through.
    assert.throws(
      () =>
        resolveAgentVersionBindings(bound, {
          sandboxPolicyBinding: { pretendItIsEnforced: true },
        }),
      (err) => err.code === 'PI_FEATURE_NOT_ENABLED',
    );
  });

  it('rejects a non-object toolPolicy instead of blaming a missing binding', () => {
    // `typeof [] === 'object'` used to let an array through as {0: 'bash'},
    // which the projection read as empty — so the Run died at
    // PI_BINDING_REQUIRED and never named the malformed config.
    for (const toolPolicy of [['bash'], 'deny', 42]) {
      assert.throws(
        () =>
          bindAgentVersionConfig({
            agentVersionId: VER,
            piSdkVersion: '0.80.3',
            configJson: { toolPolicy },
          }),
        (err) => err.code === 'PI_TOOL_POLICY_INVALID',
        `toolPolicy: ${JSON.stringify(toolPolicy)}`,
      );
    }
  });

  it('uses the enterprise prompt when AgentVersion systemPrompt is empty', () => {
    const bound = bindAgentVersionConfig({
      agentVersionId: VER,
      piSdkVersion: '0.80.3',
      configJson: { systemPrompt: '' },
    });
    // Explicit empty product layer so this test is env-independent
    // (AGENT_SYSTEM_PROMPT may be set in local .env).
    const ok = resolveAgentVersionBindings(bound, { productSystemPrompt: '' });
    assert.match(ok.systemPrompt, /enterprise coding assistant/);
    assert.doesNotMatch(ok.systemPrompt, /^You are a helpful/);
    assert.equal(ok.resourceLoaderOptions.systemPrompt, ok.systemPrompt);
    assert.ok(Object.prototype.hasOwnProperty.call(ok.resourceLoaderOptions, 'systemPrompt'));
  });

  it('applies productSystemPrompt when AgentVersion systemPrompt is empty', () => {
    const bound = bindAgentVersionConfig({
      agentVersionId: VER,
      piSdkVersion: '0.80.3',
      configJson: { systemPrompt: '' },
    });
    const ok = resolveAgentVersionBindings(bound, {
      productSystemPrompt: 'You are Acme Corp enterprise assistant.',
    });
    assert.match(ok.systemPrompt, /^You are Acme Corp enterprise assistant\./);
    assert.match(ok.systemPrompt, /enterprise coding assistant/);
    assert.match(ok.systemPrompt, /---/);
  });

  it('AgentVersion systemPrompt wins over productSystemPrompt', () => {
    const bound = bindAgentVersionConfig({
      agentVersionId: VER,
      piSdkVersion: '0.80.3',
      configJson: { systemPrompt: 'Version-owned voice' },
    });
    const ok = resolveAgentVersionBindings(bound, {
      productSystemPrompt: 'Env product voice must not lead',
    });
    assert.match(ok.systemPrompt, /^Version-owned voice/);
    assert.doesNotMatch(ok.systemPrompt, /Env product voice must not lead/);
  });

  it('passes systemPrompt via resourceLoaderOptions and uses session agentVersionId only', async () => {
    let seenRlo = null;
    let seenModel = null;
    const pinned = fullModel({ id: 'session-pinned' });
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
          return { diagnostics: [] };
        },
        createAgentSessionFromServices: async (opts) => {
          seenModel = opts.model;
          return { session: { dispose: async () => {} } };
        },
        createAgentSessionRuntime: async (createRuntime, opts) => {
          const built = await createRuntime({
            cwd: opts.cwd,
            agentDir: opts.agentDir,
            sessionManager: opts.sessionManager,
          });
          return {
            session: built.session,
            services: built.services,
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
        configHash: 'c'.repeat(64),
        configJson: {
          systemPrompt: 'immutable system',
          modelPolicy: { model: pinned },
        },
      },
      // Attempt different model → fail; same identity ok
      model: pinned,
      agentSession: { agentSessionId: SESS },
      cwd: '/ws',
      sessionManager: {},
    });
    assert.ok(seenRlo.systemPrompt.startsWith('immutable system\n\n---\n\n'));
    assert.match(seenRlo.systemPrompt, /## Skills \(progressive disclosure\)/);
    assert.equal(seenModel.id, 'session-pinned');
    assert.equal(managed.agentVersionId, VER);
    assert.equal(managed.bound.configHash, 'c'.repeat(64));
    await managed.dispose();
  });
});

describe('installed package public exports (static, no network)', () => {
  it('exposes required root APIs from @earendil-works/pi-coding-agent@0.80.3', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent');
    assert.equal(typeof sdk.SessionManager.open, 'function');
    assert.equal(typeof sdk.createAgentSessionRuntime, 'function');
    assert.equal(typeof sdk.createAgentSessionFromServices, 'function');
    assert.equal(typeof sdk.createAgentSessionServices, 'function');
    assert.equal(sdk.CURRENT_SESSION_VERSION, 3);
    assert.equal(sdk.VERSION, PINNED_PI_SDK_VERSION);
    assertSdkVersionPinned(sdk);
    assert.equal(typeof sdk.SessionManager.hydrate, 'undefined');
  });
});
