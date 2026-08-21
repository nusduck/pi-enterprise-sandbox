/**
 * The Agent container's own filesystem must never be reachable from a Run.
 *
 * sandbox-bridge shadows Pi's `read`/`write`/`edit`/`bash` by registering tools
 * under the same names. `grep`/`find`/`ls` have no sandbox counterpart. Before
 * this suite they survived in the tool registry and stayed inactive only
 * because Pi's `defaultActiveToolNames` happens to list exactly the other four
 * — an implicit contract that a Pi upgrade could widen without any error, and
 * that an extension could defeat today via `pi.setActiveTools()`.
 *
 * These tests build a real AgentSession (no network: nothing is prompted) so
 * the guarantee is checked against the installed SDK rather than a fake.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuthStorage,
  SessionManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from '@earendil-works/pi-coding-agent';
import {
  LOCAL_FILESYSTEM_TOOL_NAMES,
  PiRuntimeFactory,
  bindAgentVersionConfig,
  resolveAgentVersionBindings,
} from '../../src/infrastructure/pi/pi-runtime-factory.js';

const VER = '01K0G2PAV8FPMVC9QHJG7JPN5E';

const model = Object.freeze({
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
});

describe('local filesystem tools are excluded from every Run', () => {
  /** @type {string} */ let cwd;
  /** @type {string} */ let agentDir;
  /** @type {object[]} */ const sessions = [];

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pi-excl-cwd-'));
    agentDir = mkdtempSync(join(tmpdir(), 'pi-excl-agent-'));
  });

  after(() => {
    for (const session of sessions) {
      try {
        session.dispose();
      } catch {
        /* best-effort */
      }
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  /** @param {{ excludeTools?: string[] }} [opts] */
  async function buildSession(opts = {}) {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      authStorage: AuthStorage.inMemory({
        test: { type: 'api_key', key: 'not-used' },
      }),
      resourceLoaderOptions: { systemPrompt: 'test', noExtensions: true },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      model,
      ...(opts.excludeTools ? { excludeTools: opts.excludeTools } : {}),
    });
    sessions.push(session);
    return session;
  }

  it('resolveAgentVersionBindings always denies grep/find/ls', () => {
    const bound = bindAgentVersionConfig({
      agentVersionId: VER,
      piSdkVersion: '0.80.3',
      configJson: {},
    });
    const bindings = resolveAgentVersionBindings(bound, {});
    for (const name of LOCAL_FILESYSTEM_TOOL_NAMES) {
      assert.ok(
        bindings.excludeTools.includes(name),
        `${name} must be denied by default`,
      );
    }
  });

  it('callers may extend the denylist but never shorten it', () => {
    const bound = bindAgentVersionConfig({
      agentVersionId: VER,
      piSdkVersion: '0.80.3',
      configJson: {},
    });
    const bindings = resolveAgentVersionBindings(bound, {
      excludeTools: ['some_other_tool'],
    });
    assert.ok(bindings.excludeTools.includes('some_other_tool'));
    for (const name of LOCAL_FILESYSTEM_TOOL_NAMES) {
      assert.ok(bindings.excludeTools.includes(name));
    }
  });

  it('the extension point is reachable from PiRuntimeFactory.create', async () => {
    // Regression: the merge branch existed but no caller could reach it —
    // create() built its bindings options without forwarding excludeTools, so
    // the "callers may extend" contract above was untestable in practice.
    /** @type {object | null} */
    let seenOpts = null;
    const factory = new PiRuntimeFactory({
      agentDir: '/tmp/agent-dir',
      excludeTools: ['from_constructor'],
      loadSdk: async () => ({ VERSION: '0.80.3' }),
      createServices: async () => ({ settingsManager: null, diagnostics: [] }),
      createFromServices: async (opts) => {
        seenOpts = opts;
        return { session: { bindExtensions() {} } };
      },
      createRuntime: async (create, opts) => {
        const built = await create(opts);
        return { ...built, services: {}, cwd: opts.cwd };
      },
      sessionAdapter: {
        async createNew() {
          return { sessionManager: {}, sessionDir: null };
        },
        async dispose() {},
      },
    });

    await factory.create({
      agentVersion: { agentVersionId: VER, configJson: {} },
      agentSession: { agentSessionId: VER },
      cwd: '/workspace',
      model: {
        id: 'm',
        name: 'M',
        api: 'openai-completions',
        provider: 'test',
        baseUrl: '',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 100,
      },
      excludeTools: ['from_call'],
    });

    assert.ok(seenOpts, 'createFromServices must have been reached');
    for (const name of [...LOCAL_FILESYSTEM_TOOL_NAMES, 'from_call']) {
      assert.ok(
        seenOpts.excludeTools.includes(name),
        `${name} must reach createAgentSessionFromServices`,
      );
    }
    assert.ok(
      !seenOpts.excludeTools.includes('from_constructor'),
      'a per-call list replaces the constructor default',
    );
  });

  it('without excludeTools the SDK keeps them reachable in the registry', async () => {
    // Documents exactly what the fix removes. If this ever starts failing
    // because Pi dropped the tools entirely, the exclusion becomes redundant
    // rather than wrong — but the next assertion is what protects the boundary.
    const session = await buildSession();
    const registry = session.getAllTools().map((tool) => tool.name);
    assert.deepEqual(
      LOCAL_FILESYSTEM_TOOL_NAMES.filter((name) => registry.includes(name)),
      [...LOCAL_FILESYSTEM_TOOL_NAMES],
      'baseline: the SDK registers local grep/find/ls',
    );
  });

  it('with excludeTools they are absent from the registry, not merely inactive', async () => {
    const session = await buildSession({
      excludeTools: [...LOCAL_FILESYSTEM_TOOL_NAMES],
    });
    const registry = session.getAllTools().map((tool) => tool.name);
    const active = session.getActiveToolNames();

    for (const name of LOCAL_FILESYSTEM_TOOL_NAMES) {
      assert.ok(!registry.includes(name), `${name} must not be registered`);
      assert.ok(!active.includes(name), `${name} must not be active`);
    }
    // Inactive is not enough: setActiveToolsByName / pi.setActiveTools() can
    // promote anything still in the registry.
    session.setActiveToolsByName([...LOCAL_FILESYSTEM_TOOL_NAMES]);
    assert.deepEqual(
      session.getActiveToolNames().filter((name) =>
        LOCAL_FILESYSTEM_TOOL_NAMES.includes(name),
      ),
      [],
      'an excluded tool must not be promotable back into the active set',
    );
  });

  it('the four sandbox-shadowed names stay available', async () => {
    // Removing grep/find/ls must not disturb the tools sandbox-bridge overrides.
    const session = await buildSession({
      excludeTools: [...LOCAL_FILESYSTEM_TOOL_NAMES],
    });
    const active = session.getActiveToolNames().sort();
    assert.deepEqual(active, ['bash', 'edit', 'read', 'write']);
  });
});
