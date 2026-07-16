const PROFILE_VERSION = '2026-07-17.1';

const SHARED_SKILL_MODES = new Set(['all', 'allowlist', 'none']);

const CODING_AGENT_PROFILE = Object.freeze({
  id: 'coding-agent',
  version: PROFILE_VERSION,
  extensions: Object.freeze([
    'sandbox-tools',
    'policy',
    'dynamic-resources',
    'observability',
    'mcp',
    'task-plan',
    'interaction',
    'context-management',
    'prompt',
    'structured-output',
    'skill-management',
    'capability-introspection',
  ]),
  allowedTools: Object.freeze([
    'read',
    'write',
    'edit',
    'apply_patch',
    'ls',
    'find',
    'grep',
    'bash',
    'run_python',
    'run_node',
    'process_start',
    'process_status',
    'process_logs',
    'process_wait',
    'process_write_stdin',
    'process_signal',
    'process_cancel',
    'submit_artifact',
    'skill_install',
    'skill_edit',
    'skill_reload',
    'mcp',
    'capabilities',
    'task_plan',
    'ask_user',
    'context_compact',
    'structured_output',
  ]),
  allowedMcpServers: Object.freeze([
    'knowledge',
    'search',
    'risk-platform',
  ]),
  /** '*' = all tools on allowed servers; empty = deny-all (fail-closed). */
  allowedMcpTools: Object.freeze(['*']),
  /**
   * Package-bundled skill allowlist (enterprise-agent-kit/skills).
   * Shared mount skills are controlled separately via sharedSkills.
   */
  skills: Object.freeze([
    'repository-analysis',
    'code-review',
    'test-and-fix',
  ]),
  /**
   * Shared skill mount policy.
   * mode=all preserves today's coding-agent behavior (all packages under
   * /home/sandbox/skill are model-visible after discovery).
   */
  sharedSkills: Object.freeze({
    mode: 'all',
    names: Object.freeze([]),
  }),
  contextPolicy: Object.freeze({
    autoCompact: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    warningThreshold: 0.8,
  }),
});

const PROFILES = new Map([[CODING_AGENT_PROFILE.id, CODING_AGENT_PROFILE]]);

/**
 * Normalize and validate shared skill policy. Unknown modes fail closed to none.
 * @param {unknown} value
 * @param {{ mode?: string, names?: string[] }} [fallback]
 */
export function normalizeSharedSkillsPolicy(value, fallback = CODING_AGENT_PROFILE.sharedSkills) {
  const base = fallback || { mode: 'none', names: [] };
  if (value == null) {
    return {
      mode: SHARED_SKILL_MODES.has(base.mode) ? base.mode : 'none',
      names: [...(base.names || [])],
    };
  }
  if (typeof value === 'string') {
    const mode = value.trim().toLowerCase();
    if (!SHARED_SKILL_MODES.has(mode)) {
      throw new Error(
        `Invalid sharedSkills mode "${value}": expected all|allowlist|none`,
      );
    }
    return { mode, names: [] };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid sharedSkills: expected object or mode string');
  }
  const mode = String(value.mode || base.mode || 'none').trim().toLowerCase();
  if (!SHARED_SKILL_MODES.has(mode)) {
    throw new Error(
      `Invalid sharedSkills.mode "${value.mode}": expected all|allowlist|none`,
    );
  }
  const names = Array.isArray(value.names)
    ? value.names.map((n) => String(n).trim()).filter(Boolean)
    : [...(base.names || [])];
  if (mode === 'allowlist' && names.length === 0) {
    throw new Error('sharedSkills.mode=allowlist requires a non-empty names array');
  }
  return { mode, names };
}

/**
 * Decide whether a discovered skill package is enabled under profile policy.
 *
 * @param {object} profile
 * @param {{ name: string, filePath?: string, baseDir?: string, path?: string, source?: string }} skill
 * @param {{ packageSkillRoots?: string[] }} [options]
 * @returns {{ enabled: boolean, reason?: string, shared: boolean }}
 */
export function evaluateSkillPolicy(profile, skill, options = {}) {
  const name = String(skill?.name || '').trim();
  if (!name) return { enabled: false, reason: 'missing_name', shared: false };

  const packageRoots = (options.packageSkillRoots || []).map((p) =>
    String(p).replace(/\\/g, '/').replace(/\/+$/, ''),
  );
  const location = String(
    skill.filePath || skill.path || skill.baseDir || skill.source || '',
  )
    .replace(/\\/g, '/');

  const isPackage = packageRoots.some(
    (root) =>
      location === root ||
      location.startsWith(`${root}/`) ||
      location.includes('/enterprise-agent-kit/skills/') ||
      location.includes('/packages/enterprise-agent-kit/skills/'),
  );

  // Heuristic: known package skill names under kit when path missing.
  const packageNames = new Set(profile.skills || []);
  const treatAsPackage =
    isPackage ||
    (packageNames.has(name) &&
      !location.includes('/home/sandbox/skill') &&
      !location.includes('/sandbox/skills'));

  if (treatAsPackage) {
    if (packageNames.has(name)) {
      return { enabled: true, shared: false };
    }
    return {
      enabled: false,
      reason: 'package_skill_not_in_profile',
      shared: false,
    };
  }

  const shared = normalizeSharedSkillsPolicy(profile.sharedSkills);
  if (shared.mode === 'all') return { enabled: true, shared: true };
  if (shared.mode === 'none') {
    return { enabled: false, reason: 'shared_skills_none', shared: true };
  }
  // allowlist
  if (shared.names.includes(name)) return { enabled: true, shared: true };
  return {
    enabled: false,
    reason: 'shared_skill_not_in_allowlist',
    shared: true,
  };
}

/**
 * Filter discovered skills for model visibility / resource loader override.
 * @param {object} profile
 * @param {Array<{ name: string }>} skills
 * @param {{ packageSkillRoots?: string[] }} [options]
 */
export function filterProfileSkills(profile, skills, options = {}) {
  const list = Array.isArray(skills) ? skills : [];
  return list.filter((skill) => evaluateSkillPolicy(profile, skill, options).enabled);
}

/**
 * Prefer an explicitly provided array (including empty) over the base default.
 * Only fall back when the override is undefined/null (not when []).
 * @template T
 * @param {T[]|undefined|null} value
 * @param {T[]} base
 * @returns {T[]}
 */
export function pickProfileArray(value, base) {
  return Array.isArray(value) ? value : base;
}

function configuredProfile(profileId, env = process.env) {
  const raw = env.AGENT_PROFILES_JSON;
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid AGENT_PROFILES_JSON: ${error.message}`);
  }
  const profiles = Array.isArray(parsed)
    ? parsed
    : Object.entries(parsed || {}).map(([id, profile]) => ({ id, ...profile }));
  const value = profiles.find((profile) => profile?.id === profileId);
  if (!value) return null;
  const base = PROFILES.get(profileId) || CODING_AGENT_PROFILE;
  return {
    ...base,
    ...value,
    id: profileId,
    extensions: pickProfileArray(value.extensions, base.extensions),
    allowedTools: pickProfileArray(value.allowedTools, base.allowedTools),
    allowedMcpServers: pickProfileArray(value.allowedMcpServers, base.allowedMcpServers),
    allowedMcpTools: pickProfileArray(value.allowedMcpTools, base.allowedMcpTools),
    skills: pickProfileArray(value.skills, base.skills),
    sharedSkills: normalizeSharedSkillsPolicy(
      value.sharedSkills !== undefined ? value.sharedSkills : base.sharedSkills,
      base.sharedSkills,
    ),
    contextPolicy: { ...base.contextPolicy, ...(value.contextPolicy || {}) },
  };
}

function copyProfile(profile) {
  const sharedSkills = normalizeSharedSkillsPolicy(profile.sharedSkills);
  return {
    ...profile,
    extensions: [...profile.extensions],
    allowedTools: [...profile.allowedTools],
    allowedMcpServers: [...profile.allowedMcpServers],
    allowedMcpTools: [...profile.allowedMcpTools],
    skills: [...profile.skills],
    sharedSkills: {
      mode: sharedSkills.mode,
      names: [...sharedSkills.names],
    },
    contextPolicy: { ...profile.contextPolicy },
  };
}

export function resolveAgentProfile(profileId = 'coding-agent', env = process.env) {
  const profile = configuredProfile(profileId, env) || PROFILES.get(profileId);
  if (!profile) {
    throw new Error(`Unknown agent profile: ${profileId}`);
  }
  return copyProfile(profile);
}

export function filterProfileTools(profile, availableNames, options = {}) {
  const available = new Set(availableNames || []);
  const development = options.skillsMode === 'development';
  return profile.allowedTools.filter((name) => {
    if (name.startsWith('skill_') && !development) return false;
    return available.has(name);
  });
}

/**
 * Seed configured (not yet proven active) capability entries from a profile.
 * @param {object} profile
 * @param {{ mcpServers?: Array<{ id: string, name?: string, enabled?: boolean, transport?: string, authTokenRef?: string }> }} [options]
 */
export function seedConfiguredCapabilities(profile, options = {}) {
  const profileId = profile.id;
  const extensions = (profile.extensions || []).map((name) => ({
    kind: 'extension',
    name,
    status: 'configured',
    source: 'agent-profile',
    description: `Extension ${name} selected by profile ${profileId}`,
    dynamic: false,
    metadata: {},
    profile_id: profileId,
    scope: 'profile',
  }));

  const tools = (profile.allowedTools || []).map((name) => ({
    kind: 'tool',
    name,
    status: 'configured',
    source: 'agent-profile',
    description: `Tool ${name} allowed by profile ${profileId}`,
    dynamic: false,
    metadata: {},
    profile_id: profileId,
    scope: 'profile',
  }));

  const packageSkills = (profile.skills || []).map((name) => ({
    kind: 'skill',
    name,
    status: 'configured',
    source: 'agent-profile/package',
    description: `Package skill ${name} allowed by profile`,
    dynamic: false,
    metadata: { package_name: name, shared: false },
    profile_id: profileId,
    scope: 'profile',
  }));

  const shared = normalizeSharedSkillsPolicy(profile.sharedSkills);
  const sharedSkills =
    shared.mode === 'allowlist'
      ? shared.names.map((name) => ({
          kind: 'skill',
          name,
          status: 'configured',
          source: 'agent-profile/shared',
          description: `Shared skill ${name} allowlisted by profile`,
          dynamic: false,
          metadata: { package_name: name, shared: true },
          profile_id: profileId,
          scope: 'profile',
        }))
      : [];

  const mcpServers = (options.mcpServers || [])
    .filter((server) => profile.allowedMcpServers?.includes(server.id))
    .map((server) => ({
      kind: 'mcp_server',
      name: server.id,
      status: server.enabled === false ? 'disabled' : 'configured',
      source: 'agent-profile/mcp',
      description: server.name || server.id,
      dynamic: false,
      metadata: {
        server_id: server.id,
        transport: server.transport || 'streamable-http',
        authorization: server.authTokenRef ? 'host-injected' : 'none',
        connection_status: 'configured',
      },
      profile_id: profileId,
      scope: 'profile',
    }));

  return {
    extensions,
    tools,
    skills: [...packageSkills, ...sharedSkills],
    mcp_servers: mcpServers,
    sharedSkillsPolicy: shared,
  };
}

export { CODING_AGENT_PROFILE, PROFILE_VERSION, SHARED_SKILL_MODES };
