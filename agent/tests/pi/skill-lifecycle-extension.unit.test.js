/**
 * skill-lifecycle registers the skill tools that SKILLS_MODE=development has
 * always been documented to provide, and only then.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createEnterpriseExtensionBundle,
  createSkillLifecycleExtension,
  extensionFactoryNames,
  REQUIRED_EXTENSION_NAMES,
  SKILL_LIFECYCLE_TOOL_NAMES,
} from '../../src/extensions/index.js';
import { classifyTool } from '../../src/extensions/enterprise-policy/tool-risk-classifier.js';
import { createPolicyEngine } from '../../src/extensions/enterprise-policy/policy-engine.js';

const RUN_CTX = Object.freeze({
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
  traceId: 'b'.repeat(32),
  executionFenceToken: 3,
});

/** Minimal SkillManager double. */
function fakeSkillManager(overrides = {}) {
  return {
    mode: 'enabled',
    identity: { orgId: RUN_CTX.orgId, userId: RUN_CTX.userId },
    userSkillRoot: `/home/sandbox/skill-user/${RUN_CTX.orgId}/${RUN_CTX.userId}`,
    skillRoots: [
      '/home/sandbox/skill',
      `/home/sandbox/skill-user/${RUN_CTX.orgId}/${RUN_CTX.userId}`,
    ],
    isEnabled: () => true,
    install: async () => ({ name: 'x', summary: 'installed x' }),
    uninstall: async () => ({ name: 'x', summary: 'uninstalled x' }),
    edit: async () => ({ path: 'x/SKILL.md', bytes: 1 }),
    reload: async () => ({ reloaded: true, installed: ['x'] }),
    describeInstalled: () => [{ name: 'x', tier: 'user' }],
    listInstalled: () => ['x'],
    ...overrides,
  };
}

/** Capture pi.registerTool calls. */
function collectTools(factory) {
  const tools = new Map();
  factory({
    registerTool: (def) => tools.set(def.name, def),
    on: () => {},
  });
  return tools;
}

describe('skill-lifecycle extension', () => {
  it('registers the documented skill tools', () => {
    const tools = collectTools(
      createSkillLifecycleExtension({
        runContext: RUN_CTX,
        deps: { skillManager: fakeSkillManager() },
      }),
    );
    assert.deepEqual(
      [...tools.keys()].sort(),
      [...SKILL_LIFECYCLE_TOOL_NAMES].sort(),
    );
  });

  it('refuses to construct without a manager, when disabled, or with no user dir', () => {
    assert.throws(
      () => createSkillLifecycleExtension({ runContext: RUN_CTX, deps: {} }),
      /SKILL_MANAGER_REQUIRED/,
    );
    assert.throws(
      () =>
        createSkillLifecycleExtension({
          runContext: RUN_CTX,
          deps: {
            skillManager: fakeSkillManager({
              mode: 'readonly',
              isEnabled: () => false,
            }),
          },
        }),
      /SKILLS_MODE_REQUIRED/,
    );
    assert.throws(
      () =>
        createSkillLifecycleExtension({
          runContext: RUN_CTX,
          deps: { skillManager: fakeSkillManager({ userSkillRoot: null }) },
        }),
      /SKILL_USER_ROOT_REQUIRED/,
    );
  });

  it('install reloads so the skill is usable in the same turn', async () => {
    let reloaded = false;
    const tools = collectTools(
      createSkillLifecycleExtension({
        runContext: RUN_CTX,
        deps: {
          skillManager: fakeSkillManager({
            reload: async () => {
              reloaded = true;
              return { reloaded: true, installed: ['inferred'] };
            },
            install: async (params) => {
              assert.equal(params.source, 'https://example.com/org/repo');
              return { name: 'inferred', summary: 'installed inferred' };
            },
          }),
        },
      }),
    );
    const result = await tools.get('skill_install').execute('call-1', {
      source: 'https://example.com/org/repo',
    });
    assert.equal(result.name, 'inferred');
    assert.equal(reloaded, true);
    assert.equal(result.reload.reloaded, true);
  });

  it('a failed reload does not lose the successful install', async () => {
    const tools = collectTools(
      createSkillLifecycleExtension({
        runContext: RUN_CTX,
        deps: {
          skillManager: fakeSkillManager({
            reload: async () => {
              throw new Error('loader exploded');
            },
          }),
        },
      }),
    );
    const result = await tools.get('skill_install').execute('call-1', {
      source: '/srv/src',
    });
    assert.equal(result.name, 'x');
    assert.equal(result.reload.reloaded, false);
    assert.match(result.reload.error, /loader exploded/);
  });

  it('loads in the bundle when an enabled manager is injected', () => {
    const names = extensionFactoryNames(
      createEnterpriseExtensionBundle(RUN_CTX, {
        skillManager: fakeSkillManager(),
      }),
    );
    assert.deepEqual(names, [...REQUIRED_EXTENSION_NAMES, 'skill-lifecycle']);
  });

  it('builds the manager per Run, bound to that Run identity', () => {
    const seen = [];
    const names = extensionFactoryNames(
      createEnterpriseExtensionBundle(RUN_CTX, {
        skillManagerFactory: (runContext) => {
          seen.push({ orgId: runContext.orgId, userId: runContext.userId });
          return fakeSkillManager();
        },
      }),
    );
    assert.deepEqual(names, [...REQUIRED_EXTENSION_NAMES, 'skill-lifecycle']);
    assert.deepEqual(seen, [{ orgId: RUN_CTX.orgId, userId: RUN_CTX.userId }]);
  });

  it('a factory returning null keeps the extension out (no per-user dir)', () => {
    assert.deepEqual(
      extensionFactoryNames(
        createEnterpriseExtensionBundle(RUN_CTX, {
          skillManagerFactory: () => null,
        }),
      ),
      [...REQUIRED_EXTENSION_NAMES],
    );
  });

  it('stays out of the bundle when installation is disabled', () => {
    assert.deepEqual(
      extensionFactoryNames(createEnterpriseExtensionBundle(RUN_CTX)),
      [...REQUIRED_EXTENSION_NAMES],
    );
    assert.deepEqual(
      extensionFactoryNames(
        createEnterpriseExtensionBundle(RUN_CTX, {
          skillManager: fakeSkillManager({
            isEnabled: () => false,
            mode: 'readonly',
          }),
        }),
      ),
      [...REQUIRED_EXTENSION_NAMES],
    );
    // Enabled but with no per-user directory: no write tools.
    assert.deepEqual(
      extensionFactoryNames(
        createEnterpriseExtensionBundle(RUN_CTX, {
          skillManager: fakeSkillManager({ userSkillRoot: null }),
        }),
      ),
      [...REQUIRED_EXTENSION_NAMES],
    );
  });

  it('an explicit AgentVersion list stays authoritative', () => {
    // Listing it requires the manager…
    assert.throws(
      () =>
        createEnterpriseExtensionBundle(RUN_CTX, {
          extensions: [...REQUIRED_EXTENSION_NAMES, 'skill-lifecycle'],
        }),
      /SKILL_MANAGER_REQUIRED/,
    );
    // …and omitting it keeps it out even when a manager is available, because
    // pi-runtime-factory matches the factory list against the AgentVersion.
    assert.deepEqual(
      extensionFactoryNames(
        createEnterpriseExtensionBundle(RUN_CTX, {
          extensions: [...REQUIRED_EXTENSION_NAMES],
          skillManager: fakeSkillManager(),
        }),
      ),
      [...REQUIRED_EXTENSION_NAMES],
    );
  });

  it('skill tools are classified and priced by the risk table', async () => {
    for (const name of SKILL_LIFECYCLE_TOOL_NAMES) {
      assert.equal(classifyTool(name).class, 'local_low', name);
    }

    // Default config: skill_install is high risk → approval; skill_list is low.
    const engine = createPolicyEngine({
      auditSink: async () => {},
      toolRiskPolicy: {
        tools: { skill_install: 'high', skill_list: 'low' },
      },
    });
    const ctx = { ...RUN_CTX };
    const install = await engine.evaluateToolCall({
      toolName: 'skill_install',
      args: { source: 'https://example.com/repo' },
      runContext: ctx,
    });
    assert.equal(install.decision, 'require_approval');
    const list = await engine.evaluateToolCall({
      toolName: 'skill_list',
      args: {},
      runContext: ctx,
    });
    assert.equal(list.decision, 'allow');
  });
});
