import { join } from 'node:path';

import {
  resolveAgentProfile,
  normalizeSharedSkillsPolicy,
  evaluateSkillPolicy,
} from './agent-profile-service.js';
import { validatePackageGovernance } from './package-governance-service.js';
import { buildRegistry } from '../services/model-registry.js';
import { listInstalledSkills } from '../skills/install.js';
import { validateSkillPackage } from '../skills/validator.js';
import {
  latestCapabilitySnapshots,
  snapshotEntriesByKind,
  statusToEnabled,
  toolCategory,
  sanitizeCapabilityLocation,
} from './capability-registry-service.js';
import { PACKAGE_SKILL_PATH } from '../packages/enterprise-agent-kit/extensions/dynamic-resources/index.js';

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
          filePath: metadata.skillMdPath,
          baseDir: join(root, packageName),
        });
      } catch {
        // Invalid packages are not loadable skills and must not be advertised.
      }
    }
  }
  return [...discovered.values()];
}

function indexByName(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    if (entry?.name) map.set(entry.name, entry);
  }
  return map;
}

function safeSkillPath(path) {
  return sanitizeCapabilityLocation(path, { field: 'path' }) || null;
}

function safeSkillSource(source) {
  return sanitizeCapabilityLocation(source, { field: 'source' }) || source || 'unknown';
}

/**
 * Build extension/capability diagnostics for operators.
 * Merges configured governance with the latest compatible live snapshot when present.
 *
 * @param {{
 *   profileId?: string,
 *   ownerUserId?: string|null,
 *   organizationId?: string|null,
 *   mcpServers?: object[],
 *   skillRoots?: string[],
 *   snapshot?: object|null,
 *   snapshotStore?: { getLatest: Function },
 *   packageSkillRoots?: string[],
 *   skillsMode?: string,
 * }} [options]
 */
const SKILL_MGMT_TOOLS = new Set(['skill_install', 'skill_edit', 'skill_reload']);

export function getExtensionDiagnostics(options = {}) {
  const profile = resolveAgentProfile(options.profileId || 'coding-agent');
  const packageInfo = validatePackageGovernance(profile);
  const configuredServers = options.mcpServers || [];
  const installedSkills = discoverSkills(options.skillRoots || []);
  const sharedPolicy = normalizeSharedSkillsPolicy(profile.sharedSkills);
  const packageSkillRoots = options.packageSkillRoots || [PACKAGE_SKILL_PATH];
  const skillsMode = options.skillsMode || 'readonly';
  const skillMgmtEffective = skillsMode === 'development';

  const store = options.snapshotStore || latestCapabilitySnapshots;
  const snapshotFilter = { profileId: profile.id };
  if (options.ownerUserId) snapshotFilter.ownerUserId = options.ownerUserId;
  if (options.organizationId) snapshotFilter.organizationId = options.organizationId;
  const liveSnapshot =
    options.snapshot !== undefined
      ? options.snapshot
      : store.getLatest(snapshotFilter);
  // Strict: only exact profile_id match (getLatest already enforces when filtered).
  const liveCompatible =
    liveSnapshot && liveSnapshot.profile_id === profile.id ? liveSnapshot : null;

  const liveSkills = indexByName(snapshotEntriesByKind(liveCompatible, 'skill'));
  const liveTools = indexByName(snapshotEntriesByKind(liveCompatible, 'tool'));
  const liveExtensions = indexByName(snapshotEntriesByKind(liveCompatible, 'extension'));
  const liveMcpServers = indexByName(snapshotEntriesByKind(liveCompatible, 'mcp_server'));
  const liveMcpTools = snapshotEntriesByKind(liveCompatible, 'mcp_tool');

  const skills = new Map();
  for (const skill of installedSkills) {
    const live = liveSkills.get(skill.name);
    const policy = evaluateSkillPolicy(profile, skill, { packageSkillRoots });
    let status;
    let reason;
    if (liveCompatible) {
      if (live) {
        status = live.status;
        reason = live.metadata?.reason;
      } else {
        // Present on disk but not in the live session inventory.
        status = 'disabled';
        reason = policy.enabled
          ? 'absent_from_live_snapshot'
          : policy.reason || 'profile_policy';
      }
    } else if (!policy.enabled) {
      status = 'disabled';
      reason = policy.reason || 'profile_policy';
    } else {
      status = 'configured';
    }
    skills.set(skill.name, {
      name: skill.name,
      description: skill.description,
      path: safeSkillPath(skill.path),
      source: safeSkillSource(skill.source),
      enabled: statusToEnabled(status),
      status,
      reason: reason || undefined,
      dynamic: live?.dynamic ?? true,
      registry_id: live?.id,
    });
  }
  for (const name of profile.skills) {
    if (!skills.has(name)) {
      const live = liveSkills.get(name);
      let status;
      let reason;
      if (live) {
        status = live.status;
      } else if (liveCompatible) {
        status = 'disabled';
        reason = 'absent_from_live_snapshot';
      } else {
        status = 'configured';
      }
      skills.set(name, {
        name,
        enabled: statusToEnabled(status),
        status,
        reason,
        source: packageInfo.package,
        dynamic: false,
        registry_id: live?.id,
      });
    }
  }
  // Live-only skills (e.g. after reload) not found on cold discovery.
  for (const [name, live] of liveSkills) {
    if (skills.has(name)) continue;
    skills.set(name, {
      name,
      description: live.description,
      source: live.source,
      enabled: statusToEnabled(live.status),
      status: live.status,
      dynamic: live.dynamic,
      path: live.metadata?.path || null,
      registry_id: live.id,
    });
  }

  const extensions = profile.extensions.map((name) => {
    const live = liveExtensions.get(name);
    const status = live?.status || (liveCompatible ? 'disabled' : 'configured');
    return {
      name,
      enabled: statusToEnabled(status),
      status,
      source: packageInfo.package,
      dynamic: live?.dynamic ?? false,
      registry_id: live?.id,
      reason: live?.metadata?.reason || live?.metadata?.error,
    };
  });

  const tools = profile.allowedTools.map((name) => {
    const live = liveTools.get(name);
    let status = live?.status || (liveCompatible ? 'disabled' : 'configured');
    let reason;
    if (
      !liveCompatible &&
      !skillMgmtEffective &&
      SKILL_MGMT_TOOLS.has(name)
    ) {
      status = 'disabled';
      reason = 'skills_mode_readonly';
    }
    return {
      name,
      enabled: statusToEnabled(status),
      status,
      reason,
      category: toolCategory(name),
      source: packageInfo.package,
      dynamic: live?.dynamic ?? false,
      description: live?.description,
      registry_id: live?.id,
    };
  });
  // Live tools not in static allowlist projection (e.g. injected mcp_*).
  for (const [name, live] of liveTools) {
    if (tools.some((t) => t.name === name)) continue;
    tools.push({
      name,
      enabled: statusToEnabled(live.status),
      status: live.status,
      category: toolCategory(name),
      source: live.source,
      dynamic: live.dynamic,
      description: live.description,
      registry_id: live.id,
    });
  }

  const mcp_servers = configuredServers
    .filter((server) => profile.allowedMcpServers.includes(server.id))
    .map((server) => {
      const live = liveMcpServers.get(server.id);
      const status =
        live?.status ||
        (server.enabled === false ? 'disabled' : liveCompatible ? 'disabled' : 'configured');
      return {
        server_id: server.id,
        name: server.name || server.id,
        enabled: server.enabled !== false && statusToEnabled(status),
        status,
        connection_status:
          live?.metadata?.connection_status ||
          (liveCompatible ? status : 'configured'),
        transport: server.transport || 'streamable-http',
        authorization: server.authTokenRef ? 'host-injected' : 'none',
        tool_count: live?.metadata?.tool_count,
        dynamic: live?.dynamic ?? false,
        registry_id: live?.id,
      };
    });

  return {
    status: 'ok',
    generated_at: new Date().toISOString(),
    view: liveCompatible ? 'live' : 'configured',
    registry: liveCompatible
      ? {
          live: true,
          registry_version: liveCompatible.registry_version,
          run_id: liveCompatible.run_id,
          conversation_id: liveCompatible.conversation_id,
          session_id: liveCompatible.session_id,
          profile_id: liveCompatible.profile_id,
          generated_at: liveCompatible.generated_at,
          counts: liveCompatible.counts,
          mcp_tools: liveMcpTools.map((t) => ({
            name: t.name,
            status: t.status,
            source: t.source,
            description: t.description,
            dynamic: t.dynamic,
            registered_name: t.metadata?.registered_name,
            server_id: t.metadata?.server_id,
            tool_key: t.metadata?.tool_key,
          })),
        }
      : {
          live: false,
          registry_version: null,
          note: 'No compatible live session snapshot; showing configured policy and filesystem discovery only.',
        },
    profile: {
      id: profile.id,
      version: profile.version,
      extensions: profile.extensions,
      allowed_tools: profile.allowedTools,
      allowed_mcp_servers: profile.allowedMcpServers,
      allowed_mcp_tools: profile.allowedMcpTools,
      skills: profile.skills,
      shared_skills: sharedPolicy,
      context_policy: profile.contextPolicy,
    },
    package: packageInfo,
    extensions,
    tools,
    skills: [...skills.values()],
    mcp_servers,
    models: [...buildRegistry().values()],
  };
}
