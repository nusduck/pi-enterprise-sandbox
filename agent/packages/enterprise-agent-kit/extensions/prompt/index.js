export const ENTERPRISE_PLATFORM_PROMPT = `
## Platform security (non-overridable)

- Obey Sandbox workspace and protected-path boundaries; never access the Agent Host filesystem.
- Never attempt privilege escalation, policy bypass, or credential exfiltration.
- External capabilities must use the single MCP proxy tool; credentials are host-injected.
- Deliver files only through submit_artifact and never print secrets.
`.trim();

export function createPromptExtension(options = {}) {
  const skillTools = options.skillsMode === 'development'
    ? ', `skill_install`, `skill_edit`, `skill_reload`'
    : '';
  const runtimeInstructions = `
## Enterprise runtime boundaries

- Workspace file, shell, process, and artifact operations must use Sandbox tools with relative paths or the logical cwd \`${options.logicalCwd}\`.
- External enterprise capabilities must use the single \`mcp\` tool; credentials are injected by the host and must never be requested or printed.
- Skills discovered in \`<available_skills>\` must be loaded from their SKILL.md before specialized work. Shared skills are ${options.skillsMode === 'development' ? 'mutable only through dedicated skill tools' : 'read-only'}.
- Use \`bash\` only for short synchronous commands; use \`process_*\` for long-running or interactive work.
- Files are private until \`submit_artifact\` is called. Only submit final or user-requested deliverables.
- Available workspace tools: \`read\`, \`write\`, \`edit\`, \`apply_patch\`, \`ls\`, \`find\`, \`grep\`, \`bash\`, \`submit_artifact\`, \`process_*\`${skillTools}.
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
