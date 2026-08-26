/**
 * Enterprise system prompt — identity + path/skill contract as Pi customPrompt.
 * Avoids the SDK default that points at host / node_modules docs.
 *
 * The tool *inventory* is deliberately not written here. Every tool this build
 * registers already declares `promptSnippet` / `promptGuidelines` on its
 * definition (sandbox-bridge, skill-lifecycle, subagent-spawn,
 * user-interaction, and the `mcp__server__tool` wrappers), and Pi aggregates
 * those for exactly the tools bound to a run. `renderToolSurface` turns that
 * aggregate into the `## Tools` body and `applyToolSurface` splices it in on
 * `before_agent_start`, so the section can never drift from the tool schemas
 * actually sent on the request.
 *
 * With no surface applied the prompt is still correct — it just says the tool
 * schemas are authoritative and leaves the inventory to them.
 *
 * Skills XML is appended later by Pi formatSkillsForPrompt when loadedSkills
 * is non-empty and `read` exists.
 */

import {
  LOGICAL_SKILL_ROOT,
  LOGICAL_WORKSPACE_ROOT,
} from '../../extensions/sandbox-bridge/constants.js';

/** Heading the live tool surface is spliced under. */
export const TOOL_SURFACE_HEADING = '## Tools';

const IDENTITY = `You are 风控通用智能体 — a general-purpose enterprise agent whose current deployment serves risk, compliance, and operations teams. You work inside an isolated sandbox session. The task in front of you decides the work; the deployment is context, not a limit on what you can be asked. Reply in the language the user writes in.`;

/**
 * Render the `## Tools` body from the options Pi assembled for this run.
 *
 * Input is Pi's `BuildSystemPromptOptions`: `selectedTools` is already
 * filtered to tools present in the registry, and `toolSnippets` /
 * `promptGuidelines` are aggregated from those tools' own definitions. Tool
 * order is preserved rather than sorted — it is stable for a given
 * AgentVersion, and a stable string keeps the provider's prefix cache warm.
 *
 * @param {{
 *   selectedTools?: string[],
 *   toolSnippets?: Record<string, string>,
 *   promptGuidelines?: string[],
 * }} [options]
 * @returns {string} Empty when no tool is bound (caller leaves the section as-is).
 */
export function renderToolSurface(options = {}) {
  const selected = Array.isArray(options?.selectedTools)
    ? options.selectedTools
    : [];
  const snippets =
    options?.toolSnippets && typeof options.toolSnippets === 'object'
      ? options.toolSnippets
      : {};
  const guidelines = Array.isArray(options?.promptGuidelines)
    ? options.promptGuidelines
    : [];

  const seenTools = new Set();
  const toolLines = [];
  for (const raw of selected) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || seenTools.has(name)) continue;
    seenTools.add(name);
    const snippet = typeof snippets[name] === 'string' ? snippets[name].trim() : '';
    toolLines.push(snippet ? `- \`${name}\`: ${snippet}` : `- \`${name}\``);
  }
  if (toolLines.length === 0) return '';

  const seenGuidelines = new Set();
  const guidelineLines = [];
  for (const raw of guidelines) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text || seenGuidelines.has(text)) continue;
    seenGuidelines.add(text);
    guidelineLines.push(`- ${text}`);
  }

  const blocks = [`Bound to this run:\n${toolLines.join('\n')}`];
  if (guidelineLines.length > 0) {
    blocks.push(`Tool usage rules:\n${guidelineLines.join('\n')}`);
  }
  return blocks.join('\n\n');
}

/**
 * Splice the rendered tool surface into an assembled system prompt.
 *
 * Insertion point is the `## Tools` heading, which `buildEnterpriseSystemPrompt`
 * always emits (the contract is appended even behind an AgentVersion lead).
 * Returns the prompt unchanged when there is no heading and when no tool is
 * bound, so a run without this splice still gets a truthful prompt.
 *
 * @param {string} systemPrompt Fully assembled prompt (Pi `_baseSystemPrompt`).
 * @param {Parameters<typeof renderToolSurface>[0]} [options]
 * @returns {string}
 */
export function applyToolSurface(systemPrompt, options = {}) {
  const prompt = typeof systemPrompt === 'string' ? systemPrompt : '';
  if (!prompt) return prompt;
  const surface = renderToolSurface(options);
  if (!surface) return prompt;
  const marker = `\n${TOOL_SURFACE_HEADING}\n`;
  const at = prompt.indexOf(marker);
  if (at === -1) return prompt;
  const insertAt = at + marker.length;
  // Pi always hands back the base prompt, so this is belt-and-braces: never
  // stack two inventories under one heading if something re-applies.
  if (prompt.startsWith(`${surface}\n\n`, insertAt)) return prompt;
  return `${prompt.slice(0, insertAt)}${surface}\n\n${prompt.slice(insertAt)}`;
}

/**
 * Build the enterprise base system prompt (customPrompt path in Pi buildSystemPrompt).
 * Skills XML is appended later by Pi when loadedSkills is non-empty and `read` exists.
 *
 * @param {{
 *   systemPrompt?: string | null,
 *   workspaceRoot?: string,
 *   skillRoot?: string,
 * }} [options]
 * @returns {string}
 */
export function buildEnterpriseSystemPrompt(options = {}) {
  const workspaceRoot = String(
    options.workspaceRoot || LOGICAL_WORKSPACE_ROOT,
  ).replace(/\\/g, '/');
  const skillRoot = String(options.skillRoot || LOGICAL_SKILL_ROOT).replace(
    /\\/g,
    '/',
  );
  const custom = String(options.systemPrompt || '').trim();

  const contract = `## Paths (hard rules)
- **User project / workspace**: \`${workspaceRoot}\` — read and write here. Relative paths resolve under this root.
- **Skills (read-only)**: \`${skillRoot}\` — installed skill packages (\`SKILL.md\` + assets). Never write here.
- Do **not** search or read host install trees such as \`/app\`, \`node_modules\`, or agent home. Those are not the user project and not skills.

${TOOL_SURFACE_HEADING}
Each bound tool's own schema is authoritative; call any of them when they fit.
- External systems appear as \`mcp__<server>__<tool>\`. Call those directly; there is no separate MCP gateway tool for you.
- Do not invent an API for a capability no bound tool provides — say it is unavailable instead.
- High-risk actions may wait on approval. Do not try to bypass policy.

## Skills (progressive disclosure)
When a skills section is present below (or under \`${skillRoot}\`):
1. Match the user task to a skill **name** / **description**.
2. Use the \`read\` tool on that skill's \`SKILL.md\` (\`location\` path or \`${skillRoot}/<name>/SKILL.md\`).
3. Follow the skill instructions; resolve relative paths against the skill directory.
4. Do not invent skill APIs — load the file first.

Skill directories are listable but not searchable: \`ls\` reaches them, \`find\` and \`grep\` cover the workspace and \`/tmp\` only. \`ls\` a skill's directory to see which reference files and scripts it ships beyond \`SKILL.md\`, then \`read\` the one you need. If no skills section is listed, none are installed.

## Finding things
- \`ls\` a directory before guessing paths; \`find\` locates files by name, \`grep\` by contents.
- Reach for those three rather than \`bash\` with ls/find/rg: they are budgeted, they run in parallel, and they tell you when a result was truncated.
- Read a file only once you know which one you want.

## Guidelines
- Be concise; show paths and evidence clearly
- Use tools for real filesystem, command, and external-system outcomes; do not invent output or data
- Prefer editing existing files over writing new ones when possible
- Say what you checked, what you did not, and how confident the conclusion is; separate observed fact from inference`;

  // AgentVersion / product lead owns voice when set; keep the path/tool contract.
  if (custom) return `${custom}\n\n---\n\n${contract}`;
  return `${IDENTITY}\n\n${contract}`;
}

/**
 * Decide the effective custom system prompt string for ResourceLoader.
 *
 * Lead voice precedence:
 * 1. Non-empty AgentVersion.systemPrompt
 * 2. Else product layer from env (`opts.productSystemPrompt` /
 *    AGENT_SYSTEM_PROMPT)
 * 3. Else empty → default identity + enterprise contract (avoids Pi default
 *    docs paths)
 *
 * A non-empty lead *replaces* the default identity sentence rather than
 * stacking with it, so two personas can never argue inside one prompt. Both
 * lead slots are therefore whole-persona slots: a lead that is only a partial
 * addendum ("always answer in 简体中文") silently drops the risk identity.
 * `.env.example` says so for the env layer.
 *
 * @param {string | null | undefined} agentVersionSystemPrompt
 * @param {Parameters<typeof buildEnterpriseSystemPrompt>[0] & {
 *   productSystemPrompt?: string | null,
 * }} [opts]
 */
export function resolveEnterpriseSystemPrompt(
  agentVersionSystemPrompt,
  opts = {},
) {
  const agentLead = String(agentVersionSystemPrompt || '').trim();
  const productLead = String(opts.productSystemPrompt || '').trim();
  return buildEnterpriseSystemPrompt({
    ...opts,
    systemPrompt: agentLead || productLead,
  });
}
