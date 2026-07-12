/**
 * Unified Tool Registry (agent-side) — ADR 0002 §4.6.
 *
 * Categories:
 *   sandbox | process | skill | mcp | artifact | enterprise_http
 *
 * Builds the createAgentSession allowlist + custom tool list from category
 * buckets so MCP / skill / enterprise tools can be toggled without scattering
 * name lists across chat-runner.
 */

export const TOOL_REGISTRY_VERSION = '2026-07-12.b5';

export const TOOL_CATEGORY = Object.freeze({
  SANDBOX: 'sandbox',
  PROCESS: 'process',
  SKILL: 'skill',
  MCP: 'mcp',
  ARTIFACT: 'artifact',
  ENTERPRISE_HTTP: 'enterprise_http',
});

/** Static catalog of built-in tool names by category. */
export const BUILTIN_TOOLS = Object.freeze({
  [TOOL_CATEGORY.SANDBOX]: Object.freeze([
    'read',
    'write',
    'edit',
    'apply_patch',
    'bash',
    'ls',
    'find',
    'grep',
  ]),
  [TOOL_CATEGORY.PROCESS]: Object.freeze([
    'process_start',
    'process_status',
    'process_logs',
    'process_wait',
    'process_write_stdin',
    'process_signal',
    'process_cancel',
  ]),
  [TOOL_CATEGORY.SKILL]: Object.freeze([
    'skill_install',
    'skill_edit',
    'skill_reload',
  ]),
  [TOOL_CATEGORY.ARTIFACT]: Object.freeze(['submit_artifact']),
  [TOOL_CATEGORY.MCP]: Object.freeze([]),
  [TOOL_CATEGORY.ENTERPRISE_HTTP]: Object.freeze([]),
});

/**
 * @typedef {object} RegistryTool
 * @property {string} name
 * @property {string} category
 * @property {string} [description]
 * @property {object} [parameters]
 * @property {Function} [execute]
 * @property {object} [meta]
 */

/**
 * Create an empty registry and populate with built-in name stubs.
 * Call `register` / `registerMany` to attach full tool definitions.
 */
export function createToolRegistry(options = {}) {
  /** @type {Map<string, RegistryTool>} */
  const byName = new Map();
  /** @type {Map<string, Set<string>>} */
  const byCategory = new Map(
    Object.values(TOOL_CATEGORY).map((c) => [c, new Set()]),
  );

  function ensureCategory(cat) {
    if (!byCategory.has(cat)) byCategory.set(cat, new Set());
    return byCategory.get(cat);
  }

  // Seed static names (no execute yet — chat-runner merges full defs)
  if (options.seedBuiltins !== false) {
    for (const [cat, names] of Object.entries(BUILTIN_TOOLS)) {
      for (const name of names) {
        byName.set(name, { name, category: cat });
        ensureCategory(cat).add(name);
      }
    }
  }

  return {
    version: TOOL_REGISTRY_VERSION,

    /**
     * @param {RegistryTool} tool
     */
    register(tool) {
      if (!tool || !tool.name) {
        throw new Error('tool.name is required');
      }
      const category = tool.category || TOOL_CATEGORY.SANDBOX;
      byName.set(tool.name, { ...tool, category });
      ensureCategory(category).add(tool.name);
      return tool;
    },

    /**
     * @param {RegistryTool[]} tools
     * @param {string} [category]
     */
    registerMany(tools, category) {
      for (const t of tools || []) {
        this.register(category ? { ...t, category } : t);
      }
    },

    unregister(name) {
      const existing = byName.get(name);
      if (!existing) return false;
      byName.delete(name);
      const set = byCategory.get(existing.category);
      if (set) set.delete(name);
      return true;
    },

    unregisterCategory(category) {
      const set = byCategory.get(category);
      if (!set) return 0;
      let n = 0;
      for (const name of [...set]) {
        byName.delete(name);
        set.delete(name);
        n += 1;
      }
      return n;
    },

    get(name) {
      return byName.get(name) || null;
    },

    has(name) {
      return byName.has(name);
    },

    /**
     * @param {{ category?: string, withExecute?: boolean }} [opts]
     * @returns {RegistryTool[]}
     */
    list(opts = {}) {
      const out = [];
      for (const tool of byName.values()) {
        if (opts.category && tool.category !== opts.category) continue;
        if (opts.withExecute && typeof tool.execute !== 'function') continue;
        out.push(tool);
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    },

    /**
     * Names for createAgentSession tools allowlist.
     * @param {{
     *   includeSkill?: boolean,
     *   includeMcp?: boolean,
     *   includeEnterpriseHttp?: boolean,
     * }} [opts]
     */
    allowlist(opts = {}) {
      const includeSkill = opts.includeSkill !== false;
      const includeMcp = opts.includeMcp !== false;
      const includeEnterpriseHttp = opts.includeEnterpriseHttp !== false;
      const names = [];
      for (const tool of byName.values()) {
        if (tool.category === TOOL_CATEGORY.SKILL && !includeSkill) continue;
        if (tool.category === TOOL_CATEGORY.MCP && !includeMcp) continue;
        if (
          tool.category === TOOL_CATEGORY.ENTERPRISE_HTTP &&
          !includeEnterpriseHttp
        ) {
          continue;
        }
        names.push(tool.name);
      }
      return names;
    },

    /**
     * Full custom tool objects that have execute handlers.
     */
    customTools() {
      return this.list({ withExecute: true });
    },

    tree() {
      /** @type {Record<string, string[]>} */
      const out = {};
      for (const [cat, set] of byCategory.entries()) {
        out[cat] = [...set].sort();
      }
      return out;
    },
  };
}

/**
 * Classify a built-in tool name into a registry category.
 * @param {string} name
 */
export function categoryForBuiltin(name) {
  for (const [cat, names] of Object.entries(BUILTIN_TOOLS)) {
    if (names.includes(name)) return cat;
  }
  if (name && name.startsWith('mcp_')) return TOOL_CATEGORY.MCP;
  if (name && name.startsWith('http_')) return TOOL_CATEGORY.ENTERPRISE_HTTP;
  return TOOL_CATEGORY.SANDBOX;
}
