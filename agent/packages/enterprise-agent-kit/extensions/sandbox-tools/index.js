import { createSandboxTools } from './tool-definitions.js';

/** Register remote Sandbox-backed tools with Pi's Extension runtime. */
export function createSandboxToolsExtension(options = {}) {
  const allowed = new Set(options.allowedTools || []);
  const definitions = options.tools || createSandboxTools(options.toolOptions || {});
  const tools = definitions.filter(
    (tool) => tool?.name && allowed.has(tool.name),
  );

  return function sandboxToolsExtension(pi) {
    for (const tool of tools) {
      pi.registerTool(tool);
    }
  };
}
