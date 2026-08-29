/**
 * SkillManager.reload() must fail closed when the post-reload rebuild fails.
 *
 * Under Pi this guarded `session.reload()` rebuilding the extension runtime in
 * place: the resource loader recorded factory errors without throwing, so the
 * manager had to inspect `getExtensions().errors` itself. DSH composes plugins
 * once at boot and has no per-reload extension rescan, so that specific hole is
 * gone — but the invariant it protected is not. `onAfterReload` is now the only
 * rebuild that runs after a skill install/uninstall, and a reload that reports
 * success over a rebuild that failed is the same defect wearing new clothes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSkillManager } from '../src/skills/manager.js';

function makeManager({ session, skillRoot, onAfterReload }) {
  const auditEvents = [];
  const manager = createSkillManager({
    skillRoots: [skillRoot],
    getAgentSession: () => session,
    auditSink: (ev) => auditEvents.push(ev),
    ...(onAfterReload ? { onAfterReload } : {}),
  });
  return { manager, auditEvents };
}

const cleanSession = () => ({
  reload: async () => {},
  resourceLoader: { getSkills: () => ({ skills: [] }) },
});

test('reload() reports success when the reload and the rebuild are both clean', async () => {
  const { manager, auditEvents } = makeManager({
    session: cleanSession(),
    skillRoot: '/tmp/does-not-matter-skill-root',
  });

  const result = await manager.reload();
  assert.equal(result.reloaded, true);
  const last = auditEvents[auditEvents.length - 1];
  assert.equal(last.action, 'reload');
  assert.equal(last.result, 'success');
});

test('reload() fails closed when the post-reload rebuild throws', async () => {
  const { manager, auditEvents } = makeManager({
    session: cleanSession(),
    skillRoot: '/tmp/does-not-matter-skill-root',
    onAfterReload: async () => {
      throw new Error('skill projection rebuild failed');
    },
  });

  await assert.rejects(() => manager.reload(), /skill projection rebuild failed/);

  const last = auditEvents[auditEvents.length - 1];
  assert.equal(last.action, 'reload');
  assert.equal(last.result, 'failure');
  assert.match(last.error, /skill projection rebuild failed/);
});

test('reload() fails closed when the session reload itself throws', async () => {
  const { manager, auditEvents } = makeManager({
    session: {
      reload: async () => {
        throw new Error('session reload failed');
      },
      resourceLoader: { getSkills: () => ({ skills: [] }) },
    },
    skillRoot: '/tmp/does-not-matter-skill-root',
  });

  await assert.rejects(() => manager.reload(), /session reload failed/);
  assert.equal(auditEvents[auditEvents.length - 1].result, 'failure');
});
