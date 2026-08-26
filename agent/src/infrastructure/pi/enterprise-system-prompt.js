/**
 * Enterprise system prompt — path/tool/skill contract as Pi customPrompt.
 * Avoids the SDK default that points at host / node_modules docs.
 *
 * Tool *schemas* (extension + MCP wrappers) are sent on the request; this
 * text must not pretend to be a closed catalog. Skills XML is appended later
 * by Pi formatSkillsForPrompt when loadedSkills is non-empty and `read` exists.
 */

import {
  LOGICAL_SKILL_ROOT,
  LOGICAL_WORKSPACE_ROOT,
  SANDBOX_TOOL_NAMES,
} from '../../extensions/sandbox-bridge/constants.js';

/** One-line tool snippets for the sandbox-bridge surface (plan §13). */
export const ENTERPRISE_TOOL_SNIPPETS = Object.freeze({
  read: 'Read workspace or skill files with offset/limit pagination',
  ls: 'List workspace, temporary or skill directories with bounded depth',
  find: 'Find workspace files by glob pattern',
  grep: 'Search workspace file contents',
  write: 'Write utf-8/base64 files under the sandbox workspace only',
  edit: 'Edit a workspace file with optimistic concurrency',
  bash: 'Run shell commands in the sandbox workspace',
  python: 'Execute Python in the sandbox (no host shell)',
  process_start: 'Start a long-running managed process',
  process_status: 'Poll managed process status',
  process_read: 'Read managed process stdout/stderr',
  process_kill: 'Signal a managed process',
  submit_artifact: 'Publish a durable deliverable artifact from workspace',
  ask_user: 'Request durable user input when the task cannot continue',
});

/**
 * @param {string[]} [toolNames]
 * @param {Record<string, string>} [snippets]
 */
export function formatEnterpriseToolsSection(
  toolNames = [...SANDBOX_TOOL_NAMES],
  snippets = ENTERPRISE_TOOL_SNIPPETS,
) {
  const lines = [];
  for (const name of toolNames) {
    const snip = snippets[name];
    if (snip) lines.push(`- ${name}: ${snip}`);
    else lines.push(`- ${name}`);
  }
  return lines.length ? lines.join('\n') : '(none)';
}

const IDENTITY = `You are a 风控通用智能体 (risk-control general agent). You work inside an isolated sandbox session. Investigate, analyze, and act on risk, compliance, policy, and operations tasks. Use tools for evidence; distinguish observed fact from inference.`;

/**
 * Build the enterprise base system prompt (customPrompt path in Pi buildSystemPrompt).
 * Skills XML is appended later by Pi when loadedSkills is non-empty and `read` exists.
 *
 * @param {{
 *   systemPrompt?: string | null,
 *   workspaceRoot?: string,
 *   skillRoot?: string,
 *   toolNames?: string[],
 *   toolSnippets?: Record<string, string>,
 *   extensionNames?: string[],
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

## Tools
The tools attached to this turn (name, description, parameters) are authoritative. Call any of them when they fit; this section is not a closed catalog.
- Files and commands: \`read\`, \`ls\`, \`find\`, \`grep\`, \`write\`, \`edit\`, \`bash\`, \`python\`, plus \`process_*\` and \`submit_artifact\` when present.
- If \`ask_user\` is present, use it when the task cannot continue without a choice or a missing fact.
- If \`skill_list\` / \`skill_install\` (and related) are present, use those for Skill catalog and lifecycle work — do not invent install APIs.
- If \`todo_write\` / \`memory_write\` (and related) are present, use them for durable plans and notes.
- External systems appear as \`mcp__<server>__<tool>\`. Call those directly; there is no separate MCP gateway tool for you.
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
- For risk work: say what you checked, what you did not, and how confident the conclusion is`;

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
 * 3. Else empty → full enterprise template only (avoids Pi default docs paths)
 *
 * Non-empty lead → author/product prompt + enterprise trailer.
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
