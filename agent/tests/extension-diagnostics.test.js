import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createCapabilityRegistry,
  createLatestCapabilitySnapshotStore,
  publishCapabilitySnapshot,
} from '../application/capability-registry-service.js';
import { getExtensionDiagnostics } from '../application/extension-diagnostics-service.js';

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

test('extension diagnostics includes valid packages from configured skill roots', () => {
  const diagnostics = getExtensionDiagnostics({
    skillRoots: [root],
    snapshot: null,
  });
  const skill = diagnostics.skills.find((item) => item.name === 'workspace-helper');
  assert.ok(skill);
  assert.equal(skill.description, 'Helps with workspace files.');
  // Physical temp roots must never appear verbatim in diagnostics exports.
  assert.equal(skill.source, 'host-path-redacted');
  assert.equal(skill.path, null);
  assert.equal(diagnostics.view, 'configured');
  assert.equal(diagnostics.registry.live, false);
  assert.equal(skill.status, 'configured');
  assert.ok(diagnostics.profile.shared_skills);
  assert.ok(diagnostics.extensions.every((item) => item.status === 'configured'));
});

function withAgentProfilesJson(value, fn) {
  const prev = process.env.AGENT_PROFILES_JSON;
  process.env.AGENT_PROFILES_JSON = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.AGENT_PROFILES_JSON;
    else process.env.AGENT_PROFILES_JSON = prev;
  }
}

test('cold diagnostics disables shared skills under none and allowlist policy', () => {
  withAgentProfilesJson(
    JSON.stringify({ 'coding-agent': { sharedSkills: { mode: 'none' } } }),
    () => {
      const diagnostics = getExtensionDiagnostics({ skillRoots: [root], snapshot: null });
      const skill = diagnostics.skills.find((item) => item.name === 'workspace-helper');
      assert.ok(skill);
      assert.equal(skill.status, 'disabled');
      assert.equal(skill.reason, 'shared_skills_none');
      assert.equal(diagnostics.view, 'configured');
    },
  );

  withAgentProfilesJson(
    JSON.stringify({
      'coding-agent': { sharedSkills: { mode: 'allowlist', names: ['other-skill'] } },
    }),
    () => {
      const diagnostics = getExtensionDiagnostics({ skillRoots: [root], snapshot: null });
      const skill = diagnostics.skills.find((item) => item.name === 'workspace-helper');
      assert.ok(skill);
      assert.equal(skill.status, 'disabled');
      assert.equal(skill.reason, 'shared_skill_not_in_allowlist');
    },
  );
});

test('live snapshot absence marks policy-allowed skills disabled', () => {
  const store = createLatestCapabilitySnapshotStore();
  const reg = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'live_absent' });
  publishCapabilitySnapshot(reg, { store, reason: 'empty-live' });

  const diagnostics = getExtensionDiagnostics({
    skillRoots: [root],
    snapshotStore: store,
  });
  const skill = diagnostics.skills.find((item) => item.name === 'workspace-helper');
  assert.equal(diagnostics.view, 'live');
  assert.ok(skill);
  assert.equal(skill.status, 'disabled');
  assert.equal(skill.reason, 'absent_from_live_snapshot');
});

test('readonly skillsMode marks skill management tools disabled in configured view', () => {
  const diagnostics = getExtensionDiagnostics({
    skillRoots: [],
    mcpServers: [],
    snapshot: null,
    skillsMode: 'readonly',
  });
  for (const name of ['skill_install', 'skill_edit', 'skill_reload']) {
    const tool = diagnostics.tools.find((item) => item.name === name);
    assert.ok(tool, name);
    assert.equal(tool.status, 'disabled');
    assert.equal(tool.reason, 'skills_mode_readonly');
  }
  assert.equal(diagnostics.view, 'configured');
});

test('development skillsMode leaves skill management tools configured when cold', () => {
  const diagnostics = getExtensionDiagnostics({
    skillRoots: [],
    mcpServers: [],
    snapshot: null,
    skillsMode: 'development',
  });
  for (const name of ['skill_install', 'skill_edit', 'skill_reload']) {
    const tool = diagnostics.tools.find((item) => item.name === name);
    assert.ok(tool, name);
    assert.equal(tool.status, 'configured');
  }
});

test('diagnostics owner filter prevents cross-user live snapshot bleed', () => {
  const store = createLatestCapabilitySnapshotStore({ maxSnapshots: 8 });
  const ownerA = createCapabilityRegistry({
    profileId: 'coding-agent',
    runId: 'run_owner_a',
    conversationId: 'conv_a',
    sessionId: 'sess_a',
    ownerUserId: 'user_a',
    organizationId: 'org_a',
  });
  ownerA.register({
    kind: 'tool',
    name: 'read',
    status: 'active',
    source: 'pi-session',
  });
  publishCapabilitySnapshot(ownerA, { store, reason: 'owner_a' });

  const ownerBView = getExtensionDiagnostics({
    skillRoots: [],
    mcpServers: [],
    snapshotStore: store,
    ownerUserId: 'user_b',
    organizationId: 'org_a',
  });
  assert.equal(ownerBView.view, 'configured');
  assert.equal(ownerBView.registry.live, false);
  assert.equal(ownerBView.registry.run_id, undefined);

  const ownerAView = getExtensionDiagnostics({
    skillRoots: [],
    mcpServers: [],
    snapshotStore: store,
    ownerUserId: 'user_a',
    organizationId: 'org_a',
  });
  assert.equal(ownerAView.view, 'live');
  assert.equal(ownerAView.registry.live, true);
  assert.equal(ownerAView.registry.run_id, 'run_owner_a');
  assert.equal(ownerAView.registry.conversation_id, 'conv_a');
  assert.equal(ownerAView.registry.session_id, 'sess_a');
  assert.equal(ownerAView.registry.owner_user_id, undefined);
});
