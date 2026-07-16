const PROFILE_VERSION = '2026-07-14.1';

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
  allowedMcpTools: Object.freeze([]),
  skills: Object.freeze([
    'repository-analysis',
    'code-review',
    'test-and-fix',
  ]),
  contextPolicy: Object.freeze({
    autoCompact: true,
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    warningThreshold: 0.8,
  }),
});

const PROFILES = new Map([[CODING_AGENT_PROFILE.id, CODING_AGENT_PROFILE]]);

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
    extensions: value.extensions || base.extensions,
    allowedTools: value.allowedTools || base.allowedTools,
    allowedMcpServers: value.allowedMcpServers || base.allowedMcpServers,
    allowedMcpTools: value.allowedMcpTools || base.allowedMcpTools,
    skills: value.skills || base.skills,
    contextPolicy: { ...base.contextPolicy, ...(value.contextPolicy || {}) },
  };
}

function copyProfile(profile) {
  return {
    ...profile,
    extensions: [...profile.extensions],
    allowedTools: [...profile.allowedTools],
    allowedMcpServers: [...profile.allowedMcpServers],
    allowedMcpTools: [...profile.allowedMcpTools],
    skills: [...profile.skills],
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

export { CODING_AGENT_PROFILE, PROFILE_VERSION };
