import assert from 'node:assert/strict';
import test from 'node:test';

import {
  capabilityId,
  createCapabilityRegistry,
  createLatestCapabilitySnapshotStore,
  normalizeCapabilityEntry,
  publishCapabilitySnapshot,
  reconcileResourceLoaderSkills,
  reconcileSessionTools,
  redactEmbeddedHostPaths,
  sanitizeCapabilityLocation,
  sanitizeCapabilityMetadata,
  statusToEnabled,
} from '../application/capability-registry-service.js';
import {
  evaluateSkillPolicy,
  filterProfileSkills,
  normalizeSharedSkillsPolicy,
  pickProfileArray,
  resolveAgentProfile,
  seedConfiguredCapabilities,
} from '../application/agent-profile-service.js';
import { getExtensionDiagnostics } from '../application/extension-diagnostics-service.js';
import { createCapabilityIntrospectionExtension } from '../packages/enterprise-agent-kit/extensions/capability-introspection/index.js';

test('normalize redacts bearer tokens, credential assignments, password URLs, and host paths', () => {
  const entry = normalizeCapabilityEntry({
    kind: 'extension',
    name: 'broken',
    status: 'failed',
    source: '/Users/tester/project/ext',
    description: 'Bearer eyJhbGciOiJIUzI1NiJ9.token api_key=supersecret',
    metadata: {
      error: 'failed at /Users/tester/project with password=hidden and postgres://user:pass@db/prod',
      reason: 'authorization: Bearer leaked',
    },
  });
  assert.ok(!entry.description.includes('eyJhbGci'));
  assert.ok(!entry.description.includes('api_key=supersecret'));
  assert.match(entry.description, /\[REDACTED\]/);
  assert.ok(!entry.metadata.error.includes('/Users/tester'));
  assert.ok(!entry.metadata.error.includes('user:pass'));
  assert.match(entry.metadata.error, /\[redacted-path\]/);
  assert.match(entry.metadata.error, /\[REDACTED\]/);
  assert.ok(!entry.metadata.reason.includes('Bearer leaked'));
});

test('normalize + sanitize strips secrets and bounds text', () => {
  const meta = sanitizeCapabilityMetadata('tool', {
    category: 'sandbox',
    api_key: 'secret',
    token: 'x',
    authorization: 'Bearer x',
    parameters: { a: 1 },
    risk_level: 'low',
  });
  assert.equal(meta.category, 'sandbox');
  assert.equal(meta.risk_level, 'low');
  assert.equal(meta.api_key, undefined);
  assert.equal(meta.token, undefined);
  assert.equal(meta.parameters, undefined);

  const entry = normalizeCapabilityEntry({
    kind: 'skill',
    name: 'docx',
    status: 'active',
    source: '/home/sandbox/skill',
    description: 'x'.repeat(1000),
    metadata: { path: '/home/sandbox/skill/docx/SKILL.md', secret: 'nope' },
  });
  assert.equal(entry.id, 'skill:docx');
  assert.ok(entry.description.length <= 480);
  assert.equal(entry.metadata.secret, undefined);
  assert.ok(entry.metadata.path);
});

test('registry register/reconcile/list/search/describe are deterministic', () => {
  const events = [];
  const reg = createCapabilityRegistry({
    profileId: 'coding-agent',
    runId: 'run_1',
    onChange: (e) => events.push(e),
  });

  reg.reconcile(
    'skill',
    [
      { name: 'b-skill', status: 'active', source: 's', description: 'beta' },
      { name: 'a-skill', status: 'active', source: 's', description: 'alpha weather' },
    ],
    'resource_loader',
  );
  const listed = reg.list({ kind: 'skill' });
  assert.deepEqual(
    listed.items.map((i) => i.name),
    ['a-skill', 'b-skill'],
  );
  assert.equal(listed.registry_version >= 1, true);

  const searched = reg.search({ query: 'weather', kind: 'skill' });
  assert.equal(searched.items[0].name, 'a-skill');

  const described = reg.describe({ kind: 'skill', name: 'b-skill' });
  assert.equal(described.entry.id, 'skill:b-skill');

  // Reconcile removes stale entries in scope.
  reg.reconcile(
    'skill',
    [{ name: 'a-skill', status: 'active', source: 's', description: 'alpha' }],
    'resource_loader',
  );
  assert.equal(reg.list({ kind: 'skill' }).total, 1);
  assert.equal(reg.get(capabilityId('skill', 'b-skill')), null);

  // No version bump when data unchanged.
  const v = reg.getVersion();
  reg.reconcile(
    'skill',
    [{ name: 'a-skill', status: 'active', source: 's', description: 'alpha' }],
    'resource_loader',
  );
  assert.equal(reg.getVersion(), v);
  assert.ok(events.some((e) => e.type === 'capability_registry_updated'));
});

test('concurrent registries stay isolated', () => {
  const a = createCapabilityRegistry({ profileId: 'p-a', runId: 'r-a' });
  const b = createCapabilityRegistry({ profileId: 'p-b', runId: 'r-b' });
  a.register({ kind: 'skill', name: 'only-a', status: 'active', source: 'a' });
  b.register({ kind: 'skill', name: 'only-b', status: 'active', source: 'b' });
  assert.equal(a.list({ kind: 'skill' }).items[0].name, 'only-a');
  assert.equal(b.list({ kind: 'skill' }).items[0].name, 'only-b');
  assert.equal(a.list().items.some((i) => i.name === 'only-b'), false);
  assert.equal(b.list().items.some((i) => i.name === 'only-a'), false);
});

test('snapshot store keys by run and profile filter', () => {
  const store = createLatestCapabilitySnapshotStore({ maxSnapshots: 4 });
  const a = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'run_a' });
  const b = createCapabilityRegistry({ profileId: 'risk-reader', runId: 'run_b' });
  a.register({ kind: 'tool', name: 'read', status: 'active', source: 't' });
  b.register({ kind: 'tool', name: 'mcp', status: 'active', source: 't' });
  publishCapabilitySnapshot(a, { store, reason: 'a' });
  publishCapabilitySnapshot(b, { store, reason: 'b' });
  assert.equal(store.getByRunId('run_a').profile_id, 'coding-agent');
  assert.equal(store.getLatest({ profileId: 'coding-agent' }).run_id, 'run_a');
  assert.equal(store.getLatest().run_id, 'run_b');
});

test('coding-agent default MCP tool policy is explicit wildcard allow-all', () => {
  const profile = resolveAgentProfile();
  assert.deepEqual(profile.allowedMcpTools, ['*']);
});

test('sharedSkills policy modes + package filter', () => {
  assert.deepEqual(normalizeSharedSkillsPolicy({ mode: 'all' }).mode, 'all');
  assert.throws(() => normalizeSharedSkillsPolicy({ mode: 'allowlist', names: [] }));
  assert.throws(() => normalizeSharedSkillsPolicy({ mode: 'weird' }));

  const profile = resolveAgentProfile();
  assert.equal(profile.sharedSkills.mode, 'all');
  assert.ok(profile.allowedTools.includes('capabilities'));
  assert.ok(profile.extensions.includes('capability-introspection'));

  const packageRoot = '/app/agent/packages/enterprise-agent-kit/skills';
  const skills = [
    {
      name: 'code-review',
      filePath: `${packageRoot}/code-review/SKILL.md`,
    },
    {
      name: 'unknown-package',
      filePath: `${packageRoot}/unknown-package/SKILL.md`,
    },
    {
      name: 'docx',
      filePath: '/home/sandbox/skill/docx/SKILL.md',
    },
    {
      name: 'blocked',
      filePath: '/home/sandbox/skill/blocked/SKILL.md',
    },
  ];

  // coding-agent: package allowlist + shared all
  const filteredAll = filterProfileSkills(profile, skills, {
    packageSkillRoots: [packageRoot],
  });
  assert.deepEqual(
    filteredAll.map((s) => s.name).sort(),
    ['code-review', 'docx', 'blocked'].sort(),
  );
  assert.equal(
    evaluateSkillPolicy(profile, skills[1], { packageSkillRoots: [packageRoot] }).enabled,
    false,
  );

  const noneProfile = resolveAgentProfile('coding-agent', {
    AGENT_PROFILES_JSON: JSON.stringify({
      'coding-agent': {
        sharedSkills: { mode: 'none' },
      },
    }),
  });
  const filteredNone = filterProfileSkills(noneProfile, skills, {
    packageSkillRoots: [packageRoot],
  });
  assert.deepEqual(
    filteredNone.map((s) => s.name),
    ['code-review'],
  );

  const allowProfile = resolveAgentProfile('coding-agent', {
    AGENT_PROFILES_JSON: JSON.stringify({
      'coding-agent': {
        sharedSkills: { mode: 'allowlist', names: ['docx'] },
      },
    }),
  });
  const filteredAllow = filterProfileSkills(allowProfile, skills, {
    packageSkillRoots: [packageRoot],
  });
  assert.deepEqual(
    filteredAllow.map((s) => s.name).sort(),
    ['code-review', 'docx'],
  );
});

test('redactEmbeddedHostPaths redacts generic linux paths but keeps logical skill roots', () => {
  assert.match(
    redactEmbeddedHostPaths('skill at /home/eddie/project and /opt/app/bin'),
    /\[redacted-path\].*\[redacted-path\]/,
  );
  assert.ok(!redactEmbeddedHostPaths('/home/sandbox/skill/docx').includes('[redacted-path]'));
  assert.ok(!redactEmbeddedHostPaths('/sandbox/skills/foo').includes('[redacted-path]'));
  assert.ok(!redactEmbeddedHostPaths('/app/.pi/skills/foo').includes('[redacted-path]'));
});

test('redactEmbeddedHostPaths fully replaces POSIX roots adjacent to punctuation', () => {
  const cases = [
    ['deployed from /usr/local/bin/node, ok', 'deployed from [redacted-path], ok'],
    ['mount at /mnt/data/vol; failed', 'mount at [redacted-path]; failed'],
    ['stored in /data/app (private)', 'stored in [redacted-path] (private)'],
    ['/srv/www/site.', '[redacted-path].'],
    ['user /home/eddie/repos', 'user [redacted-path]'],
    ['bare /usr/local works', 'bare [redacted-path] works'],
    ['see (/opt/app/bin) next', 'see ([redacted-path]) next'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redactEmbeddedHostPaths(input), expected, input);
  }
});

test('redactEmbeddedHostPaths generically redacts uncommon absolute POSIX paths', () => {
  assert.equal(redactEmbeddedHostPaths('/root/.ssh/id_rsa'), '[redacted-path]');
  assert.equal(
    redactEmbeddedHostPaths('key at /root/.ssh/id_rsa, done'),
    'key at [redacted-path], done',
  );
  assert.equal(redactEmbeddedHostPaths('/var/log/app/file.tar.gz'), '[redacted-path]');
  assert.equal(
    redactEmbeddedHostPaths('wrote /var/log/app/file.tar.gz.'),
    'wrote [redacted-path].',
  );

  const paths = [
    '/run/secrets/token',
    '/nix/store/abc',
    '/Applications/App/config',
    '/Volumes/Data/private',
  ];
  for (const hostPath of paths) {
    const redacted = redactEmbeddedHostPaths(`failed loading ${hostPath}`);
    assert.ok(!redacted.includes(hostPath), hostPath);
    assert.match(redacted, /\[redacted-path\]/);
  }
  assert.equal(
    redactEmbeddedHostPaths('fetch https://example.com/nix/store/abc ok'),
    'fetch https://example.com/nix/store/abc ok',
  );
  assert.equal(redactEmbeddedHostPaths('ratio uses a/b not absolute'), 'ratio uses a/b not absolute');
});

test('registry description error and query echoes redact generic absolute paths', () => {
  const reg = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'generic_paths' });
  const paths = [
    '/root/.ssh/id_rsa',
    '/run/secrets/token',
    '/nix/store/abc',
    '/Applications/App/config',
    '/Volumes/Data/private',
  ];
  paths.forEach((hostPath, index) => {
    const extName = `path-ext-${index}`;
    reg.register({
      kind: 'extension',
      name: extName,
      status: 'failed',
      source: 'enterprise-agent-kit',
      description: `reads ${hostPath}`,
      metadata: { error: `ENOENT ${hostPath}`, reason: `missing ${hostPath}` },
    });
    const searched = reg.search({ query: hostPath });
    assert.ok(!searched.query.includes(hostPath), hostPath);
    assert.match(searched.query, /\[redacted-path\]/);

    const described = reg.describe({ kind: 'extension', name: extName });
    assert.ok(described.entry);
    assert.ok(!described.entry.description.includes(hostPath), hostPath);
    assert.ok(!described.entry.metadata.error.includes(hostPath), hostPath);
    assert.match(described.entry.description, /\[redacted-path\]/);
    assert.match(described.entry.metadata.error, /\[redacted-path\]/);
  });
});

test('capabilities default list includes active configured failed and disabled', async () => {
  const reg = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'status_default' });
  reg.register({ kind: 'tool', name: 'read', status: 'active', source: 'pi' });
  reg.register({
    kind: 'skill',
    name: 'docx',
    status: 'configured',
    source: 'shared',
  });
  reg.register({
    kind: 'mcp_server',
    name: 'paused-srv',
    status: 'disabled',
    source: 'mcp-connection-manager',
    dynamic: true,
  });
  reg.register({
    kind: 'mcp_server',
    name: 'broken-srv',
    status: 'failed',
    source: 'mcp-connection-manager',
    dynamic: true,
  });

  const tools = new Map();
  createCapabilityIntrospectionExtension({
    getRegistry: () => reg,
    allowedTools: ['capabilities'],
  })({
    registerTool: (t) => tools.set(t.name, t),
  });
  const listed = JSON.parse(
    (await tools.get('capabilities').execute('l1', { action: 'list' })).content[0].text,
  );
  const statuses = new Set(listed.items.map((item) => item.status));
  assert.ok(statuses.has('active'));
  assert.ok(statuses.has('configured'));
  assert.ok(statuses.has('failed'));
  assert.ok(statuses.has('disabled'));
  assert.equal(reg.list().items.some((item) => item.name === 'not-allowed'), false);

  const disabledOnly = JSON.parse(
    (await tools.get('capabilities').execute('l2', {
      action: 'list',
      status: 'disabled',
    })).content[0].text,
  );
  assert.ok(disabledOnly.items.every((item) => item.status === 'disabled'));
  assert.ok(disabledOnly.items.some((item) => item.name === 'paused-srv'));
});

test('capabilities list pagination requires next_cursor until complete inventory', async () => {
  const reg = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'pages' });
  for (let i = 0; i < 75; i += 1) {
    reg.register({
      kind: 'skill',
      name: `skill-${String(i).padStart(3, '0')}`,
      status: 'active',
      source: 'shared',
    });
  }
  const tools = new Map();
  createCapabilityIntrospectionExtension({
    getRegistry: () => reg,
    allowedTools: ['capabilities'],
  })({
    registerTool: (t) => tools.set(t.name, t),
  });
  const tool = tools.get('capabilities');
  const page1 = JSON.parse(
    (await tool.execute('p1', { action: 'list', kind: 'skill', limit: 50 })).content[0].text,
  );
  assert.equal(page1.returned, 50);
  assert.equal(page1.total, 75);
  assert.ok(page1.next_cursor);
  const page2 = JSON.parse(
    (await tool.execute('p2', {
      action: 'list',
      kind: 'skill',
      limit: 50,
      cursor: page1.next_cursor,
    })).content[0].text,
  );
  assert.equal(page2.returned, 25);
  assert.equal(page2.next_cursor, null);
  const names = [...page1.items, ...page2.items].map((item) => item.name);
  assert.equal(names.length, 75);
  assert.equal(new Set(names).size, 75);
});

test('capabilities search sanitizes emitted query and error echoes', async () => {
  const reg = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'search_redact' });
  reg.register({ kind: 'tool', name: 'read', status: 'active', source: 'pi' });
  const events = [];
  const tools = new Map();
  createCapabilityIntrospectionExtension({
    getRegistry: () => reg,
    allowedTools: ['capabilities'],
    emit: (event) => events.push(event),
  })({
    registerTool: (t) => tools.set(t.name, t),
  });
  const dirty = 'Bearer sk-test api_key=secret ' + 'q'.repeat(200);
  const response = await tools.get('capabilities').execute('s1', {
    action: 'search',
    query: dirty,
  });
  const payload = JSON.parse(response.content[0].text);
  assert.ok(!payload.query.includes('Bearer'));
  assert.ok(!payload.query.includes('api_key=secret'));
  assert.equal(payload.query.length <= 128, true);
  assert.equal(events[0].query, payload.query);
});

test('capabilities tool input schema enforces bounded string fields', async () => {
  const tools = new Map();
  createCapabilityIntrospectionExtension({
    getRegistry: () => createCapabilityRegistry({ profileId: 'coding-agent', runId: 'schema' }),
    allowedTools: ['capabilities'],
  })({
    registerTool: (t) => tools.set(t.name, t),
  });
  const schema = tools.get('capabilities').parameters;
  assert.equal(schema.properties.query.maxLength, 128);
  assert.equal(schema.properties.name.maxLength, 128);
  assert.equal(schema.properties.id.maxLength, 128);
  assert.equal(schema.properties.cursor.maxLength, 128);
});

test('capabilities tool list/search/describe and rejects missing registry', async () => {
  const reg = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'r1' });
  reg.register({
    kind: 'skill',
    name: 'docx',
    status: 'active',
    source: 'shared',
    description: 'Office documents',
  });
  reg.register({
    kind: 'tool',
    name: 'read',
    status: 'active',
    source: 'sandbox',
    description: 'Read files',
  });

  const tools = new Map();
  createCapabilityIntrospectionExtension({
    getRegistry: () => reg,
    allowedTools: ['capabilities'],
  })({
    registerTool: (t) => tools.set(t.name, t),
  });
  assert.ok(tools.has('capabilities'));
  const tool = tools.get('capabilities');
  const listed = await tool.execute('c1', { action: 'list', kind: 'skill' });
  const payload = JSON.parse(listed.content[0].text);
  assert.equal(payload.total, 1);
  assert.equal(payload.items[0].name, 'docx');

  const searched = await tool.execute('c2', { action: 'search', query: 'read' });
  const sPayload = JSON.parse(searched.content[0].text);
  assert.ok(sPayload.items.some((i) => i.name === 'read'));

  const described = await tool.execute('c3', {
    action: 'describe',
    kind: 'skill',
    name: 'docx',
  });
  assert.equal(JSON.parse(described.content[0].text).entry.name, 'docx');

  const emptyTools = new Map();
  createCapabilityIntrospectionExtension({
    getRegistry: () => null,
    allowedTools: ['capabilities'],
  })({
    registerTool: (t) => emptyTools.set(t.name, t),
  });
  const err = await emptyTools.get('capabilities').execute('c4', { action: 'list' });
  assert.equal(err.isError, true);
});

test('capabilities tool not registered when profile denies it', () => {
  const tools = new Map();
  createCapabilityIntrospectionExtension({
    getRegistry: () => createCapabilityRegistry(),
    allowedTools: ['read'],
  })({
    registerTool: (t) => tools.set(t.name, t),
  });
  assert.equal(tools.size, 0);
});

test('reconcile session tools and resource loader skills', () => {
  const reg = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'r' });
  reconcileSessionTools(
    reg,
    {
      getAllTools: () => [
        { name: 'read', description: 'r' },
        { name: 'mcp_web_search_exa', description: 's', sourceInfo: { source: 'mcp' } },
      ],
      getActiveToolNames: () => ['read', 'mcp_web_search_exa'],
    },
    { profileId: 'coding-agent' },
  );
  assert.equal(reg.list({ kind: 'tool' }).total, 2);
  assert.equal(reg.get('tool:mcp_web_search_exa').dynamic, true);

  reconcileResourceLoaderSkills(
    reg,
    {
      getSkills: () => ({
        skills: [
          {
            name: 'docx',
            description: 'docs',
            filePath: '/home/sandbox/skill/docx/SKILL.md',
            baseDir: '/home/sandbox/skill/docx',
          },
        ],
      }),
    },
    { profileId: 'coding-agent' },
  );
  assert.equal(reg.list({ kind: 'skill' }).items[0].status, 'active');

  // Reload removes stale skill
  reconcileResourceLoaderSkills(
    reg,
    { getSkills: () => ({ skills: [] }) },
    { profileId: 'coding-agent' },
  );
  assert.equal(reg.list({ kind: 'skill' }).total, 0);
});

test('diagnostics configured fallback and live merge', () => {
  const store = createLatestCapabilitySnapshotStore();
  const cold = getExtensionDiagnostics({
    skillRoots: [],
    mcpServers: [],
    snapshotStore: store,
  });
  assert.equal(cold.view, 'configured');
  assert.equal(cold.registry.live, false);
  assert.ok(cold.extensions.every((e) => e.status === 'configured'));
  assert.ok(cold.profile.shared_skills);
  assert.ok(statusToEnabled('configured'));

  const reg = createCapabilityRegistry({
    profileId: 'coding-agent',
    runId: 'run_live',
  });
  seedConfiguredCapabilities(resolveAgentProfile()).extensions.forEach((e) =>
    reg.register({ ...e, status: 'active', scope: 'session_extensions' }),
  );
  reg.register({
    kind: 'tool',
    name: 'read',
    status: 'active',
    source: 'pi',
    dynamic: false,
  });
  reg.register({
    kind: 'skill',
    name: 'code-review',
    status: 'active',
    source: 'kit',
    description: 'Review',
  });
  reg.register({
    kind: 'mcp_tool',
    name: 'mcp_web_search_exa',
    status: 'active',
    source: 'mcp:search',
    dynamic: true,
    metadata: {
      server_id: 'search',
      tool_key: 'search:web_search_exa',
      registered_name: 'mcp_web_search_exa',
    },
  });
  publishCapabilitySnapshot(reg, { store, reason: 'test' });

  const live = getExtensionDiagnostics({
    skillRoots: [],
    mcpServers: [{ id: 'search', name: 'Search', enabled: true }],
    snapshotStore: store,
  });
  assert.equal(live.view, 'live');
  assert.equal(live.registry.live, true);
  assert.equal(live.registry.registry_version >= 1, true);
  assert.ok(live.registry.mcp_tools.some((t) => t.name === 'mcp_web_search_exa'));
  const readTool = live.tools.find((t) => t.name === 'read');
  assert.equal(readTool.status, 'active');
});

test('pickProfileArray preserves explicit empty profile arrays', () => {
  assert.deepEqual(pickProfileArray([], ['read', 'write']), []);
  assert.deepEqual(pickProfileArray(undefined, ['read']), ['read']);
  assert.deepEqual(pickProfileArray(null, ['read']), ['read']);

  const profile = resolveAgentProfile('coding-agent', {
    AGENT_PROFILES_JSON: JSON.stringify({
      'coding-agent': {
        allowedTools: [],
        allowedMcpServers: [],
        skills: [],
        extensions: ['mcp'],
      },
    }),
  });
  assert.deepEqual(profile.allowedTools, []);
  assert.deepEqual(profile.allowedMcpServers, []);
  assert.deepEqual(profile.skills, []);
  assert.deepEqual(profile.extensions, ['mcp']);
});

test('null-profile snapshots never satisfy a filtered profile lookup', () => {
  const store = createLatestCapabilitySnapshotStore();
  const reg = createCapabilityRegistry({ profileId: null, runId: 'null_profile_run' });
  reg.register({ kind: 'tool', name: 'orphan', status: 'active', source: 'test' });
  publishCapabilitySnapshot(reg, { store, reason: 'null-profile' });
  assert.equal(store.getLatest({ profileId: 'coding-agent' }), null);
  assert.equal(store.getLatest()?.profile_id, null);
});

test('snapshot store isolates owners with same profile', () => {
  const store = createLatestCapabilitySnapshotStore({ maxSnapshots: 8 });
  const userA = createCapabilityRegistry({
    profileId: 'coding-agent',
    runId: 'run_user_a',
    ownerUserId: 'user_a',
    organizationId: 'org_a',
  });
  const userB = createCapabilityRegistry({
    profileId: 'coding-agent',
    runId: 'run_user_b',
    ownerUserId: 'user_b',
    organizationId: 'org_a',
  });
  userA.register({ kind: 'tool', name: 'read', status: 'active', source: 'a' });
  userB.register({ kind: 'tool', name: 'write', status: 'active', source: 'b' });
  publishCapabilitySnapshot(userA, { store, reason: 'user_a' });
  publishCapabilitySnapshot(userB, { store, reason: 'user_b' });

  const filterA = {
    profileId: 'coding-agent',
    ownerUserId: 'user_a',
    organizationId: 'org_a',
  };
  const filterB = {
    profileId: 'coding-agent',
    ownerUserId: 'user_b',
    organizationId: 'org_a',
  };
  assert.equal(store.getLatest(filterA).run_id, 'run_user_a');
  assert.equal(store.getLatest(filterB).run_id, 'run_user_b');
  assert.equal(
    store.getLatest({
      profileId: 'coding-agent',
      ownerUserId: 'user_c',
      organizationId: 'org_a',
    }),
    null,
  );
});

test('null-owner snapshots never satisfy an owned partition filter', () => {
  const store = createLatestCapabilitySnapshotStore();
  const unowned = createCapabilityRegistry({
    profileId: 'coding-agent',
    runId: 'run_unowned',
  });
  unowned.register({ kind: 'tool', name: 'bash', status: 'active', source: 'test' });
  publishCapabilitySnapshot(unowned, { store, reason: 'unowned' });

  assert.equal(
    store.getLatest({
      profileId: 'coding-agent',
      ownerUserId: 'user_a',
      organizationId: 'org_a',
    }),
    null,
  );
  assert.equal(store.getLatest({ profileId: 'coding-agent' }).run_id, 'run_unowned');
});

test('published snapshots are deeply immutable including nested counts', () => {
  const store = createLatestCapabilitySnapshotStore();
  const reg = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'freeze_run' });
  reg.register({ kind: 'tool', name: 'read', status: 'active', source: 'pi' });
  const published = publishCapabilitySnapshot(reg, { store, reason: 'freeze' });
  assert.throws(() => {
    published.counts.tool.total = 99;
  });
  assert.throws(() => {
    published.entries[0].description = 'mutated';
  });
  assert.throws(() => {
    published.entries[0].metadata.category = 'mutated';
  });
});

test('search query and describe echoes are bounded', () => {
  const reg = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'bound_run' });
  reg.register({ kind: 'skill', name: 'docs', status: 'active', source: 'shared' });
  const longQuery = 'q'.repeat(300);
  const searched = reg.search({ query: longQuery });
  assert.equal(searched.query.length <= 128, true);
  const unknown = reg.describe({ id: 'x'.repeat(300) });
  assert.ok(unknown.error.length < 300);
  assert.ok(unknown.error.includes('Unknown capability'));
});

test('registry search and describe echoes sanitize secrets and host paths', () => {
  const reg = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'echo_redact' });
  reg.register({ kind: 'tool', name: 'read', status: 'active', source: 'pi' });

  const searched = reg.search({
    query: 'api_key=live Bearer eyJhbGci token at /home/eddie/project',
  });
  assert.ok(!searched.query.includes('api_key=live'));
  assert.ok(!searched.query.includes('eyJhbGci'));
  assert.ok(!searched.query.includes('/home/eddie'));
  assert.match(searched.query, /\[REDACTED\]/);
  assert.match(searched.query, /\[redacted-path\]/);

  const unknown = reg.describe({
    id: 'Bearer sk-test postgres://user:pass@db/prod',
  });
  assert.ok(!unknown.error.includes('Bearer sk-test'));
  assert.ok(!unknown.error.includes('user:pass'));
  assert.match(unknown.error, /\[REDACTED\]/);

  const ambiguous = reg.describe({
    name: 'api_key=secret /opt/app/bin',
  });
  assert.ok(!ambiguous.error.includes('api_key=secret'));
  assert.ok(!ambiguous.error.includes('/opt/app'));
});

test('registry list/search/describe never expose owner partition fields', () => {
  const reg = createCapabilityRegistry({
    profileId: 'coding-agent',
    runId: 'run_private',
    ownerUserId: 'user_a',
    organizationId: 'org_a',
  });
  reg.register({ kind: 'tool', name: 'read', status: 'active', source: 'pi' });
  const listed = reg.list();
  const searched = reg.search({ query: 'read' });
  const described = reg.describe({ kind: 'tool', name: 'read' });
  for (const payload of [listed, searched, described]) {
    assert.equal(payload.owner_user_id, undefined);
    assert.equal(payload.organization_id, undefined);
  }
  const snap = reg.snapshot();
  assert.equal(snap.owner_user_id, 'user_a');
  assert.equal(snap.organization_id, 'org_a');
});

test('normalizeCapabilityEntry enforces canonical kind:name identity', () => {
  const entry = normalizeCapabilityEntry({
    kind: 'tool',
    name: 'read',
    id: 'skill:spoofed',
    status: 'active',
    source: 'pi-session',
  });
  assert.equal(entry.id, 'tool:read');
  assert.notEqual(entry.id, 'skill:spoofed');
});

test('source path and description redact absolute host paths', () => {
  const hostPath = '/Users/tester/project/skills/docx';
  const entry = normalizeCapabilityEntry({
    kind: 'skill',
    name: 'docx',
    status: 'active',
    source: hostPath,
    description: `Skill at ${hostPath}/SKILL.md keeps useful context`,
    metadata: {
      path: hostPath,
      reason: `missing ${hostPath}/SKILL.md`,
    },
  });
  assert.equal(entry.source, 'host-path-redacted');
  assert.equal(entry.metadata.path, undefined);
  assert.ok(!entry.description.includes('/Users/tester'));
  assert.match(entry.description, /\[redacted-path\].*useful context/);
  assert.ok(!entry.metadata.reason.includes('/Users/tester'));
  assert.match(entry.metadata.reason, /\[redacted-path\]/);

  const failedExt = normalizeCapabilityEntry({
    kind: 'extension',
    name: 'broken',
    status: 'failed',
    source: hostPath,
    metadata: { error: `ENOENT ${hostPath}/factory.js` },
  });
  assert.ok(!failedExt.metadata.error.includes('/Users/tester'));
  assert.match(failedExt.metadata.error, /\[redacted-path\]/);

  assert.equal(
    sanitizeCapabilityLocation('/var/folders/abc/T/skill-root', { field: 'source' }),
    'host-path-redacted',
  );
  assert.equal(
    sanitizeCapabilityLocation('/var/folders/abc/T/skill-root/SKILL.md', { field: 'path' }),
    undefined,
  );
  assert.equal(
    redactEmbeddedHostPaths('failed at C:\\Users\\secret\\skill'),
    'failed at [redacted-path]',
  );
});

test('sanitizeCapabilityLocation redacts secrets in known and relative source labels', () => {
  assert.equal(
    sanitizeCapabilityLocation('mcp:api_key=live-secret', { field: 'source' }),
    'mcp:api_key=[REDACTED]',
  );
  assert.equal(
    sanitizeCapabilityLocation('api_key=live-secret', { field: 'source' }),
    'api_key=[REDACTED]',
  );
  assert.equal(
    sanitizeCapabilityLocation('enterprise-agent-kit token=abc', { field: 'source' }),
    'enterprise-agent-kit token=[REDACTED]',
  );
  assert.equal(
    sanitizeCapabilityLocation('mcp-connection-manager', { field: 'source' }),
    'mcp-connection-manager',
  );
  assert.ok(
    !sanitizeCapabilityLocation('/home/sandbox/skill/docx', { field: 'path' }).includes(
      '[REDACTED]',
    ),
  );

  const entry = normalizeCapabilityEntry({
    kind: 'mcp_tool',
    name: 'lookup',
    status: 'active',
    source: 'mcp:api_key=live-secret',
    description: 'remote tool',
  });
  assert.equal(entry.source, 'mcp:api_key=[REDACTED]');
  assert.ok(!entry.source.includes('live-secret'));
});

test('seedConfiguredCapabilities respects profile MCP allowlist', () => {
  const profile = resolveAgentProfile();
  const seeded = seedConfiguredCapabilities(profile, {
    mcpServers: [
      { id: 'search', name: 'Search' },
      { id: 'not-allowed', name: 'X' },
    ],
  });
  assert.ok(seeded.mcp_servers.every((s) => s.name === 'search' || profile.allowedMcpServers.includes(s.name)));
  assert.equal(
    seeded.mcp_servers.some((s) => s.name === 'not-allowed'),
    false,
  );
});
