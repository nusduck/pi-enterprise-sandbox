/**
 * SkillManager.reload() must fail closed when the extension-load fail-closed
 * assertion trips after a skill install/uninstall-triggered session reload
 * (session.reload() / session.resourceLoader.reload() rebuild the extension
 * runtime in place, bypassing PiRuntimeFactory's own bind path).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSkillManager } from '../src/skills/manager.js';

function makeManager({ session, skillRoot }) {
  const auditEvents = [];
  const manager = createSkillManager({
    skillRoots: [skillRoot],
    getAgentSession: () => session,
    auditSink: (ev) => auditEvents.push(ev),
  });
  return { manager, auditEvents };
}

test('reload() reports success when extension load is clean', async () => {
  const session = {
    reload: async () => {},
    resourceLoader: {
      getExtensions: () => ({ extensions: [], errors: [] }),
      getSkills: () => ({ skills: [] }),
    },
  };
  const { manager, auditEvents } = makeManager({
    session,
    skillRoot: '/tmp/does-not-matter-skill-root',
  });

  const result = await manager.reload();
  assert.equal(result.reloaded, true);
  const last = auditEvents[auditEvents.length - 1];
  assert.equal(last.action, 'reload');
  assert.equal(last.result, 'success');
});

test('reload() fails closed (does not report success) when extension load errors after reload', async () => {
  const session = {
    reload: async () => {
      // Simulate the vendor SDK's in-place reload: settings + resource
      // loader are rebuilt, and the enterprise-policy extension factory
      // failed this time. The loader records the error but does not throw.
    },
    resourceLoader: {
      getExtensions: () => ({
        extensions: [],
        errors: [{ path: 'enterprise-policy', error: 'boom' }],
      }),
      getSkills: () => ({ skills: [] }),
    },
  };
  const { manager, auditEvents } = makeManager({
    session,
    skillRoot: '/tmp/does-not-matter-skill-root',
  });

  await assert.rejects(
    () => manager.reload(),
    /fail-closed|PI_EXTENSION_LOAD_FAILED/,
  );

  const last = auditEvents[auditEvents.length - 1];
  assert.equal(last.action, 'reload');
  assert.equal(last.result, 'failure');
  assert.match(last.error, /fail-closed|PI_EXTENSION_LOAD_FAILED/);
});
