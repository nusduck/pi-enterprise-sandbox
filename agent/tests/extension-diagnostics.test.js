import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getExtensionDiagnostics } from '../src/application/extension-diagnostics-service.js';
import {
  ENTERPRISE_DEFAULT_TOOLS,
  ENTERPRISE_EXTENSION_NAMES,
} from '../src/extensions/index.js';

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'extension-diagnostics-'));
  const skillDir = join(root, 'workspace-helper');
  await mkdir(skillDir);
  await writeFile(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: workspace-helper',
      'description: Helps with workspace files.',
      '---',
      '',
      '# Workspace helper',
      '',
    ].join('\n'),
    'utf8',
  );
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('diagnostics preserves the UI contract using only production capabilities', () => {
  const diagnostics = getExtensionDiagnostics({
    skillRoots: [root],
    models: [{ model_id: 'model-1', enabled: true }],
    now: () => new Date('2026-07-19T00:00:00.000Z'),
  });

  assert.equal(diagnostics.status, 'ok');
  assert.equal(diagnostics.generated_at, '2026-07-19T00:00:00.000Z');
  assert.equal(diagnostics.view, 'configured');
  assert.equal(diagnostics.registry.live, false);
  assert.deepEqual(
    diagnostics.extensions.map((extension) => extension.name),
    [...ENTERPRISE_EXTENSION_NAMES],
  );
  assert.deepEqual(
    diagnostics.tools.map((tool) => tool.name),
    [...ENTERPRISE_DEFAULT_TOOLS],
  );
  assert.equal(diagnostics.package.package, 'pi-enterprise-agent');
  assert.notEqual(
    diagnostics.package.package,
    '@company/pi-enterprise-agent-kit',
  );
  assert.deepEqual(diagnostics.models, [
    { model_id: 'model-1', enabled: true },
  ]);

  const skill = diagnostics.skills.find(
    (entry) => entry.name === 'workspace-helper',
  );
  assert.equal(skill.description, 'Helps with workspace files.');
  assert.equal(skill.source, 'shared-skill-root');
  assert.equal(skill.path, null);
  assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(root));
});

test('MCP diagnostics expose references as a boolean policy, never endpoints or refs', () => {
  const diagnostics = getExtensionDiagnostics({
    mcpServers: [
      {
        id: 'crm',
        url: 'https://mcp.example.test/private',
        authTokenRef: 'CRM_PRODUCTION_TOKEN',
      },
      {
        id: 'disabled',
        command: 'node',
        args: ['server.js'],
        enabled: false,
      },
    ],
    models: [],
  });

  const crm = diagnostics.mcp_servers.find(
    (server) => server.server_id === 'crm',
  );
  assert.equal(crm.status, 'configured');
  assert.equal(crm.connection_status, 'configured');
  assert.equal(crm.authorization, 'host-injected');
  assert.deepEqual(diagnostics.profile.allowed_mcp_servers, ['crm']);

  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /mcp\.example\.test/);
  assert.doesNotMatch(serialized, /CRM_PRODUCTION_TOKEN/);
});

test('MCP diagnostics expose startup-discovered mcp__ tools with approval defaults', () => {
  const diagnostics = getExtensionDiagnostics({
    mcpServers: [{ id: 'crm', command: 'node', args: ['server.js'] }],
    mcpDiscovery: {
      ready: true,
      servers: [
        {
          serverId: 'crm',
          status: 'connected',
          toolCount: 1,
          toolNames: ['search'],
        },
      ],
    },
    models: [],
  });
  const tool = diagnostics.tools.find((entry) => entry.name === 'mcp__crm__search');
  assert.equal(tool?.source, 'mcp');
  assert.equal(tool?.approval_policy, 'require_approval');
  assert.deepEqual(diagnostics.profile.allowed_mcp_tools, ['mcp__crm__search']);
  assert.equal(diagnostics.mcp_servers[0].tool_count, 1);
  assert.equal(diagnostics.mcp_servers[0].connection_status, 'connected');
});

test('unknown legacy profile ids fail closed', () => {
  assert.throws(
    () =>
      getExtensionDiagnostics({
        profileId: 'legacy-package-profile',
        models: [],
      }),
    /Unknown diagnostics profile/,
  );
});
