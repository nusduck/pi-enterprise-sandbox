/**
 * Skill reload -> session reload -> onAfterReload registry reconciliation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCapabilityRegistry, publishCapabilitySnapshot } from '../application/capability-registry-service.js';
import { reconcileResourceLoaderSkills } from '../application/capability-registry-service.js';
import { createSkillManager, SKILLS_MODE } from '../skills/manager.js';

test('skill manager reload invokes session reload and onAfterReload registry hook', async () => {
  let sessionReloaded = false;
  let hookCalled = false;
  const registry = createCapabilityRegistry({ profileId: 'coding-agent', runId: 'reload_run' });
  const resourceLoader = {
    skillsBefore: [{ name: 'alpha', description: 'a', filePath: '/home/sandbox/skill/alpha/SKILL.md' }],
    skillsAfter: [{ name: 'beta', description: 'b', filePath: '/home/sandbox/skill/beta/SKILL.md' }],
    getSkills() {
      return { skills: sessionReloaded ? this.skillsAfter : this.skillsBefore };
    },
    async reload() {
      sessionReloaded = true;
    },
  };
  const session = {
    resourceLoader,
    async reload() {
      await resourceLoader.reload();
    },
  };

  const manager = createSkillManager({
    mode: SKILLS_MODE.READONLY,
    skillRoots: ['/tmp/skills-reload-test'],
    getAgentSession: () => session,
    onAfterReload: async () => {
      hookCalled = true;
      reconcileResourceLoaderSkills(registry, resourceLoader, {
        profileId: 'coding-agent',
      });
      publishCapabilitySnapshot(registry, { reason: 'skill_reload' });
    },
  });

  const result = await manager.reload();
  assert.equal(sessionReloaded, true);
  assert.equal(hookCalled, true);
  assert.match(result.summary, /reloaded loader skills=1/);
  assert.equal(registry.list({ kind: 'skill' }).items[0]?.name, 'beta');
});