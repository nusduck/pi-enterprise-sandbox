import {
  DefaultResourceLoader,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';

import { validatePackageGovernance } from '../application/package-governance-service.js';
import {
  evaluateSkillPolicy,
  filterProfileSkills,
} from '../application/agent-profile-service.js';
import { createEnterpriseAgentKit } from '../packages/enterprise-agent-kit/index.js';
import { PACKAGE_SKILL_PATH } from '../packages/enterprise-agent-kit/extensions/dynamic-resources/index.js';

/** Validate the immutable package and Extension allowlist selected by a profile. */
export function inspectExtensionPackage(profile) {
  return validatePackageGovernance(profile);
}

/**
 * Create a skillsOverride that applies Agent Profile package + shared skill policy
 * after filesystem discovery (individual packages, not whole roots).
 *
 * @param {object} profile
 * @param {{ packageSkillRoots?: string[] }} [options]
 */
export function createProfileSkillsOverride(profile, options = {}) {
  const packageSkillRoots = options.packageSkillRoots || [PACKAGE_SKILL_PATH];
  return (current) => {
    const skills = Array.isArray(current?.skills) ? current.skills : [];
    const filtered = filterProfileSkills(profile, skills, { packageSkillRoots });
    const diagnostics = [...(current?.diagnostics || [])];
    for (const skill of skills) {
      const decision = evaluateSkillPolicy(profile, skill, { packageSkillRoots });
      if (!decision.enabled) {
        diagnostics.push({
          type: 'skill_filtered',
          name: skill.name,
          reason: decision.reason || 'profile_policy',
          shared: decision.shared,
        });
      }
    }
    return {
      skills: filtered,
      diagnostics,
    };
  };
}

/**
 * Create the Pi ResourceLoader for the internal enterprise package.
 * Package installation is deliberately absent: production images install from
 * the committed lockfile and runtime loading is allowlist-only.
 */
export async function createExtensionPackageLoader(options) {
  const diagnostics = options.diagnostics || inspectExtensionPackage(options.profile);
  const extensionFactories = createEnterpriseAgentKit({
    ...options.kitOptions,
    profile: options.profile,
  });
  const skillsOverride =
    options.skillsOverride ||
    (options.profile
      ? createProfileSkillsOverride(options.profile, {
          packageSkillRoots: options.packageSkillRoots || [PACKAGE_SKILL_PATH],
        })
      : undefined);
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir || getAgentDir(),
    settingsManager: options.settingsManager,
    extensionFactories,
    skillsOverride,
  });
  await resourceLoader.reload();
  return { diagnostics, extensionFactories, resourceLoader, skillsOverride };
}
