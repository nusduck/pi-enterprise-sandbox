import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterProfileTools,
  resolveAgentProfile,
} from '../application/agent-profile-service.js';
import { createCapabilityRegistry } from '../application/capability-registry-service.js';
import {
  createEnterpriseAgentKit,
  wrapNamedExtensionFactory,
} from '../packages/enterprise-agent-kit/index.js';

function loadFactories(factories) {
  const tools = new Map();
  const handlers = new Map();
  const pi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  for (const factory of factories) factory(pi);
  return { tools, handlers };
}

test('enterprise package registers only profile-allowed Sandbox tools', () => {
  const profile = resolveAgentProfile();
  const ready = [];
  const tools = [
    { name: 'read', description: 'read', parameters: {}, execute() {} },
    { name: 'bash', description: 'bash', parameters: {}, execute() {} },
    { name: 'not_allowed', description: 'bad', parameters: {}, execute() {} },
  ];
  const loaded = loadFactories(
    createEnterpriseAgentKit({
      profile,
      sandboxTools: tools,
      sandboxToolOptions: { onToolsReady: (available) => ready.push(available) },
    }),
  );
  assert.ok(loaded.tools.has('read'));
  assert.ok(loaded.tools.has('bash'));
  assert.ok(loaded.tools.has('task_plan'));
  assert.ok(loaded.tools.has('ask_user'));
  assert.ok(loaded.tools.has('context_compact'));
  assert.ok(loaded.tools.has('structured_output'));
  assert.equal(loaded.tools.has('not_allowed'), false);
  assert.deepEqual(ready[0].map((tool) => tool.name), ['read', 'bash']);
});

test('dynamic resources are discovered through the Extension lifecycle', async () => {
  const profile = resolveAgentProfile();
  const events = [];
  const loaded = loadFactories(
    createEnterpriseAgentKit({
      profile,
      sandboxTools: [],
      emit: (event) => events.push(event),
      extraSkillPaths: ['/opt/company/profile-skills'],
    }),
  );
  const discover = loaded.handlers.get('resources_discover')?.[0];
  assert.equal(typeof discover, 'function');
  const result = await discover({ reason: 'startup', cwd: '/workspace' });
  assert.ok(result.skillPaths.some((path) => path.endsWith('/skills')));
  assert.ok(result.promptPaths.some((path) => path.endsWith('/prompts')));
  assert.ok(result.skillPaths.includes('/opt/company/profile-skills'));
  assert.equal(events[0].type, 'resources_discovered');
});

test('Agent Profile controls production and development skill tools', () => {
  const profile = resolveAgentProfile();
  const available = ['read', 'skill_install', 'unknown'];
  assert.deepEqual(filterProfileTools(profile, available, { skillsMode: 'production' }), [
    'read',
  ]);
  assert.deepEqual(
    filterProfileTools(profile, available, { skillsMode: 'development' }),
    ['read', 'skill_install'],
  );
});

test('skill management tools are registered only by the development extension', () => {
  const profile = resolveAgentProfile();
  const skillTool = { name: 'skill_reload', description: 'reload', parameters: {}, execute() {} };
  const readonly = loadFactories(createEnterpriseAgentKit({
    profile,
    sandboxTools: [],
    skillsMode: 'readonly',
    skillTools: [skillTool],
  }));
  assert.equal(readonly.tools.has('skill_reload'), false);
  const development = loadFactories(createEnterpriseAgentKit({
    profile,
    sandboxTools: [],
    skillsMode: 'development',
    skillTools: [skillTool],
  }));
  assert.equal(development.tools.has('skill_reload'), true);
});

test('Agent Profile can be configured without bypassing immutable defaults', () => {
  const profile = resolveAgentProfile('risk-reader', {
    AGENT_PROFILES_JSON: JSON.stringify({
      'risk-reader': {
        extensions: ['mcp', 'policy'],
        allowedTools: ['mcp'],
        allowedMcpServers: ['risk-platform'],
        contextPolicy: { reserveTokens: 9000 },
      },
    }),
  });
  assert.equal(profile.id, 'risk-reader');
  assert.deepEqual(profile.allowedTools, ['mcp']);
  assert.deepEqual(profile.allowedMcpServers, ['risk-platform']);
  assert.equal(profile.contextPolicy.reserveTokens, 9000);
  assert.equal(profile.contextPolicy.keepRecentTokens, 20000);
});

test('wrapNamedExtensionFactory records active and failed extension statuses', () => {
  const registry = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'wrap_test' });
  const pi = { registerTool() {}, on() {} };

  wrapNamedExtensionFactory(
    'healthy-ext',
    () => ({ name: 'healthy-ext' }),
    { getCapabilityRegistry: () => registry },
  )(pi);
  const active = registry.get('extension:healthy-ext');
  assert.equal(active?.status, 'active');
  assert.equal(active?.scope, 'extension_factories');

  const failing = wrapNamedExtensionFactory(
    'broken-ext',
    () => {
      throw new Error('factory exploded');
    },
    { getCapabilityRegistry: () => registry },
  );
  assert.throws(() => failing(pi), /factory exploded/);
  const failed = registry.get('extension:broken-ext');
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.metadata.reason, 'factory_error');
  assert.match(String(failed?.metadata.error), /factory exploded/);
});

test('wrapNamedExtensionFactory async success registers active only after fulfillment', async () => {
  const registry = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'wrap_async_ok' });
  const pi = { registerTool() {}, on() {} };
  let resolveFactory;
  const tracked = wrapNamedExtensionFactory(
    'async-ext',
    () =>
      new Promise((resolve) => {
        resolveFactory = resolve;
      }),
    { getCapabilityRegistry: () => registry },
  );
  const pending = tracked(pi);
  assert.equal(registry.get('extension:async-ext'), null);
  resolveFactory({ name: 'async-ext' });
  const result = await pending;
  assert.equal(result.name, 'async-ext');
  assert.equal(registry.get('extension:async-ext')?.status, 'active');
});

test('wrapNamedExtensionFactory async failure registers failed with sanitized error and rethrows', async () => {
  const registry = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'wrap_async_fail' });
  const pi = { registerTool() {}, on() {} };
  let rejectFactory;
  const tracked = wrapNamedExtensionFactory(
    'async-broken-ext',
    () =>
      new Promise((_resolve, reject) => {
        rejectFactory = reject;
      }),
    { getCapabilityRegistry: () => registry },
  );
  const pending = tracked(pi);
  assert.equal(registry.get('extension:async-broken-ext'), null);
  rejectFactory(new Error('Bearer sk-async api_key=live-secret'));
  await assert.rejects(pending, /Bearer sk-async api_key=live-secret/);
  const failed = registry.get('extension:async-broken-ext');
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.metadata.reason, 'factory_error');
  assert.ok(!String(failed?.metadata.error).includes('sk-async'));
  assert.ok(!String(failed?.metadata.error).includes('live-secret'));
  assert.match(String(failed?.metadata.error), /\[REDACTED\]/);
});

test('coding profile registers capabilities introspection tool', () => {
  const profile = resolveAgentProfile();
  const registry = createCapabilityRegistry({ profileId: profile.id, runId: 't' });
  registry.register({
    kind: 'skill',
    name: 'code-review',
    status: 'active',
    source: 'kit',
    description: 'review',
  });
  const loaded = loadFactories(
    createEnterpriseAgentKit({
      profile,
      sandboxTools: [],
      getCapabilityRegistry: () => registry,
    }),
  );
  assert.ok(loaded.tools.has('capabilities'));
  assert.ok(loaded.tools.has('task_plan'));
});
