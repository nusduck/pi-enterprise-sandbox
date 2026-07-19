/**
 * Operator-facing capability projection for the production three-extension
 * runtime. This is configured inventory, not a second runtime authority.
 */

import path from 'node:path';

import { listInstalledSkills } from '../../skills/install.js';
import { validateSkillPackage } from '../../skills/validator.js';
import { buildRegistry } from '../../services/model-registry.js';
import {
  ENTERPRISE_DEFAULT_TOOLS,
  ENTERPRISE_EXTENSION_NAMES,
} from '../extensions/index.js';
import { loadMcpServerRegistry } from '../infrastructure/mcp/pi-mcp-adapter-factory.js';

const PRODUCT_PACKAGE = 'pi-enterprise-agent';
const PRODUCT_VERSION = '4.0.0';
const DEFAULT_PROFILE_ID = 'coding-agent';

function toolCategory(name) {
  if (['read', 'write', 'edit'].includes(name)) return 'file';
  if (name.startsWith('process_')) return 'process';
  if (name === 'submit_artifact') return 'artifact';
  return 'execution';
}

function discoverSkills(skillRoots) {
  const discovered = new Map();
  for (const root of skillRoots || []) {
    let names = [];
    try {
      names = listInstalledSkills(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (discovered.has(name)) continue;
      try {
        const metadata = validateSkillPackage(path.join(root, name));
        discovered.set(name, {
          name: metadata.name,
          description: metadata.description,
          enabled: true,
          status: 'configured',
          source: 'shared-skill-root',
          path: null,
          dynamic: true,
        });
      } catch {
        // Invalid packages are not executable and must not be advertised.
      }
    }
  }
  return [...discovered.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function projectMcpServers(rawServers) {
  const registry = loadMcpServerRegistry(rawServers || []);
  return [...registry.values()]
    .map((server) => {
      const enabled = server.enabled !== false;
      const hasCredentialReference = Boolean(
        server.authTokenRef ||
          Object.keys(server.envRefs || {}).length > 0 ||
          Object.keys(server.headerRefs || {}).length > 0,
      );
      return {
        server_id: server.serverId,
        id: server.serverId,
        name: server.serverId,
        enabled,
        status: enabled ? 'configured' : 'disabled',
        connection_status: enabled ? 'configured' : 'disabled',
        transport: server.command ? 'stdio' : 'streamable-http',
        authorization: hasCredentialReference ? 'host-injected' : 'none',
        tool_count: null,
        dynamic: false,
      };
    })
    .sort((a, b) => a.server_id.localeCompare(b.server_id));
}

/**
 * Preserve the existing capabilities UI response contract while projecting
 * only current production configuration. Per-Run live truth remains in the
 * immutable AgentVersion, Pi runtime, and durable tool ledger.
 *
 * @param {{
 *   profileId?: string,
 *   skillRoots?: string[],
 *   mcpServers?: object[] | string,
 *   models?: Iterable<object>,
 *   now?: () => Date,
 * }} [options]
 */
export function getExtensionDiagnostics(options = {}) {
  const profileId = String(
    options.profileId || DEFAULT_PROFILE_ID,
  ).trim();
  if (profileId !== DEFAULT_PROFILE_ID) {
    throw new Error(`Unknown diagnostics profile: ${profileId}`);
  }

  const skills = discoverSkills(options.skillRoots || []);
  const mcpServers = projectMcpServers(options.mcpServers || []);
  const models = options.models
    ? [...options.models]
    : [...buildRegistry().values()];
  const tools = ENTERPRISE_DEFAULT_TOOLS.map((name) => ({
    name,
    enabled: true,
    status: 'configured',
    category: toolCategory(name),
    source: 'sandbox-bridge',
    risk_level: 'low',
    approval_policy: 'external-side-effects-only',
    dynamic: false,
  }));
  const extensions = ENTERPRISE_EXTENSION_NAMES.map((name) => ({
    name,
    enabled: true,
    status: 'configured',
    source: 'agent/src/extensions',
    dynamic: false,
  }));

  return {
    status: 'ok',
    generated_at: (options.now || (() => new Date()))().toISOString(),
    view: 'configured',
    registry: {
      live: false,
      registry_version: null,
      run_id: null,
      conversation_id: null,
      session_id: null,
      profile_id: profileId,
      note:
        'Configured platform inventory. Per-Run live authority is the immutable AgentVersion and durable runtime ledger.',
      mcp_tools: [],
    },
    profile: {
      id: profileId,
      version: PRODUCT_VERSION,
      extensions: [...ENTERPRISE_EXTENSION_NAMES],
      allowed_tools: [...ENTERPRISE_DEFAULT_TOOLS],
      allowed_mcp_servers: mcpServers
        .filter((server) => server.enabled)
        .map((server) => server.server_id),
      allowed_mcp_tools: [],
      skills: skills.map((skill) => skill.name),
      shared_skills: { mode: 'all', names: [] },
      context_policy: { authority: 'agent-version' },
    },
    package: {
      package: PRODUCT_PACKAGE,
      version: PRODUCT_VERSION,
      profile_id: profileId,
      extensions: [...ENTERPRISE_EXTENSION_NAMES],
      audit: { status: 'built-in' },
    },
    extensions,
    tools,
    skills,
    mcp_servers: mcpServers,
    models,
  };
}

