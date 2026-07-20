/**
 * Enterprise system prompt — mirrors pi-coding-agent buildSystemPrompt shape
 * (tools + guidelines + skills progressive disclosure + cwd/date) without
 * pointing the model at /app/node_modules pi product docs.
 *
 * Skills: name/description injected by Pi formatSkillsForPrompt when the
 * ResourceLoader has loaded skill paths (additionalSkillPaths → SKILLS_ROOT).
 * Full SKILL.md is loaded on demand via the `read` tool.
 */

import {
  LOGICAL_SKILL_ROOT,
  LOGICAL_WORKSPACE_ROOT,
  SANDBOX_TOOL_NAMES,
} from '../../extensions/sandbox-bridge/constants.js';
import { ENTERPRISE_EXTENSION_ORDER } from '../../extensions/constants.js';

/** One-line tool snippets for the default sandbox-bridge surface (plan §13). */
export const ENTERPRISE_TOOL_SNIPPETS = Object.freeze({
  read: 'Read workspace or skill files with offset/limit pagination',
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
  const toolNames = Array.isArray(options.toolNames)
    ? options.toolNames
    : [...SANDBOX_TOOL_NAMES];
  const snippets = options.toolSnippets || ENTERPRISE_TOOL_SNIPPETS;
  const extensionNames = Array.isArray(options.extensionNames)
    ? options.extensionNames
    : [...ENTERPRISE_EXTENSION_ORDER];

  const toolsList = formatEnterpriseToolsSection(toolNames, snippets);
  const extensionsList = extensionNames.map((n) => `- ${n}`).join('\n');

  const base = `You are **pi**, an enterprise coding assistant running inside a sandboxed session (pi-enterprise-sandbox).

## Paths (hard rules)
- **User project / workspace**: \`${workspaceRoot}\` — read and write here. Relative paths resolve under this root.
- **Skills (read-only)**: \`${skillRoot}\` — installed skill packages (\`SKILL.md\` + assets). Never write here.
- Do **not** search or read host install trees such as \`/app\`, \`node_modules\`, or agent home. Those are not the user project and not skills.

## Available tools
${toolsList}

Other tools (for example MCP) may appear depending on agent configuration. Prefer sandbox tools for file and command work.

## Runtime extensions (platform — not user packages)
These are already bound for this run; you do not install them:
${extensionsList}
- sandbox-bridge routes file/shell/python/process tools into the formal sandbox
- enterprise-policy enforces risk/approval/rate limits on tool calls
- observability records durable run/tool events for the UI

## Skills (progressive disclosure)
When a skills section is present below (or under \`${skillRoot}\`):
1. Match the user task to a skill **name** / **description**.
2. Use the \`read\` tool on that skill's \`SKILL.md\` (\`location\` path or \`${skillRoot}/<name>/SKILL.md\`).
3. Follow the skill instructions; resolve relative paths against the skill directory.
4. Do not invent skill APIs — load the file first.

If no skills section is listed, you may list \`${skillRoot}\` with tools only when the user asks about installed skills.

## Guidelines
- Be concise; show paths clearly when working with files
- Use tools for real filesystem and command outcomes; do not invent command output
- Prefer editing existing files over writing new ones when possible
- Ordinary bash does not require approval; high-risk actions may wait on policy`;

  if (!custom) return base;
  // AgentVersion.systemPrompt wins as the lead voice; keep enterprise path/tool contract.
  return `${custom}\n\n---\n\n${base}`;
}

/**
 * Decide the effective custom system prompt string for ResourceLoader.
 * Empty AgentVersion.systemPrompt → full enterprise template (avoids Pi default
 * docs paths under node_modules). Non-empty → author prompt + enterprise trailer.
 *
 * @param {string | null | undefined} agentVersionSystemPrompt
 * @param {Parameters<typeof buildEnterpriseSystemPrompt>[0]} [opts]
 */
export function resolveEnterpriseSystemPrompt(
  agentVersionSystemPrompt,
  opts = {},
) {
  return buildEnterpriseSystemPrompt({
    ...opts,
    systemPrompt: agentVersionSystemPrompt,
  });
}
