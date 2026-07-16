export const ENTERPRISE_PLATFORM_PROMPT = `
## Platform security (non-overridable)

- Obey Sandbox workspace and protected-path boundaries; never access the Agent Host filesystem.
- Never attempt privilege escalation, policy bypass, or credential exfiltration.
- Prefer injected first-class \`mcp_*\` tools when available; use the \`mcp\` meta-tool only for discovery, describe, or invoke fallback. Credentials are host-injected.
- Deliver files only through submit_artifact and never print secrets.
`.trim();

export function createPromptExtension(options = {}) {
  const skillTools = options.skillsMode === 'development'
    ? ', `skill_install`, `skill_edit`, `skill_reload`'
    : '';
  const runtimeInstructions = `
## Enterprise runtime boundaries

- Workspace file, shell, process, and artifact operations must use Sandbox tools with relative paths or the logical cwd \`${options.logicalCwd}\`.
- External MCP capabilities are injected at session start as first-class \`mcp_*\` tools when available; the meta \`mcp\` tool (search/describe/invoke) remains a fallback. Prefer injected tools. Credentials are host-injected — never request or print secrets.
- \`process_wait\` only accepts process_id from \`process_start\`. Never pass approval_id to process tools.
- Skills discovered in \`<available_skills>\` must be loaded from their SKILL.md before specialized work. Shared skills are ${options.skillsMode === 'development' ? 'mutable only through dedicated skill tools' : 'read-only'}.
- **Capability inventory is authoritative only via the \`capabilities\` tool** (\`action=list|search|describe\`). Inventory is paginated: when the user asks for all/every capability or a total count, call \`action=list\` and follow \`next_cursor\` until it is null before answering. When the user asks what skills, tools, extensions, or MCP capabilities are available, how many there are, or to list them all, you MUST call \`capabilities\` and answer from its result — do not invent or partial-recall from memory or from the compact \`<available_skills>\` hint.
- Use \`bash\` only for short synchronous commands; use \`process_*\` for long-running or interactive work.
- Files are private until \`submit_artifact\` is called. Only submit final or user-requested deliverables.
- Available workspace tools: \`read\`, \`write\`, \`edit\`, \`apply_patch\`, \`ls\`, \`find\`, \`grep\`, \`bash\`, \`submit_artifact\`, \`process_*\`, \`capabilities\`${skillTools}.
- Continue from restored multi-turn context and preserve task-plan evidence across compaction.
`.trim();

  return function enterprisePromptExtension(pi) {
    pi.on('before_agent_start', (_event, ctx) => {
      const current = ctx.getSystemPrompt?.() || '';
      const layers = [
        options.productPrompt,
        current,
        ENTERPRISE_PLATFORM_PROMPT,
        runtimeInstructions,
      ].filter(Boolean);
      return { systemPrompt: [...new Set(layers)].join('\n\n') };
    });
  };
}
