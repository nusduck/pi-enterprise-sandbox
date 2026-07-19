/**
 * Tool risk classifier (plan §14.2).
 */

import { SANDBOX_TOOL_NAMES } from '../sandbox-bridge/constants.js';
import { isValidMcpToolName } from '../../infrastructure/mcp/mcp-config-loader.js';

const LOCAL_SET = new Set(SANDBOX_TOOL_NAMES);

/**
 * @typedef {'local_low' | 'external_readonly' | 'external_high' | 'internal_interaction' | 'unknown'} ToolRiskClass
 */

/**
 * @param {string} toolName
 * @param {{
 *   mcpReadOnlyTools?: Iterable<string>,
 *   mcpServerPolicies?: Record<string, { default?: string, readOnly?: boolean }>,
 * }} [opts]
 * @returns {{ class: ToolRiskClass, serverId?: string, tool?: string }}
 */
export function classifyTool(toolName, opts = {}) {
  const name = String(toolName || '');
  if (name === 'ask_user') {
    return { class: 'internal_interaction' };
  }
  if (LOCAL_SET.has(name)) {
    return { class: 'local_low' };
  }

  if (isValidMcpToolName(name) || name.startsWith('mcp__')) {
    const m = /^mcp__([A-Za-z0-9._-]+)__([A-Za-z0-9._-]+)$/.exec(name);
    if (!m) {
      return { class: 'unknown' };
    }
    const serverId = m[1];
    const tool = m[2];
    const full = name;
    const readOnlySet = new Set(
      opts.mcpReadOnlyTools ? [...opts.mcpReadOnlyTools].map(String) : [],
    );
    const serverPol =
      opts.mcpServerPolicies && typeof opts.mcpServerPolicies === 'object'
        ? opts.mcpServerPolicies[serverId]
        : null;

    const markedReadOnly =
      readOnlySet.has(full) ||
      readOnlySet.has(tool) ||
      serverPol?.readOnly === true ||
      (serverPol?.default === 'allow' && serverPol?.readOnly !== false &&
        // Only treat as readonly when explicitly listed in readOnlyTools
        // or serverPolicy.readOnly === true. default allow alone is not enough
        // for high-side-effect tools — check explicit allowlist of readonly.
        false);

    // Explicit readOnly flags only
    if (
      readOnlySet.has(full) ||
      readOnlySet.has(`${serverId}::${tool}`) ||
      serverPol?.readOnly === true
    ) {
      return { class: 'external_readonly', serverId, tool };
    }

    void markedReadOnly;
    return { class: 'external_high', serverId, tool };
  }

  return { class: 'unknown' };
}

export function isLocalSandboxTool(toolName) {
  return LOCAL_SET.has(String(toolName || ''));
}
