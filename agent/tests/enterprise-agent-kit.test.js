import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterProfileTools,
  resolveAgentProfile,
} from '../application/agent-profile-service.js';
import { createEnterpriseAgentKit } from '../packages/enterprise-agent-kit/index.js';

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
  const tools = [
    { name: 'read', description: 'read', parameters: {}, execute() {} },
    { name: 'bash', description: 'bash', parameters: {}, execute() {} },
    { name: 'not_allowed', description: 'bad', parameters: {}, execute() {} },
  ];
  const loaded = loadFactories(
    createEnterpriseAgentKit({ profile, sandboxTools: tools }),
  );
  assert.ok(loaded.tools.has('read'));
  assert.ok(loaded.tools.has('bash'));
  assert.ok(loaded.tools.has('task_plan'));
  assert.ok(loaded.tools.has('ask_user'));
  assert.ok(loaded.tools.has('context_compact'));
  assert.ok(loaded.tools.has('structured_output'));
  assert.equal(loaded.tools.has('not_allowed'), false);
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
