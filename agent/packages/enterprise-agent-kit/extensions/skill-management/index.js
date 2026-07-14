export function createSkillManagementExtension(options = {}) {
  const allowed = new Set(options.allowedTools || []);
  const tools = options.mode === 'development' ? (options.tools || []) : [];
  return function skillManagementExtension(pi) {
    for (const tool of tools) {
      if (allowed.has(tool.name)) pi.registerTool(tool);
    }
  };
}
