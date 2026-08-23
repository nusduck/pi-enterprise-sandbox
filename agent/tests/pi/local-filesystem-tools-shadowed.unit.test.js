/**
 * The Agent container's own filesystem must never be reachable from a Run.
 *
 * sandbox-bridge shadows Pi's `read`/`write`/`edit`/`bash` — and, since it
 * grew workspace search, `ls`/`find`/`grep` too — by registering tools under
 * the same names. Those seven used to be split across two mechanisms: four
 * shadowed, three named in `excludeTools`. That denylist is applied by name to
 * extension tools as well, so it silently removed the sandbox replacements and
 * left the model with no workspace search while the capability manifest kept
 * advertising `ls`/`find`/`grep`.
 *
 * The boundary is now one rule for all seven: the built-in must be shadowed,
 * and a name that still resolves to the built-in fails the Run closed.
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
  SANDBOX_SHADOWED_TOOL_NAMES,
  PiRuntimeFactory,
  assertSandboxShadowedTools,
  bindAgentVersionConfig,
  findUnshadowedLocalTools,
  resolveAgentVersionBindings,
} from '../../src/infrastructure/pi/pi-runtime-factory.js';
import { SANDBOX_TOOL_NAMES } from '../../src/extensions/sandbox-bridge/constants.js';

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

/** Minimal session double: only getAllTools() matters to the shadow check. */
function sessionWithTools(entries) {
  return {
    getAllTools: () =>
      entries.map(([name, source]) => ({ name, sourceInfo: { source } })),
  };
}

/** A bridge-bound registry: every sandbox tool present, none of them builtin. */
function boundBridgeTools(overrides = {}) {
  return SANDBOX_TOOL_NAMES.map((name) => [
    name,
    overrides[name] ?? 'extension',
  ]);
}

describe('sandbox-shadowed tool names', () => {
  it('covers every local filesystem tool sandbox-bridge replaces', () => {
    for (const name of LOCAL_FILESYSTEM_TOOL_NAMES) {
      assert.ok(
        SANDBOX_TOOL_NAMES.includes(name),
        `${name} must have a sandbox replacement before it may be unshadowed`,
      );
      assert.ok(SANDBOX_SHADOWED_TOOL_NAMES.includes(name), name);
    }
    for (const name of ['read', 'write', 'edit', 'bash']) {
      assert.ok(SANDBOX_SHADOWED_TOOL_NAMES.includes(name), name);
    }
  });

  it('resolveAgentVersionBindings no longer denies grep/find/ls by name', () => {
    // Regression: denying them by name also denied the sandbox-bridge tools
    // registered under those names, which is how the model lost ls/find/grep.
    const bound = bindAgentVersionConfig({
      agentVersionId: VER,
      piSdkVersion: '0.80.3',
      configJson: {},
    });
    const bindings = resolveAgentVersionBindings(bound, {});
    for (const name of LOCAL_FILESYSTEM_TOOL_NAMES) {
      assert.ok(
        !bindings.excludeTools.includes(name),
        `${name} must not be excluded — sandbox-bridge registers it`,
      );
    }
  });

  it('still forwards caller-supplied denials', () => {
    const bound = bindAgentVersionConfig({
      agentVersionId: VER,
      piSdkVersion: '0.80.3',
      configJson: {},
    });
    const bindings = resolveAgentVersionBindings(bound, {
      excludeTools: ['some_other_tool'],
    });
    assert.deepEqual(bindings.excludeTools, ['some_other_tool']);
  });

  it('the extension point is reachable from PiRuntimeFactory.create', async () => {
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
      model,
      excludeTools: ['from_call'],
    });

    assert.ok(seenOpts, 'createFromServices must have been reached');
    assert.ok(seenOpts.excludeTools.includes('from_call'));
    assert.ok(
      !seenOpts.excludeTools.includes('from_constructor'),
      'a per-call list replaces the constructor default',
    );
  });
});

describe('findUnshadowedLocalTools', () => {
  it('accepts a bridge-bound session where every name is an extension tool', () => {
    assert.deepEqual(findUnshadowedLocalTools(sessionWithTools(boundBridgeTools())), []);
  });

  it('reports a shadowed name that fell back to the Pi built-in', () => {
    const session = sessionWithTools(boundBridgeTools({ ls: 'builtin', bash: 'builtin' }));
    assert.deepEqual(findUnshadowedLocalTools(session).sort(), ['bash', 'ls']);
    assert.throws(
      () => assertSandboxShadowedTools(session),
      /PI_LOCAL_TOOL_NOT_SHADOWED|not shadowed|built-in/i,
    );
  });

  it('stays quiet for a session sandbox-bridge never bound to', () => {
    // No marker tool → not an enterprise Run; the built-ins are all there is.
    const session = sessionWithTools([
      ['read', 'builtin'],
      ['ls', 'builtin'],
    ]);
    assert.deepEqual(findUnshadowedLocalTools(session), []);
    assertSandboxShadowedTools(session);
  });
});

describe('the installed SDK, with no extensions bound', () => {
  /** @type {string} */ let cwd;
  /** @type {string} */ let agentDir;
  /** @type {object[]} */ const sessions = [];

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pi-shadow-cwd-'));
    agentDir = mkdtempSync(join(tmpdir(), 'pi-shadow-agent-'));
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

  it('registers local grep/find/ls but leaves them inactive', async () => {
    // Baseline for the shadow rule: the built-ins exist, and only Pi's four
    // defaults are active. sandbox-bridge overwrites the registry entries by
    // name, so nothing here reaches a Run once the bundle is bound.
    const session = await buildSession();
    const registry = session.getAllTools().map((tool) => tool.name);
    assert.deepEqual(
      LOCAL_FILESYSTEM_TOOL_NAMES.filter((name) => registry.includes(name)),
      [...LOCAL_FILESYSTEM_TOOL_NAMES],
      'baseline: the SDK registers local grep/find/ls',
    );
    assert.deepEqual(session.getActiveToolNames().sort(), ['bash', 'edit', 'read', 'write']);
    for (const name of LOCAL_FILESYSTEM_TOOL_NAMES) {
      const tool = session.getAllTools().find((entry) => entry.name === name);
      assert.equal(tool.sourceInfo?.source, 'builtin', `${name} is a built-in here`);
    }
  });

  it('an explicit excludeTools list still removes them entirely', async () => {
    // The mechanism is intact; it is simply no longer applied to names that
    // sandbox-bridge owns.
    const session = await buildSession({
      excludeTools: [...LOCAL_FILESYSTEM_TOOL_NAMES],
    });
    const registry = session.getAllTools().map((tool) => tool.name);
    for (const name of LOCAL_FILESYSTEM_TOOL_NAMES) {
      assert.ok(!registry.includes(name), `${name} must not be registered`);
    }
    session.setActiveToolsByName([...LOCAL_FILESYSTEM_TOOL_NAMES]);
    assert.deepEqual(
      session
        .getActiveToolNames()
        .filter((name) => LOCAL_FILESYSTEM_TOOL_NAMES.includes(name)),
      [],
      'an excluded tool must not be promotable back into the active set',
    );
  });
});
