import { join } from 'node:path';

import { resolveAgentProfile } from './agent-profile-service.js';
import { validatePackageGovernance } from './package-governance-service.js';
import { buildRegistry } from '../services/model-registry.js';
import { listInstalledSkills } from '../skills/install.js';
import { validateSkillPackage } from '../skills/validator.js';

function toolCategory(name) {
  if (name === 'mcp') return 'mcp';
  if (name === 'task_plan' || name === 'ask_user' || name === 'context_compact') return 'workflow';
  if (name.startsWith('process_')) return 'process';
  if (name.startsWith('skill_')) return 'skill-management';
  if (name === 'submit_artifact') return 'artifact';
  return 'sandbox';
}

function discoverSkills(skillRoots = []) {
  const discovered = new Map();
  for (const root of skillRoots) {
    let packageNames = [];
    try {
      packageNames = listInstalledSkills(root);
    } catch {
      continue;
    }
    for (const packageName of packageNames) {
      if (discovered.has(packageName)) continue;
      try {
        const metadata = validateSkillPackage(join(root, packageName));
        discovered.set(packageName, {
          name: metadata.name,
          description: metadata.description,
          path: metadata.skillMdPath,
          source: root,
          enabled: true,
        });
      } catch {
        // Invalid packages are not loadable skills and must not be advertised.
      }
    }
  }
  return [...discovered.values()];
}

export function getExtensionDiagnostics(options = {}) {
  const profile = resolveAgentProfile(options.profileId || 'coding-agent');
  const packageInfo = validatePackageGovernance(profile);
  const configuredServers = options.mcpServers || [];
  const installedSkills = discoverSkills(options.skillRoots || []);
  const skills = new Map(installedSkills.map((skill) => [skill.name, skill]));
  for (const name of profile.skills) {
    if (!skills.has(name)) {
      skills.set(name, {
        name,
        enabled: true,
        source: packageInfo.package,
      });
    }
  }
  return {
    status: 'ok',
    generated_at: new Date().toISOString(),
    profile: {
      id: profile.id,
      version: profile.version,
      extensions: profile.extensions,
      allowed_tools: profile.allowedTools,
      allowed_mcp_servers: profile.allowedMcpServers,
      allowed_mcp_tools: profile.allowedMcpTools,
      skills: profile.skills,
      context_policy: profile.contextPolicy,
    },
    package: packageInfo,
    extensions: profile.extensions.map((name) => ({ name, enabled: true, source: packageInfo.package })),
    tools: profile.allowedTools.map((name) => ({
      name,
      enabled: true,
      category: toolCategory(name),
      source: packageInfo.package,
    })),
    skills: [...skills.values()],
    mcp_servers: configuredServers
      .filter((server) => profile.allowedMcpServers.includes(server.id))
      .map((server) => ({
        server_id: server.id,
        name: server.name || server.id,
        enabled: server.enabled !== false,
        connection_status: 'configured',
        transport: server.transport || 'streamable-http',
        authorization: server.authTokenRef ? 'host-injected' : 'none',
      })),
    models: [...buildRegistry().values()],
  };
}
